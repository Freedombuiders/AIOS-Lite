/**
 * One headless turn of a persona's brain agent (captions, strategist,
 * autopilot plans) through ctx.agents.runLean: the agent's own runtime and model,
 * stateless. The agent only returns text (JSON); code validates it. Untrusted
 * text (briefs, Radar ideas, platform data) reaches it inside <untrusted> tags.
 */

import { escapeUntrusted, extractJsonObjects } from './radar-util.js';
import { moduleCompat, requireEnabled } from './compat.js';

export interface AgentTextResult {
  text: string;
  model: string;
  costUsd: number;
  error?: string;
}

export interface AgentTurnInput {
  agentId: string;
  /** Usage label: `kol:<step>:<personaId>`. */
  usageKey: string;
  system: string;
  prompt: string;
}

/** Injectable for tests; the default talks to the real engine. */
export type AgentRunner = (input: AgentTurnInput) => Promise<AgentTextResult>;

const TURN_TIMEOUT_MS = 300_000;

/** Brain id meaning "an agent on the Codex runtime (the owner's ChatGPT plan)". */
export const CHATGPT_BRAIN = '@chatgpt';

/** The agent a brain id runs on: an agent id, 'main' (the default agent) or '@chatgpt' (first Codex agent). */
export function brainAgentId(brain: string): string | null {
  const ctx = moduleCompat('kol');
  if (!ctx) return null;
  const agents = ctx.agents.list().filter((a) => a.enabled);
  if (brain === CHATGPT_BRAIN) return agents.find((a) => a.runtime === 'codex')?.id ?? null;
  if (brain && brain !== 'main' && ctx.agents.get(brain)) return brain;
  return ctx.agents.get('main') ? 'main' : (agents[0]?.id ?? null);
}

export const runKolAgent: AgentRunner = async (input) => {
  requireEnabled('LLM_SPAWN_ENABLED');
  const ctx = moduleCompat('kol');
  const agentId = brainAgentId(input.agentId || 'main');
  if (!ctx || !agentId) {
    return { text: '', model: '', costUsd: 0, error: input.agentId === CHATGPT_BRAIN ? 'Chưa có agent nào chạy Codex để dùng gói ChatGPT.' : 'Không tìm thấy agent để viết nội dung.' };
  }
  const res = await ctx.agents.runLean({
    agentId,
    title: `KOL · ${input.usageKey}`,
    prompt: input.prompt,
    moduleContext: input.system,
    timeoutMs: TURN_TIMEOUT_MS,
    meta: { usageKey: input.usageKey },
  });
  const agent = ctx.agents.get(agentId);
  return {
    text: res.output ?? '',
    model: agent?.model ?? agent?.runtime ?? agentId,
    costUsd: res.usage?.costUsd ?? 0,
    ...(res.ok ? {} : { error: res.error ?? 'Agent không trả lời được.' }),
  };
};

/** Wraps text the agent must treat as data, never as instructions. */
export function untrusted(text: string): string {
  return `<untrusted>\n${escapeUntrusted(text)}\n</untrusted>`;
}

/** Every JSON object in the agent's answer (fenced or bare), in order. */
export function jsonObjectsOf(text: string): unknown[] {
  return extractJsonObjects(text);
}

/** Human name of a language code for prompts ("vi" → "tiếng Việt"). */
export function languageName(code: string | undefined): string {
  const c = (code ?? 'vi').toLowerCase();
  if (c.startsWith('vi')) return 'tiếng Việt';
  if (c.startsWith('en')) return 'English';
  if (c.startsWith('ja')) return '日本語 (Japanese)';
  if (c.startsWith('ko')) return '한국어 (Korean)';
  if (c.startsWith('zh')) return '中文 (Chinese)';
  if (c.startsWith('th')) return 'ภาษาไทย (Thai)';
  if (c.startsWith('es')) return 'Español (Spanish)';
  return c;
}
