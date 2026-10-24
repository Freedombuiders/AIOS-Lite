// Export selected agents (+ their skills, knowledge and schedules) as a team package zip, secrets scrubbed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { stringify } from 'yaml';
import type { AgentRegistry } from '../agents/contracts.js';
import type { SkillLibrary } from '../shared/contracts.js';
import type { SchedulerService } from '../work/contracts.js';
import { Scrubber } from './secrets.js';
import { TEAM_SCHEMA, TeamError } from './types.js';

export interface ExportDeps {
  agents: AgentRegistry;
  scheduler: SchedulerService;
  skills: SkillLibrary;
  rootDir: string;
}

export interface ExportRequest {
  name: string;
  slug?: string;
  description?: string;
  agentIds: string[];
  manager?: string;
}

export interface ExportResult {
  filename: string;
  zip: Buffer;
  files: string[];
  redactions: number;
  inputs: string[];
}

const TEXT_EXT = new Set(['.md', '.yaml', '.yml', '.txt', '.json']);

const slugify = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'team';

function walkText(dir: string, base = dir, out: Array<{ rel: string; text: string }> = []): Array<{ rel: string; text: string }> {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkText(abs, base, out);
    else if (e.isFile() && TEXT_EXT.has(path.extname(e.name).toLowerCase()) && fs.statSync(abs).size <= 512 * 1024) {
      out.push({ rel: path.relative(base, abs).split(path.sep).join('/'), text: fs.readFileSync(abs, 'utf8') });
    }
  }
  return out;
}

export function exportTeam(deps: ExportDeps, req: ExportRequest): ExportResult {
  const ids = [...new Set(req.agentIds)];
  if (!ids.length) throw new TeamError('Chọn ít nhất một agent để xuất.', 400);
  const agents = ids.map((id) => deps.agents.get(id) ?? (() => { throw new TeamError(`Không tìm thấy agent "${id}".`, 404); })());
  const slug = req.slug ? slugify(req.slug) : slugify(req.name);
  const manager = req.manager && ids.includes(req.manager) ? req.manager : (agents.find((a) => !a.reportsTo || !ids.includes(a.reportsTo)) ?? agents[0]!).id;
  const scrub = new Scrubber([deps.rootDir, os.homedir()]);
  const out = new Map<string, string>();

  for (const a of agents) {
    const tpl: Record<string, unknown> = { name: a.name, description: a.description, runtime: a.runtime };
    if (a.model) tpl.model = a.model;
    const skills = a.access.skills === 'all' ? [] : a.access.skills;
    if (skills.length) tpl.skills = skills;
    if (a.reportsTo && ids.includes(a.reportsTo)) tpl.reports_to = a.reportsTo;
    if (a.budgetUsdMonth !== undefined) tpl.budget_usd_month = a.budgetUsdMonth;
    out.set(`agents/${a.id}/agent.yaml.template`, stringify(scrub.value(tpl, a.id, 'agent.yaml'), { lineWidth: 0 }));
    out.set(`agents/${a.id}/persona.md`, scrub.text(a.persona.endsWith('\n') ? a.persona : `${a.persona}\n`, a.id, 'persona.md'));
    for (const f of walkText(path.join(a.dir, 'knowledge'), a.dir)) out.set(`agents/${a.id}/${f.rel}`, scrub.text(f.text, a.id, f.rel));
    for (const sid of skills) {
      const sk = deps.skills.get(sid);
      if (!sk) continue;
      for (const f of walkText(sk.dir)) out.set(`agents/${a.id}/skills/${sid}/${f.rel}`, scrub.text(f.text, a.id, `skills/${sid}/${f.rel}`));
    }
  }

  const schedules = deps.scheduler.list().filter((s) => ids.includes(s.agentId));
  if (schedules.length) {
    const list = schedules.map((s, i) => ({
      id: slugify(s.name).slice(0, 40) || `schedule-${i + 1}`,
      agent: s.agentId,
      cron: s.cron,
      tz: s.timezone,
      prompt: scrub.text(s.prompt, s.agentId, 'schedules.yaml'),
    }));
    const seen = new Set<string>();
    for (const l of list) {
      while (seen.has(l.id)) l.id += '-2';
      seen.add(l.id);
    }
    out.set('schedules.yaml', stringify({ schedules: list }, { lineWidth: 0 }));
  }

  const inputs = [...scrub.inputs.values()].map((i) => ({ key: i.key, label: i.label, description: i.description, kind: i.kind === 'secret' ? 'secret' : 'plain', required: false }));
  const front: Record<string, unknown> = {
    schema: TEAM_SCHEMA,
    name: req.name,
    slug,
    version: 1,
    description: req.description?.trim() || `Gói team "${req.name}" xuất từ AIOS-Lite.`,
    manager,
    agents: ids,
    ...(inputs.length ? { inputs } : {}),
  };
  out.set('TEAM.md', `---\n${stringify(front, { lineWidth: 0 })}---\n\n# ${req.name}\n\nGói xuất tự động. Khoá, token, đường dẫn máy và email đã được gỡ và thay bằng ô điền khi cài.\n`);

  const zip = new AdmZip();
  for (const [rel, text] of [...out.entries()].sort(([a], [b]) => a.localeCompare(b))) zip.addFile(rel, Buffer.from(text, 'utf8'));
  return { filename: `${slug}.zip`, zip: zip.toBuffer(), files: [...out.keys()].sort(), redactions: scrub.redactions.length, inputs: inputs.map((i) => i.key) };
}
