// Read and validate a team package (a folder or a zip held in memory). Packages carry text only: scripts are rejected.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Cron } from 'croner';
import { parse } from 'yaml';
import { AGENT_ID_RE } from '../agents/schema.js';
import { RUNTIME_IDS, type RuntimeId } from '../core/types.js';
import {
  AGENT_YAML_TEMPLATE,
  TEAM_ENTRYPOINT,
  TEAM_SCHEDULES_FILE,
  TEAM_SCHEMAS,
  TeamError,
  type LoadedTeam,
  type TeamAgentDecl,
  type TeamFiles,
  type TeamInputDecl,
  type TeamManifest,
  type TeamScheduleDecl,
} from './types.js';

export const MAX_PACKAGE_FILES = 300;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_PACKAGE_BYTES = 5 * 1024 * 1024;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INPUT_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SKILL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const TEXT_EXT = new Set(['.md', '.yaml', '.yml', '.template', '.txt', '.json']);
const SEGMENT_RE = /^[A-Za-z0-9._ -]+$/;
export const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const asString = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string; has: boolean } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text, has: false };
  const parsed = parse(m[1]!);
  return { data: isRecord(parsed) ? parsed : {}, body: m[2] ?? '', has: true };
}

/** Reason a package-relative path is unacceptable, or null. */
export function badPackagePath(rel: string): string | null {
  if (!rel || rel.includes('\0') || rel.includes('\\')) return 'đường dẫn không hợp lệ';
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return 'đường dẫn tuyệt đối';
  const parts = rel.split('/');
  for (const seg of parts) {
    if (seg === '..' || seg === '.' || seg === '') return 'đường dẫn thoát khỏi gói';
    if (seg.startsWith('.')) return 'file ẩn';
    if (!SEGMENT_RE.test(seg)) return 'tên file có ký tự không cho phép';
  }
  const ext = path.posix.extname(rel).toLowerCase();
  if (!TEXT_EXT.has(ext)) return `chỉ nhận file văn bản, gặp "${ext || 'không có đuôi'}" (gói không được chứa script hay file thực thi)`;
  const top = parts[0]!;
  if (!(rel === TEAM_ENTRYPOINT || rel === TEAM_SCHEDULES_FILE || rel === 'README.md' || top === 'agents')) return 'nằm ngoài TEAM.md, schedules.yaml và agents/';
  if (top === 'agents' && parts.length < 3) return 'file nằm trực tiếp trong agents/';
  return null;
}

function validCron(expr: string, tz: string | null): boolean {
  try {
    new Cron(expr, { paused: true, timezone: tz ?? undefined }).stop();
    return true;
  } catch {
    return false;
  }
}

function readInputs(raw: unknown, errors: string[]): TeamInputDecl[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push('TEAM.md: inputs phải là danh sách.');
    return [];
  }
  const seen = new Set<string>();
  const out: TeamInputDecl[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const key = asString(item.key) ?? '';
    if (!INPUT_KEY_RE.test(key)) {
      errors.push(`TEAM.md: input key "${key}" phải viết HOA, dạng A-Z0-9_.`);
      continue;
    }
    if (seen.has(key)) {
      errors.push(`TEAM.md: input "${key}" bị khai báo hai lần.`);
      continue;
    }
    seen.add(key);
    // bot tokens belonged to a messenger runtime that AIOS-Lite does not have: treated as secrets, never stored.
    const kind = item.kind === 'secret' || item.kind === 'bot_token' ? 'secret' : 'plain';
    out.push({
      key,
      label: asString(item.label) ?? key,
      description: asString(item.description) ?? '',
      kind,
      required: item.required === true,
      defaultValue: typeof item.default === 'string' && kind === 'plain' ? item.default : '',
    });
  }
  return out;
}

function readSchedules(text: string | undefined, agentIds: string[], errors: string[]): TeamScheduleDecl[] {
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (e) {
    errors.push(`schedules.yaml: ${(e as Error).message.split('\n')[0]}`);
    return [];
  }
  const list = isRecord(parsed) ? parsed.schedules : parsed;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    errors.push('schedules.yaml: cần một danh sách `schedules`.');
    return [];
  }
  const out: TeamScheduleDecl[] = [];
  const ids = new Set<string>();
  list.forEach((item, i) => {
    const where = `schedules.yaml[${i}]`;
    if (!isRecord(item)) {
      errors.push(`${where}: phải là object.`);
      return;
    }
    const id = asString(item.id) ?? `schedule-${i + 1}`;
    if (!SLUG_RE.test(id)) errors.push(`${where}: id "${id}" phải là slug chữ thường.`);
    if (ids.has(id)) errors.push(`${where}: id "${id}" bị trùng.`);
    ids.add(id);
    const agent = asString(item.agent) ?? '';
    if (!agentIds.includes(agent)) errors.push(`${where}: agent "${agent}" không có trong gói.`);
    const cron = asString(item.cron) ?? '';
    const tz = asString(item.tz);
    if (!validCron(cron, tz)) errors.push(`${where}: cron "${cron}" hoặc múi giờ không hợp lệ.`);
    const prompt = asString(item.prompt) ?? '';
    if (!prompt) errors.push(`${where}: thiếu prompt.`);
    out.push({ id, agent, cron, tz, prompt });
  });
  return out;
}

/** Agent keys a package may set. Everything else is dropped on install with a warning. */
export const AGENT_YAML_KEYS = ['name', 'description', 'runtime', 'model', 'skills', 'reports_to', 'budget_usd_month', 'permission'] as const;

export function buildTeamManifest(files: TeamFiles, opts: { slugHint?: string } = {}): { manifest: TeamManifest | null; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (files.size > MAX_PACKAGE_FILES) errors.push(`Gói có ${files.size} file, tối đa ${MAX_PACKAGE_FILES}.`);
  let total = 0;
  for (const [rel, data] of files) {
    const bad = badPackagePath(rel);
    if (bad) errors.push(`${rel}: ${bad}.`);
    if (data.length > MAX_FILE_BYTES) errors.push(`${rel}: lớn hơn ${MAX_FILE_BYTES} byte.`);
    total += data.length;
  }
  if (total > MAX_PACKAGE_BYTES) errors.push('Gói lớn hơn 5 MB.');
  const teamFile = files.get(TEAM_ENTRYPOINT);
  if (!teamFile) return { manifest: null, errors: [...errors, 'Thiếu TEAM.md.'], warnings };
  let fm: ReturnType<typeof parseFrontmatter>;
  try {
    fm = parseFrontmatter(teamFile.toString('utf8'));
  } catch (e) {
    return { manifest: null, errors: [...errors, `TEAM.md: YAML frontmatter lỗi (${(e as Error).message.split('\n')[0]}).`], warnings };
  }
  if (!fm.has) errors.push('TEAM.md phải bắt đầu bằng YAML frontmatter.');
  const d = fm.data;
  if (!(TEAM_SCHEMAS as readonly unknown[]).includes(d.schema)) errors.push('TEAM.md: schema phải là aios-team/v1.');
  const name = asString(d.name);
  if (!name) errors.push('TEAM.md: thiếu name.');
  const description = asString(d.description);
  if (!description) errors.push('TEAM.md: thiếu description.');
  const slug = asString(d.slug) ?? opts.slugHint ?? '';
  if (!SLUG_RE.test(slug)) errors.push(`TEAM.md: slug "${slug}" phải là chữ thường, số và dấu gạch ngang.`);
  if (opts.slugHint && slug !== opts.slugHint) errors.push(`TEAM.md: slug "${slug}" khác tên thư mục "${opts.slugHint}".`);

  const agentIds = [...new Set([...files.keys()].filter((p) => p.startsWith('agents/')).map((p) => p.split('/')[1]!))].sort();
  const decls: TeamAgentDecl[] = [];
  for (const id of agentIds) {
    if (!AGENT_ID_RE.test(id)) {
      errors.push(`agents/${id}: id agent không hợp lệ (chữ thường, số, gạch ngang; 2–41 ký tự).`);
      continue;
    }
    const persona = files.get(`agents/${id}/persona.md`) ?? files.get(`agents/${id}/CLAUDE.md`);
    const tpl = files.get(`agents/${id}/${AGENT_YAML_TEMPLATE}`);
    if (!persona) errors.push(`agents/${id}: thiếu persona.md.`);
    if (!tpl) {
      errors.push(`agents/${id}: thiếu ${AGENT_YAML_TEMPLATE}.`);
      continue;
    }
    let cfg: unknown;
    try {
      cfg = parse(tpl.toString('utf8'));
    } catch (e) {
      errors.push(`agents/${id}/${AGENT_YAML_TEMPLATE}: YAML lỗi (${(e as Error).message.split('\n')[0]}). Đặt giá trị chứa {{...}} trong dấu nháy.`);
      continue;
    }
    if (!isRecord(cfg)) {
      errors.push(`agents/${id}/${AGENT_YAML_TEMPLATE}: phải là một mapping.`);
      continue;
    }
    const agentName = asString(cfg.name);
    if (!agentName) errors.push(`agents/${id}/${AGENT_YAML_TEMPLATE}: thiếu name.`);
    for (const key of Object.keys(cfg)) {
      if (!(AGENT_YAML_KEYS as readonly string[]).includes(key)) warnings.push(`agents/${id}: khoá "${key}" không dùng trong AIOS-Lite, sẽ bị bỏ qua khi cài.`);
    }
    const runtime = asString(cfg.runtime);
    if (runtime && !(RUNTIME_IDS as readonly string[]).includes(runtime)) errors.push(`agents/${id}/${AGENT_YAML_TEMPLATE}: runtime "${runtime}" không hợp lệ.`);
    const skills = Array.isArray(cfg.skills) ? cfg.skills.filter((s): s is string => typeof s === 'string') : [];
    decls.push({
      id,
      name: agentName ?? id,
      description: asString(cfg.description) ?? '',
      runtime: (runtime as RuntimeId | null) ?? null,
      model: asString(cfg.model),
      skills,
      fileCount: [...files.keys()].filter((p) => p.startsWith(`agents/${id}/`)).length,
    });
  }
  if (decls.length === 0) errors.push('Gói cần ít nhất một agent trong agents/<id>/.');
  const manager = asString(d.manager) ?? decls[0]?.id ?? '';
  decls.sort((a, b) => (a.id === manager ? -1 : b.id === manager ? 1 : a.id.localeCompare(b.id)));
  const localIds = decls.map((a) => a.id);
  if (!localIds.includes(manager)) errors.push(`TEAM.md: manager "${manager}" phải là một agent trong gói.`);

  const inputs = readInputs(d.inputs, errors);
  const requiredSkills = Array.isArray(d.requiredSkills) ? d.requiredSkills.filter((s): s is string => typeof s === 'string') : [];
  for (const s of requiredSkills) if (!SKILL_ID_RE.test(s)) errors.push(`TEAM.md: requiredSkills có id không hợp lệ "${s}".`);
  const schedules = readSchedules(files.get(TEAM_SCHEDULES_FILE)?.toString('utf8'), localIds, errors);

  const keys = new Set(inputs.map((i) => i.key));
  for (const [rel, data] of files) {
    for (const m of data.toString('utf8').matchAll(PLACEHOLDER_RE)) {
      const ref = m[1]!;
      if (ref.startsWith('input.') && !keys.has(ref.slice(6))) errors.push(`${rel}: dùng {{${ref}}} nhưng TEAM.md chưa khai báo input này.`);
    }
  }
  if (errors.length > 0 || !name || !description) return { manifest: null, errors, warnings };
  return {
    manifest: {
      slug,
      name,
      version: d.version === undefined ? '1' : String(d.version),
      description,
      tags: Array.isArray(d.tags) ? d.tags.filter((t): t is string => typeof t === 'string') : [],
      manager,
      agents: decls,
      schedules,
      requiredSkills,
      prerequisites: Array.isArray(d.prerequisites) ? d.prerequisites.filter((s): s is string => typeof s === 'string') : [],
      inputs,
      body: fm.body.trim(),
      fileCount: files.size,
    },
    errors,
    warnings,
  };
}

/** Read a package directory. Symlinks are errors, never followed. */
export function readPackageDir(dir: string): { files: TeamFiles; errors: string[] } {
  const files: TeamFiles = new Map();
  const errors: string[] = [];
  const root = fs.realpathSync(dir);
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(current, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        errors.push(`${rel}: symlink không được phép trong gói.`);
        continue;
      }
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) {
        if (fs.statSync(abs).size > MAX_FILE_BYTES) errors.push(`${rel}: lớn hơn ${MAX_FILE_BYTES} byte.`);
        else files.set(rel, fs.readFileSync(abs));
      }
    }
  };
  visit(root);
  return { files, errors };
}

export function loadPackageFiles(files: TeamFiles, source: LoadedTeam['source'], slugHint?: string, extraErrors: string[] = []): LoadedTeam {
  const built = buildTeamManifest(files, { slugHint });
  const errors = [...extraErrors, ...built.errors];
  if (!built.manifest || errors.length) throw new TeamError(`Gói không hợp lệ: ${errors[0]}`, 422, errors);
  return { manifest: built.manifest, files, warnings: built.warnings, source };
}

export function loadPackageDir(dir: string, source: LoadedTeam['source'], slugHint?: string): LoadedTeam {
  const read = readPackageDir(dir);
  return loadPackageFiles(read.files, source, slugHint, read.errors);
}

export const newImportId = (): string => crypto.randomBytes(8).toString('hex');
