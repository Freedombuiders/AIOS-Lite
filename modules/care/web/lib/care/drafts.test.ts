import { describe, expect, it } from 'vitest';
import { emptyDraft, type ChatDraft, type EmailDraft } from './composer';
import { createDraftStore, DRAFT_STORAGE_KEY, MAX_DRAFTS, type StorageLike } from './drafts';
import { createIntentStore } from './intents';
import { statusChip, upsertIntent, canCancel, canReconcile, isSettled } from './outbox';
import type { CareOutboxIntentDto } from './dto';

class MemStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
}

describe('draft store', () => {
  it('keeps text and email recipients per conversation across switches', () => {
    const s = createDraftStore();
    s.update('c1', 'chat', (d) => ({ ...(d as ChatDraft), text: 'dở dang' }));
    s.update('c2', 'email', (d) => ({ ...(d as EmailDraft), body: 'thư', mode: 'reply_all', removedCc: ['a@b.test'] }));
    expect((s.get('c1', 'chat') as ChatDraft).text).toBe('dở dang');
    const mail = s.get('c2', 'email') as EmailDraft;
    expect(mail.mode).toBe('reply_all');
    expect(mail.removedCc).toEqual(['a@b.test']);
    // a third conversation starts empty: nothing leaks from the previous customer
    expect((s.get('c3', 'chat') as ChatDraft).text).toBe('');
  });

  it('ignores a stored draft of the other kind instead of mis-rendering it', () => {
    const s = createDraftStore();
    s.set('c1', emptyDraft('chat'));
    expect(s.get('c1', 'email').kind).toBe('email');
  });

  it('notifies subscribers and stops after unsubscribe', () => {
    const s = createDraftStore();
    let n = 0;
    const off = s.subscribe(() => { n += 1; });
    s.update('c1', 'chat', (d) => ({ ...(d as ChatDraft), text: 'a' }));
    off();
    s.update('c1', 'chat', (d) => ({ ...(d as ChatDraft), text: 'b' }));
    expect(n).toBe(1);
  });

  it('survives a reload through the storage mirror, keeping the request id for a safe retry', () => {
    const storage = new MemStorage();
    const s = createDraftStore(storage);
    s.update('c1', 'chat', (d) => ({ ...(d as ChatDraft), text: 'chưa gửi', requestId: 'care-9', payloadKey: 'k' }));
    const reloaded = createDraftStore(storage);
    expect(reloaded.get('c1', 'chat')).toMatchObject({ text: 'chưa gửi', requestId: 'care-9' });
  });

  it('empty drafts are not persisted', () => {
    const storage = new MemStorage();
    const s = createDraftStore(storage);
    s.update('c1', 'chat', (d) => d);
    expect(JSON.parse(storage.data.get(DRAFT_STORAGE_KEY) ?? '{}')).toEqual({});
  });

  it('survives corrupt or throwing storage', () => {
    const corrupt = new MemStorage();
    corrupt.setItem(DRAFT_STORAGE_KEY, '{nope');
    expect(() => createDraftStore(corrupt)).not.toThrow();
    const thrower: StorageLike = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
    const s = createDraftStore(thrower);
    expect(() => s.update('c1', 'chat', (d) => ({ ...(d as ChatDraft), text: 'x' }))).not.toThrow();
    expect((s.get('c1', 'chat') as ChatDraft).text).toBe('x');
  });

  it('drops malformed entries from the mirror', () => {
    const storage = new MemStorage();
    storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ ok: { kind: 'chat', text: 'tốt', requestId: null, payloadKey: null }, bad: { kind: 'email', body: 1 }, worse: 7 }));
    const s = createDraftStore(storage);
    expect(s.has('ok')).toBe(true);
    expect(s.has('bad')).toBe(false);
    expect(s.has('worse')).toBe(false);
  });

  it('bounds how many drafts it mirrors', () => {
    const storage = new MemStorage();
    const s = createDraftStore(storage);
    for (let i = 0; i < MAX_DRAFTS + 10; i += 1) s.update(`c${i}`, 'chat', (d) => ({ ...(d as ChatDraft), text: `t${i}` }));
    expect(Object.keys(JSON.parse(storage.data.get(DRAFT_STORAGE_KEY)!))).toHaveLength(MAX_DRAFTS);
  });
});

const intent = (over: Partial<CareOutboxIntentDto> = {}): CareOutboxIntentDto => ({
  id: 'i1', clientRequestId: 'care-1', conversationId: 'c1', accountId: 'a1', status: 'pending', receiptLevel: null, messageId: null,
  retryAtMs: null, errorCode: null, createdAtMs: 1, updatedAtMs: 1, ...over,
});

describe('outbox presentation', () => {
  it('chips say only what the server said', () => {
    expect(statusChip(intent({ status: 'sent' })).labelKey).toBe('sent'); // accepted, not delivered
    expect(statusChip(intent({ status: 'sent', receiptLevel: 'delivered' })).labelKey).toBe('delivered');
    expect(statusChip(intent({ status: 'sent', receiptLevel: 'read' })).labelKey).toBe('read');
    expect(statusChip(intent({ status: 'uncertain' })).tone).toBe('failed');
    expect(statusChip(intent({ status: 'pending' })).labelKey).not.toBe('sent');
  });

  it('actions follow the status', () => {
    expect(canCancel(intent({ status: 'pending' }))).toBe(true);
    expect(canCancel(intent({ status: 'sent' }))).toBe(false);
    expect(canReconcile(intent({ status: 'uncertain' }))).toBe(true);
    expect(isSettled(intent({ status: 'retry_wait' }))).toBe(false);
    expect(isSettled(intent({ status: 'failed' }))).toBe(true);
    expect(statusChip(intent({ status: 'needs_review' })).labelKey).toBe('needsReview');
    expect(isSettled(intent({ status: 'needs_review' }))).toBe(true); // waits for a person: no point polling
  });

  it('a slow poll cannot roll a status back', () => {
    const newer = intent({ status: 'sent', updatedAtMs: 20 });
    expect(upsertIntent([newer], intent({ status: 'sending', updatedAtMs: 10 }))).toEqual([newer]);
  });

  it('the intent store keeps the sent text and polls only open intents', () => {
    const s = createIntentStore();
    s.upsert('c1', intent({ id: 'a', status: 'pending', createdAtMs: 1 }), 'nội dung a');
    s.upsert('c1', intent({ id: 'b', status: 'sent', createdAtMs: 2 }), 'nội dung b');
    s.upsert('c1', intent({ id: 'a', status: 'sending', updatedAtMs: 5, createdAtMs: 1 }));
    expect(s.get('c1').map((t) => [t.intent.id, t.text])).toEqual([['a', 'nội dung a'], ['b', 'nội dung b']]);
    expect(s.open('c1').map((t) => t.intent.id)).toEqual(['a']);
    expect(s.get('other')).toEqual([]);
  });
});
