import { beforeEach, describe, expect, it } from 'vitest';
import type { API } from 'zca-js';
import { createZaloAccount, getZaloThread, insertZaloMessage, updateZaloAccountState, upsertZaloThread } from './store.js';
import { _initTestDatabase } from './test-db.js';
import { threadProfiles } from './profiles.js';

describe('chat avatars', () => {
  beforeEach(() => _initTestDatabase());

  it('resolves group senders even when messages already include their names', async () => {
    const account = createZaloAccount('Nick');
    updateZaloAccountState(account.id, { display_name: 'Tôi', avatar_url: 'https://cdn/me.jpg' });
    const thread = upsertZaloThread({ accountId: account.id, threadType: 'group', externalId: 'group' });
    insertZaloMessage({ threadId: thread.id, zaloMsgId: '1', senderUid: 'customer', senderName: 'An', senderType: 'customer', body: 'Chào', contentType: 'text', origin: 'live', sentAtMs: Date.now() });
    const api = {
      getGroupInfo: async () => ({ gridInfoMap: { group: { name: 'Nhóm', avt: 'https://cdn/group.jpg' } } }),
      getUserInfo: async () => ({ changed_profiles: { customer: { zaloName: 'An', avatar: 'https://cdn/an.jpg' } } }),
    } as unknown as API;
    const result = await threadProfiles({ accountId: account.id, ownUid: 'me', api }, thread.id);
    expect(result.thread).toEqual({ name: 'Nhóm', avatarUrl: 'https://cdn/group.jpg' });
    expect(result.senders.customer.avatarUrl).toBe('https://cdn/an.jpg');
    expect(result.senders.me.avatarUrl).toBe('https://cdn/me.jpg');
    expect(getZaloThread(thread.id)?.avatar_url).toBe('https://cdn/group.jpg');
  });

  it('uses stored direct-chat avatars while offline and rejects another account’s thread', async () => {
    const account = createZaloAccount('Nick');
    const thread = upsertZaloThread({ accountId: account.id, threadType: 'user', externalId: 'an', name: 'An', avatarUrl: 'https://cdn/an.jpg' });
    const ctx = { accountId: account.id, ownUid: 'me', api: {} as API };
    expect((await threadProfiles(ctx, thread.id)).senders.an.avatarUrl).toBe('https://cdn/an.jpg');
    await expect(threadProfiles({ ...ctx, accountId: 'other' }, thread.id)).rejects.toThrow('Không tìm thấy');
  });

  it('preserves existing data when lookup budgets are exhausted', async () => {
    const account = createZaloAccount('Nick');
    const thread = upsertZaloThread({ accountId: account.id, threadType: 'group', externalId: 'missing', name: 'Tên đã lưu' });
    const ctx = { accountId: account.id, ownUid: 'me', api: {} as API, limiter: { consume: () => ({ ok: false }) } };
    const result = await threadProfiles(ctx as unknown as Parameters<typeof threadProfiles>[0], thread.id);
    expect(result.thread.name).toBe('Tên đã lưu');
  });
});
