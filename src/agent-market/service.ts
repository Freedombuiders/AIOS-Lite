// Agent market: template cards -> one agent. Preview shows exactly the files that will be written.
import fs from 'node:fs';
import path from 'node:path';
import type { AgentRegistry } from '../agents/contracts.js';
import { AGENT_ID_RE } from '../agents/schema.js';
import type { AppConfig } from '../core/config.js';
import { RUNTIME_IDS, type RuntimeId } from '../core/types.js';
import type { AuditService } from '../access/contracts.js';
import type { SkillLibrary } from '../shared/contracts.js';
import { MARKET_TEMPLATES, type MarketTemplate } from './catalog.js';
import { renderMarketFiles, type TemplateFile } from './files.js';
import { EXTRA_TEMPLATES } from './templates-extra.js';

export class MarketError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 | 422 = 400,
  ) {
    super(message);
  }
}

export interface MarketInstallRequest {
  name?: string;
  id?: string;
  runtime?: RuntimeId;
  model?: string;
  fields?: Record<string, string>;
}

export interface MarketPreview {
  templateId: string;
  agentId: string;
  name: string;
  runtime: RuntimeId;
  files: TemplateFile[];
  /** skills that will be added to the library (bundled and not there yet) */
  newSkills: string[];
  existingSkills: string[];
  missingRequired: string[];
  warnings: string[];
}

export interface MarketServiceDeps {
  config: Pick<AppConfig, 'skillsDirs' | 'rootDir'>;
  agents: AgentRegistry;
  skills?: SkillLibrary;
  audit?: AuditService;
}

const DEFAULT_RUNTIME: RuntimeId = 'claude';

export function allTemplates(): MarketTemplate[] {
  return [...MARKET_TEMPLATES, ...EXTRA_TEMPLATES];
}

export function createMarketService(deps: MarketServiceDeps) {
  const skillsDir = deps.config.skillsDirs[0] ?? path.join(deps.config.rootDir, 'skills');
  const tpl = (id: string): MarketTemplate => {
    const t = allTemplates().find((x) => x.id === id);
    if (!t) throw new MarketError('Không tìm thấy mẫu agent.', 404);
    return t;
  };
  const skillExists = (id: string) => !!deps.skills?.get(id) || fs.existsSync(path.join(skillsDir, id, 'SKILL.md'));

  function freeId(base: string): string {
    const root = base.replace(/[^a-z0-9-]/g, '-').slice(0, 36);
    if (!deps.agents.get(root)) return root;
    for (let i = 2; i < 100; i++) if (!deps.agents.get(`${root}-${i}`)) return `${root}-${i}`;
    throw new MarketError('Không tìm được id trống.', 409);
  }

  function preview(templateId: string, req: MarketInstallRequest = {}): MarketPreview {
    const t = tpl(templateId);
    const runtime = req.runtime ?? DEFAULT_RUNTIME;
    if (!(RUNTIME_IDS as readonly string[]).includes(runtime)) throw new MarketError('Runtime không hợp lệ.', 400);
    const warnings: string[] = [];
    let agentId = req.id?.trim() || freeId(t.id);
    if (req.id) {
      if (!AGENT_ID_RE.test(agentId)) throw new MarketError('Id agent chỉ gồm chữ thường, số và dấu gạch ngang (2–41 ký tự).', 400);
      if (deps.agents.get(agentId)) throw new MarketError(`Agent "${agentId}" đã tồn tại. Chọn id khác.`, 409);
    }
    const name = req.name?.trim() || t.name;
    const fields = req.fields ?? {};
    const files = renderMarketFiles(t, name, fields);
    const skillIds = (t.skills ?? []).map((s) => s.id);
    const missingRequired = t.fields.filter((f) => f.required && !(fields[f.key]?.trim() || f.defaultValue)).map((f) => f.label);
    const existingSkills = skillIds.filter(skillExists);
    if (existingSkills.length) warnings.push(`Skill ${existingSkills.join(', ')} đã có trong thư viện, giữ bản hiện tại.`);
    return { templateId, agentId, name, runtime, files, newSkills: skillIds.filter((s) => !existingSkills.includes(s)), existingSkills, missingRequired, warnings };
  }

  function install(templateId: string, req: MarketInstallRequest = {}) {
    const p = preview(templateId, req);
    if (p.missingRequired.length) throw new MarketError(`Cần điền: ${p.missingRequired.join(', ')}.`, 422);
    const t = tpl(templateId);
    const written: string[] = [];
    let created: ReturnType<AgentRegistry['create']> | null = null;
    try {
      for (const f of p.files) {
        if (f.kind !== 'skill') continue;
        const sid = f.path.split('/')[1]!;
        if (!p.newSkills.includes(sid)) continue;
        const target = path.join(skillsDir, sid, 'SKILL.md');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, f.content);
        written.push(path.join(skillsDir, sid));
      }
      const persona = p.files.find((f) => f.kind === 'persona')!.content;
      created = deps.agents.create(p.agentId, {
        name: p.name,
        description: t.description,
        runtime: p.runtime,
        ...(req.model ? { model: req.model } : {}),
        persona,
        permission: 'safe',
        access: { brain: {}, memory: { team: false, private: true }, skills: (t.skills ?? []).map((s) => s.id), connections: {}, modules: {} },
      });
      const knowledge = p.files.find((f) => f.kind === 'knowledge');
      if (knowledge) {
        const target = path.join(created.dir, knowledge.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, knowledge.content);
      }
      deps.skills?.reload();
    } catch (err) {
      if (created) fs.rmSync(created.dir, { recursive: true, force: true });
      for (const w of written) fs.rmSync(w, { recursive: true, force: true });
      deps.agents.reload();
      throw new MarketError(`Cài agent thất bại, đã hoàn tác: ${(err as Error).message}`, 422);
    }
    deps.audit?.log({ actor: 'user', action: 'market.install', target: created.id, detail: { template: templateId, runtime: p.runtime } });
    return { agent: { id: created.id, name: created.name, runtime: created.runtime }, createdSkills: p.newSkills, files: p.files.map((f) => f.path) };
  }

  return {
    templates() {
      return allTemplates().map((t) => ({
        id: t.id, name: t.name, category: t.category, description: t.description, outcome: t.outcome, capabilities: t.capabilities, examples: t.examples,
        fields: t.fields.map((f) => ({ key: f.key, label: f.label, required: !!f.required, multiline: !!f.multiline, placeholder: f.placeholder, help: f.help ?? '', defaultValue: f.defaultValue ?? '' })),
        skills: (t.skills ?? []).map((s) => ({ id: s.id, name: s.name, description: s.description })),
      }));
    },
    preview,
    install,
  };
}

export type MarketService = ReturnType<typeof createMarketService>;
