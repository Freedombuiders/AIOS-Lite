// Shared doctor probe: a tiny single-turn "hello" run in a throwaway directory.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RuntimeId } from '../core/types.js';
import type { DoctorCheck, RunRequest, RunResult } from './contracts.js';
import { clip } from './jsonl.js';

export function probeRequest(cwd: string, runtime: RuntimeId = 'mock'): RunRequest {
  return {
    agent: {
      id: 'doctor',
      name: 'doctor',
      description: '',
      runtime,
      runtimeOptions: {},
      permission: 'safe',
      context: 'lean',
      canDelegate: false,
      maxConcurrent: 1,
      enabled: true,
      access: { brain: {}, memory: { team: false, private: false }, skills: [], connections: {}, modules: {} },
      persona: '',
      dir: cwd,
      workspace: cwd,
    },
    access: { agentId: 'doctor', readDirs: [], writeDirs: [], addDirs: [], memory: { team: false, private: false }, mcpServers: [], envVars: {}, skills: [], moduleScopes: {}, permission: 'safe', tools: 'none' },
    prompt: 'Trả lời đúng một từ: hello',
    systemPrompt: '',
    cwd,
    tools: 'none',
    signal: new AbortController().signal,
    timeoutMs: 90_000,
    onEvent() {},
  };
}

export async function probeCheck(id: RuntimeId, run: (req: RunRequest) => Promise<RunResult>): Promise<DoctorCheck> {
  const cwd = await mkdtemp(path.join(tmpdir(), `aios-probe-${id}-`));
  try {
    const res = await run(probeRequest(cwd, id));
    if (res.ok && res.output.trim()) return { code: `${id}.probe`, level: 'info', message: `Thử "hello" thành công: ${clip(res.output.trim(), 60)}` };
    return { code: `${id}.probe`, level: 'error', message: `Thử "hello" thất bại: ${res.error?.message ?? 'không có kết quả'}`, hint: res.error?.family === 'auth' ? 'Đăng nhập lại CLI.' : undefined };
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}
