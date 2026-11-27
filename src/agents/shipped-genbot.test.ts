// Open AgenticOS runs every agent on GenBot: each agent definition the repo ships (agents/, modules/*/agents/, teams/)
// names runtime genbot, an empty bot_id (shown as "chưa nối GenBot" until the owner fills it) and no key or key variable.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../shared/test-kit.js';

function shippedDefinitions(): string[] {
  const out: string[] = [];
  const sub = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name)) : []);
  for (const a of sub(path.join(REPO_ROOT, 'agents'))) if (!path.basename(a).startsWith('_')) out.push(path.join(a, 'agent.yaml'));
  for (const m of sub(path.join(REPO_ROOT, 'modules'))) for (const a of sub(path.join(m, 'agents'))) out.push(path.join(a, 'agent.yaml'));
  for (const t of sub(path.join(REPO_ROOT, 'teams'))) for (const a of sub(path.join(t, 'agents'))) out.push(path.join(a, 'agent.yaml.template'));
  return out.filter((f) => fs.existsSync(f));
}

describe('shipped agent definitions', () => {
  const files = shippedDefinitions();

  it('finds the agents, module agents and team templates', () => {
    const rel = files.map((f) => path.relative(REPO_ROOT, f));
    expect(rel).toEqual(expect.arrayContaining(['agents/main/agent.yaml', 'modules/care/agents/cskh/agent.yaml', 'teams/agenticos-doi-mac-dinh/agents/bot-cskh/agent.yaml.template']));
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it.each(files.map((f) => [path.relative(REPO_ROOT, f), f]))('%s is a GenBot bot not yet connected', (_rel, file) => {
    const y = parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(y.runtime).toBe('genbot');
    expect(['lean', 'standard']).toContain(y.context);
    expect(y.model).toBeUndefined();
    const ro = (y.runtime_options ?? {}) as Record<string, unknown>;
    expect(ro.bot_id).toBe('');
    expect(typeof ro.base_url).toBe('string');
    expect(ro.key_env).toBeUndefined();
  });
});
