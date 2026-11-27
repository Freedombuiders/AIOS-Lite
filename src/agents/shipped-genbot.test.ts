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
    expect(rel).toEqual(expect.arrayContaining(['agents/bot-tro-ly/agent.yaml', 'modules/care/agents/cskh/agent.yaml', 'teams/agenticos-doi-mac-dinh/agents/bot-cskh/agent.yaml.template']));
    expect(files.length).toBeGreaterThanOrEqual(18);
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

  it('the repo ships exactly the three bots of the default team, with that team\'s brain access and module scopes', () => {
    const dir = path.join(REPO_ROOT, 'agents');
    const ids = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_')).map((e) => e.name).sort();
    expect(ids).toEqual(['bot-cskh', 'bot-noi-dung', 'bot-tro-ly']);
    for (const id of ids) {
      const shipped = parse(fs.readFileSync(path.join(dir, id, 'agent.yaml'), 'utf8')) as Record<string, any>;
      const tpl = parse(
        fs.readFileSync(path.join(REPO_ROOT, 'teams/agenticos-doi-mac-dinh/agents', id, 'agent.yaml.template'), 'utf8')
          .replaceAll('{{input.BRAIN_FOLDER}}', 'cong-ty-b').replaceAll('{{input.SHOP_NAME}}', 'Trà Sen Việt').replaceAll('{{input.GENBOT_URL}}', 'http://127.0.0.1:8800'),
      ) as Record<string, any>;
      expect(shipped.name).toBe(tpl.name);
      expect(shipped.context).toBe(tpl.context);
      expect(shipped.runtime_options).toEqual(tpl.runtime_options);
      expect(shipped.access.brain).toEqual(tpl.access.brain);
      expect(shipped.access.memory).toEqual(tpl.access.memory);
      expect(shipped.access.modules ?? {}).toEqual(tpl.access.modules ?? {});
    }
  });
});
