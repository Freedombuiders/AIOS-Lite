import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import type { AgentConfig } from '../core/types.js';
import type { AgentInput, AgentLoadError, AgentRegistry, AgentRegistryOptions } from './contracts.js';
import { AGENT_ID_RE, AgentValidationError, agentToYamlObject, parseAgentConfig, validateAgentId } from './schema.js';

export type AgentRegistryWithWorkspace = AgentRegistry & { ensureWorkspace(id: string): string };

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function createAgentRegistry(opts: AgentRegistryOptions): AgentRegistryWithWorkspace {
  const agentsDir = path.resolve(opts.agentsDir);
  const workspacesDir = path.resolve(opts.workspacesDir);
  const repoRoot = path.dirname(agentsDir);
  const agents = new Map<string, AgentConfig>();
  let errors: AgentLoadError[] = [];

  function loadOne(id: string): AgentConfig {
    const dir = path.join(agentsDir, id);
    const file = path.join(dir, 'agent.yaml');
    if (!fs.existsSync(file)) throw new AgentValidationError(`Thiếu file agent.yaml trong thư mục agents/${id}.`, ['agent.yaml']);
    let raw: unknown;
    try {
      raw = parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new AgentValidationError(`agent.yaml của "${id}" không phải YAML hợp lệ: ${(e as Error).message}`, ['yaml']);
    }
    let persona: string | undefined;
    try {
      persona = fs.readFileSync(path.join(dir, 'persona.md'), 'utf8');
    } catch {
      persona = undefined;
    }
    return parseAgentConfig(raw, { id, dir, repoRoot, workspacesDir, persona });
  }

  function reload(): void {
    agents.clear();
    errors = [];
    if (!fs.existsSync(agentsDir)) return;
    for (const ent of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith('_') || ent.name.startsWith('.')) continue;
      const id = ent.name;
      const file = path.join(agentsDir, id, 'agent.yaml');
      try {
        agents.set(id, loadOne(id));
      } catch (e) {
        errors.push({ id, file, message: (e as Error).message });
      }
    }
  }

  function write(cfg: AgentConfig, personaText: string | undefined): void {
    fs.mkdirSync(cfg.dir, { recursive: true });
    const yamlText = stringify(agentToYamlObject(cfg, { workspacesDir }), { lineWidth: 0 });
    fs.writeFileSync(path.join(cfg.dir, 'agent.yaml'), yamlText);
    if (personaText !== undefined) fs.writeFileSync(path.join(cfg.dir, 'persona.md'), personaText.endsWith('\n') ? personaText : `${personaText}\n`);
  }

  function ensureWorkspace(id: string): string {
    const a = agents.get(id);
    if (!a) throw new Error(`Không có agent "${id}".`);
    fs.mkdirSync(a.workspace, { recursive: true });
    return a.workspace;
  }

  function require_(id: string): AgentConfig {
    const a = agents.get(id);
    if (!a) throw new Error(`Không tìm thấy agent "${id}".`);
    return a;
  }

  function merge(base: AgentConfig, patch: AgentInput): AgentConfig {
    const next: AgentConfig = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
    }
    return next;
  }

  /** Round-trip through the schema so every write is validated. */
  function validated(cfg: AgentConfig): AgentConfig {
    const raw = agentToYamlObject(cfg, { workspacesDir });
    return parseAgentConfig(raw, { id: cfg.id, dir: cfg.dir, repoRoot, workspacesDir, persona: cfg.persona });
  }

  reload();

  return {
    reload,
    list: () => [...agents.values()].sort((a, b) => a.id.localeCompare(b.id)),
    get: (id) => agents.get(id),
    require: require_,
    errors: () => errors.slice(),
    ensureWorkspace,

    create(id, input) {
      validateAgentId(id);
      const dir = path.join(agentsDir, id);
      if (fs.existsSync(dir)) throw new Error(`Agent "${id}" đã tồn tại.`);
      const seed = parseAgentConfig({ name: input.name, runtime: input.runtime }, { id, dir, repoRoot, workspacesDir });
      const { persona, ...rest } = input;
      const cfg = validated({ ...merge(seed, rest), persona: persona ?? input.description ?? '' });
      write(cfg, cfg.persona);
      agents.set(id, cfg);
      fs.mkdirSync(cfg.workspace, { recursive: true });
      return cfg;
    },

    update(id, patch) {
      const cur = require_(id);
      const { persona, ...rest } = patch;
      const cfg = validated({ ...merge(cur, rest), persona: persona ?? cur.persona });
      write(cfg, persona !== undefined ? persona : undefined);
      agents.set(id, cfg);
      return cfg;
    },

    archive(id) {
      const cur = require_(id);
      const dest = path.join(agentsDir, '_archive', `${id}-${stamp()}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(cur.dir, dest);
      agents.delete(id);
    },

    installTemplate(templateDir, id) {
      const src = path.resolve(templateDir);
      const newId = id ?? path.basename(src);
      if (!AGENT_ID_RE.test(newId)) validateAgentId(newId);
      if (!fs.existsSync(path.join(src, 'agent.yaml'))) throw new Error(`Thư mục mẫu ${src} không có agent.yaml.`);
      const dest = path.join(agentsDir, newId);
      if (fs.existsSync(dest)) throw new Error(`Agent "${newId}" đã tồn tại.`);
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
      try {
        const cfg = loadOne(newId);
        agents.set(newId, cfg);
        fs.mkdirSync(cfg.workspace, { recursive: true });
        return cfg;
      } catch (e) {
        fs.rmSync(dest, { recursive: true, force: true });
        throw e;
      }
    },
  };
}
