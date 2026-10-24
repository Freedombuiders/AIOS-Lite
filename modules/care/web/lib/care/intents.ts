// Delivery intents this browser submitted, per conversation. There is no list-outbox route yet, so
// the timeline can only show chips for intents created in this session; each one is polled by id
// (GET /outbox/:id) until it settles.

import type { CareOutboxIntentDto } from './dto';
import { isSettled, upsertIntent } from './outbox';

export interface TrackedIntent {
  intent: CareOutboxIntentDto;
  /** What the operator wrote; the intent DTO deliberately carries no body. */
  text: string;
}

export interface IntentStore {
  get(conversationId: string): TrackedIntent[];
  upsert(conversationId: string, intent: CareOutboxIntentDto, text?: string): void;
  /** Intents still worth polling for this conversation. */
  open(conversationId: string): TrackedIntent[];
  subscribe(fn: () => void): () => void;
}

const EMPTY: TrackedIntent[] = [];

export function createIntentStore(): IntentStore {
  const map = new Map<string, TrackedIntent[]>();
  const listeners = new Set<() => void>();
  return {
    get: (id) => map.get(id) ?? EMPTY,
    upsert(id, intent, text) {
      const cur = map.get(id) ?? [];
      const known = cur.find((t) => t.intent.id === intent.id);
      const merged = upsertIntent(cur.map((t) => t.intent), intent);
      const next = merged.map((i) => ({ intent: i, text: i.id === intent.id ? (text ?? known?.text ?? '') : (cur.find((t) => t.intent.id === i.id)?.text ?? '') }));
      map.set(id, next);
      for (const l of [...listeners]) l();
    },
    open: (id) => (map.get(id) ?? EMPTY).filter((t) => !isSettled(t.intent)),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
