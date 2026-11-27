// Open AgenticOS runs every agent on GenBot. Wherever the owner picks an agent (care, learn, dream, chat, command bar,
// marketing, KOL), only GenBot bots that have a Bot API key are offered. Pure helpers, safe to import anywhere.

export interface BotLike {
  id: string;
  runtime?: string;
  enabled?: boolean;
  /** "đã có khoá" + last four characters (from GET /api/agents); never the key */
  genbotKey?: { hasKey: boolean; last4?: string } | null;
}

export function isUsableBot(a: BotLike): boolean {
  return a.runtime === 'genbot' && !!a.genbotKey?.hasKey;
}

/** GenBot bots that have a key, in the given order. */
export function usableBots<T extends BotLike>(list: readonly T[] | null | undefined): T[] {
  return (list ?? []).filter(isUsableBot);
}

/** GET /api/agents answers `{ items }`; some module screens were written against `{ agents }`. */
export function agentRows<T>(body: { items?: T[]; agents?: T[] } | null | undefined): T[] {
  return body?.items ?? body?.agents ?? [];
}

/** Picker rows: usable bots, plus the current value when it is not one (shown so the owner sees what to change). */
export function pickerBots<T extends BotLike>(body: { items?: T[]; agents?: T[] } | null | undefined): T[] {
  return usableBots(agentRows(body));
}

/** The Trợ lý bot of the default team (teams/agenticos-doi-mac-dinh). It replaced the old sample agent 'main' (G3). */
export const DEFAULT_BOT_ID = 'bot-tro-ly';

/** Who takes a message or a task when the owner picked nobody: the Trợ lý bot when it has a key, else the first bot with a key; '' when none has one. */
export function defaultBotId<T extends BotLike>(list: readonly T[] | null | undefined): string {
  const on = usableBots(list).filter((a) => a.enabled !== false);
  return on.find((a) => a.id === DEFAULT_BOT_ID)?.id ?? on[0]?.id ?? '';
}

/** Shown where a bot is needed and none has a key: the how-to is on Đội AI · Bot. */
export const NO_BOT_HINT = 'Chưa có bot GenBot nào có khoá. Mở Đội AI · Bot, thêm bot (hoặc cài Đội AgenticOS mặc định ở Gói Team), dán mã bot và khoá Bot API, rồi bấm Kiểm tra.';
