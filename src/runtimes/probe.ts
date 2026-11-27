// A minimal single-turn run request (no tools, throwaway agent "doctor"): GenBot's "ping" check and the tests build on it.
import type { RuntimeId } from '../core/types.js';
import type { RunRequest } from './contracts.js';

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
