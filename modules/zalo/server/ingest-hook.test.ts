// The chat core knows nothing about birthdays: a fresh 1-1 profile is handed to the optional `onContactSeen` hook.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadType } from 'zca-js';

import { ingestMessage, type IngestContext } from './ingest.js';
import { createZaloAccount, getZaloThread } from './store.js';
import { _initTestDatabase } from './test-db.js';

function ctxFor(accountId: string, uid: string, extra: Partial<IngestContext> = {}): IngestContext {
  const api = { getUserInfo: vi.fn(async () => ({ changed_profiles: { [uid]: { zaloName: 'An', sdob: '10/03/1990' } } })) };
  return { accountId, ownUid: 'me', api, ...extra } as unknown as IngestContext;
}

const message = (uid: string, id: string) => ({
  type: ThreadType.User, threadId: uid, isSelf: false,
  data: { uidFrom: uid, msgId: id, cliMsgId: id, msgType: 'webchat', content: 'chào shop', ts: String(Date.now()), dName: 'An' },
});

describe('ingest contact hook', () => {
  let accountId: string;
  beforeEach(() => {
    _initTestDatabase();
    accountId = createZaloAccount('Nick').id;
  });

  it('stores the message and calls onContactSeen with the thread and the fresh profile', async () => {
    const seen = vi.fn();
    const ctx = ctxFor(accountId, 'hook-u1', { onContactSeen: seen });
    const res = await ingestMessage(ctx, message('hook-u1', 'm1') as never, 'live');
    expect(res).toMatchObject({ senderType: 'customer' });
    expect(seen).toHaveBeenCalledTimes(1);
    const [thread, profile] = seen.mock.calls[0]!;
    expect(thread.id).toBe(res!.thread.id);
    expect(profile).toMatchObject({ sdob: '10/03/1990' });
  });

  it('works without a hook, and a throwing hook never loses the message', async () => {
    const plain = await ingestMessage(ctxFor(accountId, 'hook-u2'), message('hook-u2', 'm2') as never, 'live');
    expect(plain).toBeTruthy();
    const boom = ctxFor(accountId, 'hook-u3', { onContactSeen: () => { throw new Error('boom'); } });
    const res = await ingestMessage(boom, message('hook-u3', 'm3') as never, 'live');
    expect(res).toBeTruthy();
    expect(getZaloThread(res!.thread.id)).toBeTruthy();
  });
});
