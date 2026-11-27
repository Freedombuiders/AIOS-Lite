// The agent that takes work nobody assigned (a task or chat with no agent, a module turn with no agent set, recos).
// G3 replaced the old sample agent 'main' with the three bots of the default team (teams/agenticos-doi-mac-dinh):
// the Trợ lý bot when it has a Bot API key, else the first GenBot bot with a key, else the first GenBot bot (its run
// then fails with the "chưa có khoá" how-to). 'mock' agents count only when no GenBot bot exists (tests, AIOS_MOCK=1).
import type { AgentConfig } from '../core/types.js';

export const DEFAULT_AGENT_ID = 'bot-tro-ly';

/** Shown where a bot is needed and none exists: the how-to lives on Đội AI · Bot. */
export const NO_BOT_MESSAGE = 'Chưa có bot GenBot nào. Mở Đội AI · Bot để thêm bot (hoặc cài Đội AgenticOS mặc định ở Gói Team), dán mã bot và khoá Bot API, rồi bấm Kiểm tra.';

type AgentLike = Pick<AgentConfig, 'id' | 'runtime' | 'enabled'>;

/** A GenBot bot has a key when one is stored in the app or its key_env (GENBOT_KEY_*) is set. */
export function botHasKey(agent: Pick<AgentConfig, 'id' | 'runtime' | 'runtimeOptions'> | undefined, stored: { has(id: string): boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!agent || agent.runtime !== 'genbot') return false;
  if (stored.has(agent.id)) return true;
  const keyEnv = typeof agent.runtimeOptions.key_env === 'string' ? agent.runtimeOptions.key_env.trim() : '';
  return keyEnv.startsWith('GENBOT_KEY_') && !!env[keyEnv]?.trim();
}

export function pickDefaultAgent(list: readonly AgentLike[], hasKey: (id: string) => boolean = () => false): string | null {
  const on = list.filter((a) => a.enabled);
  const bots = on.filter((a) => a.runtime === 'genbot');
  const keyed = bots.filter((a) => hasKey(a.id));
  const first = (xs: AgentLike[]) => xs.find((a) => a.id === DEFAULT_AGENT_ID)?.id ?? xs[0]?.id;
  return first(keyed) ?? first(bots) ?? on.find((a) => a.runtime === 'mock')?.id ?? null;
}
