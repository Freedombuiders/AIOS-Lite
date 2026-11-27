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
