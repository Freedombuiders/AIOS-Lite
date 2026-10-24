// Test helpers shared by the runtime tests (not shipped: excluded by tsconfig).
import { mkdtemp } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunEvent } from '../core/types.js';
import type { EffectiveAccess } from '../access/contracts.js';
import type { RunRequest } from './contracts.js';
import { probeRequest } from './probe.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const fixture = (name: string) => path.join(root, 'test-fixtures/runtimes', name);

export async function tmpCwd(): Promise<string> {
  return realpathSync(await mkdtemp(path.join(tmpdir(), 'aios-rt-')));
}

export function access(overrides: Partial<EffectiveAccess> = {}): EffectiveAccess {
  return { agentId: 'a1', readDirs: [], writeDirs: [], addDirs: [], memory: { team: true, private: true }, mcpServers: [], envVars: {}, skills: [], moduleScopes: {}, permission: 'safe', tools: 'default', ...overrides };
}

export function makeReq(cwd: string, overrides: Partial<Omit<RunRequest, 'agent' | 'access'>> & { agent?: Partial<RunRequest['agent']>; access?: Partial<EffectiveAccess> } = {}): RunRequest & { events: RunEvent[] } {
  const base = probeRequest(cwd);
  const events: RunEvent[] = [];
  const { agent, access: acc, ...rest } = overrides;
  return {
    ...base,
    tools: 'default',
    prompt: 'xin chào',
    systemPrompt: 'Bạn là trợ lý.',
    timeoutMs: 20_000,
    ...rest,
    agent: { ...base.agent, ...agent },
    access: access({ ...acc, permission: acc?.permission ?? 'safe' }),
    events,
    onEvent: (e) => events.push(e),
  };
}
