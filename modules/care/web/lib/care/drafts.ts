// Per-conversation composer drafts. Module-level (survives route changes inside the SPA) with an
// optional sessionStorage mirror (survives a reload, never leaves the tab). Storage is best effort:
// private windows and blocked storage must not break typing.

import { emptyDraft, type ComposerDraft } from './composer';

export const DRAFT_STORAGE_KEY = 'claudeclaw.care.drafts.v1';
export const MAX_DRAFTS = 60;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DraftStore {
  get(conversationId: string, kind: 'chat' | 'email'): ComposerDraft;
  set(conversationId: string, draft: ComposerDraft): void;
  /** Applies `fn` to the stored draft (or a fresh one) and stores the result. */
  update(conversationId: string, kind: 'chat' | 'email', fn: (d: ComposerDraft) => ComposerDraft): ComposerDraft;
  has(conversationId: string): boolean;
  subscribe(fn: () => void): () => void;
}

function valid(x: unknown): x is ComposerDraft {
  if (!x || typeof x !== 'object') return false;
  const d = x as Record<string, unknown>;
  if (d.kind === 'chat') return typeof d.text === 'string';
  if (d.kind === 'email') return typeof d.body === 'string' && Array.isArray(d.removedCc) && (d.mode === 'reply' || d.mode === 'reply_all');
  return false;
}

export function createDraftStore(storage?: StorageLike | null): DraftStore {
  const map = new Map<string, ComposerDraft>();
  const listeners = new Set<() => void>();

  try {
    const raw = storage?.getItem(DRAFT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [id, d] of Object.entries(parsed)) if (valid(d)) map.set(id, d);
    }
  } catch {
    /* unreadable mirror: start empty */
  }

  function persist(): void {
    if (!storage) return;
    try {
      // Only drafts that hold something are worth keeping; the Map keeps insertion order = recency.
      const entries = [...map.entries()].filter(([, d]) => (d.kind === 'chat' ? d.text : d.body).trim() || d.requestId || (d.kind === 'chat' && d.attachments?.length));
      storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries.slice(-MAX_DRAFTS))));
    } catch {
      /* quota / blocked */
    }
  }

  function put(id: string, d: ComposerDraft): void {
    map.delete(id); // re-insert so the newest edit is last
    map.set(id, d);
    while (map.size > MAX_DRAFTS * 2) map.delete(map.keys().next().value as string);
    persist();
    for (const l of [...listeners]) l();
  }

  return {
    get(id, kind) {
      const d = map.get(id);
      // A draft of the other kind (account changed channel?) is ignored rather than mis-rendered.
      return d && d.kind === kind ? d : emptyDraft(kind);
    },
    set: put,
    update(id, kind, fn) {
      const cur = map.get(id);
      const next = fn(cur && cur.kind === kind ? cur : emptyDraft(kind));
      put(id, next);
      return next;
    },
    has: (id) => map.has(id),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
