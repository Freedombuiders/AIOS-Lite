// Team package service: shipped catalog (<root>/teams), imported zips (in memory, 1 hour), install history in kv.
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { AgentRegistry } from '../agents/contracts.js';
import type { AppConfig } from '../core/config.js';
import { nowIso, type DB } from '../core/db.js';
import type { AuditService } from '../access/contracts.js';
import type { SkillLibrary } from '../shared/contracts.js';
import type { SchedulerService } from '../work/contracts.js';
import { exportTeam, type ExportRequest } from './export.js';
import { installTeam, planInstall, type InstallOptions, type InstallPlan, type InstallResult } from './install.js';
import { badPackagePath, loadPackageDir, loadPackageFiles, MAX_PACKAGE_BYTES, MAX_PACKAGE_FILES, newImportId } from './package.js';
import { TeamError, type LoadedTeam, type TeamFiles } from './types.js';

export interface TeamsServiceDeps {
  config: Pick<AppConfig, 'rootDir' | 'skillsDirs' | 'timezone'>;
  db: DB;
  agents: AgentRegistry;
  scheduler: SchedulerService;
  skills: SkillLibrary;
  audit?: AuditService;
  /** override the catalog folder (tests) */
  catalogDir?: string;
}

export interface InstallRecord {
  at: string;
  slug: string;
  name: string;
  agents: string[];
  schedules: number;
  skills: string[];
}

export type TeamSourceRef = { kind: 'catalog'; id: string } | { kind: 'import'; id: string };

const IMPORT_TTL_MS = 60 * 60 * 1000;
const HISTORY_KEY = 'teams:installs';

export function createTeamsService(deps: TeamsServiceDeps) {
  const catalogDir = deps.catalogDir ?? path.join(deps.config.rootDir, 'teams');
  const imports = new Map<string, { team: LoadedTeam; at: number }>();
  const skillsDir = deps.config.skillsDirs[0] ?? path.join(deps.config.rootDir, 'skills');
  const installDeps = () => ({ agents: deps.agents, scheduler: deps.scheduler, skills: deps.skills, skillsDir, timezone: deps.config.timezone });

  function sweep(): void {
    const now = Date.now();
    for (const [id, v] of imports) if (now - v.at > IMPORT_TTL_MS) imports.delete(id);
  }

  function catalog(): { teams: LoadedTeam[]; problems: Array<{ name: string; errors: string[] }> } {
    const teams: LoadedTeam[] = [];
    const problems: Array<{ name: string; errors: string[] }> = [];
    if (!fs.existsSync(catalogDir)) return { teams, problems };
    for (const e of fs.readdirSync(catalogDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('_')) continue;
      try {
        teams.push(loadPackageDir(path.join(catalogDir, e.name), { kind: 'catalog', id: e.name }, e.name));
      } catch (err) {
        problems.push({ name: e.name, errors: err instanceof TeamError && Array.isArray(err.details) ? (err.details as string[]) : [(err as Error).message] });
      }
    }
    return { teams, problems };
  }

  function load(ref: TeamSourceRef): LoadedTeam {
    if (ref.kind === 'catalog') {
      if (!/^[a-z0-9-]+$/.test(ref.id)) throw new TeamError('Mã gói không hợp lệ.', 400);
      const dir = path.join(catalogDir, ref.id);
      if (!fs.existsSync(path.join(dir, 'TEAM.md'))) throw new TeamError('Không tìm thấy gói này.', 404);
      return loadPackageDir(dir, { kind: 'catalog', id: ref.id }, ref.id);
    }
    sweep();
    const hit = imports.get(ref.id);
    if (!hit) throw new TeamError('Gói đã nhập không còn nữa. Tải lại file zip.', 404);
    return hit.team;
  }

  const history = (): InstallRecord[] => {
    const row = deps.db.prepare('SELECT value FROM kv WHERE key = ?').get(HISTORY_KEY) as { value: string } | undefined;
    try {
      return row ? (JSON.parse(row.value) as InstallRecord[]) : [];
    } catch {
      return [];
    }
  };

  const summary = (t: LoadedTeam) => ({
    ...t.manifest,
    source: t.source,
    warnings: t.warnings,
    body: undefined,
    agents: t.manifest.agents,
  });

  return {
    list() {
      sweep();
      const c = catalog();
      return {
        items: c.teams.map(summary),
        imported: [...imports.values()].map((v) => summary(v.team)),
        problems: c.problems,
        history: history().slice(-20).reverse(),
      };
    },
    get(ref: TeamSourceRef) {
      const t = load(ref);
      return { ...t.manifest, source: t.source, warnings: t.warnings };
    },
    preview(ref: TeamSourceRef, opts: InstallOptions = {}): InstallPlan {
      return planInstall(installDeps(), load(ref), opts);
    },
    install(ref: TeamSourceRef, opts: InstallOptions = {}): InstallResult {
      const team = load(ref);
      const result = installTeam(installDeps(), team, opts);
      const rec: InstallRecord = { at: nowIso(), slug: result.slug, name: result.name, agents: result.agents.map((a) => a.id), schedules: result.schedules.length, skills: result.skills };
      deps.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(HISTORY_KEY, JSON.stringify([...history(), rec].slice(-50)));
      deps.audit?.log({ actor: 'user', action: 'team.install', target: result.slug, detail: { agents: rec.agents, schedules: rec.schedules } });
      return result;
    },
    importZip(buf: Buffer): { id: string; team: ReturnType<typeof summary> } {
      if (buf.length > MAX_PACKAGE_BYTES) throw new TeamError('File zip lớn hơn 5 MB.', 413);
      let zip: AdmZip;
      try {
        zip = new AdmZip(buf);
      } catch {
        throw new TeamError('Không đọc được file zip.', 400);
      }
      const entries = zip.getEntries().filter((e) => !e.isDirectory);
      if (entries.length > MAX_PACKAGE_FILES) throw new TeamError(`Gói có ${entries.length} file, tối đa ${MAX_PACKAGE_FILES}.`, 413);
      // a single top-level folder is allowed: strip it
      const names = entries.map((e) => e.entryName.replace(/^\.?\//, ''));
      const top = names[0]?.split('/')[0];
      const wrapped = !!top && names.every((n) => n.startsWith(`${top}/`)) && !names.includes('TEAM.md');
      const files: TeamFiles = new Map();
      const errors: string[] = [];
      entries.forEach((e, i) => {
        const rel = wrapped ? names[i]!.slice(top!.length + 1) : names[i]!;
        const bad = badPackagePath(rel);
        if (bad) errors.push(`${rel}: ${bad}.`);
        else files.set(rel, e.getData());
      });
      const team = loadPackageFiles(files, { kind: 'import', id: newImportId() }, undefined, errors);
      imports.set(team.source.id, { team, at: Date.now() });
      return { id: team.source.id, team: summary(team) };
    },
    dropImport(id: string): boolean {
      return imports.delete(id);
    },
    export(req: ExportRequest) {
      const res = exportTeam({ agents: deps.agents, scheduler: deps.scheduler, skills: deps.skills, rootDir: deps.config.rootDir }, req);
      deps.audit?.log({ actor: 'user', action: 'team.export', target: req.name, detail: { agents: req.agentIds, files: res.files.length, redactions: res.redactions } });
      return res;
    },
  };
}

export type TeamsService = ReturnType<typeof createTeamsService>;
