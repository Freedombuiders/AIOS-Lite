import { beforeEach, describe, expect, it } from 'vitest';
import { CARE_PROFILES_TTL_MS, createCareProfiles } from './care-profiles.js';
import type { ZaloPeople } from './connectors/zalo/zalo-connector.js';
import { createZaloAccount, upsertZaloThread } from './store.js';
import { _initTestDatabase } from './test-db.js';

describe('names and avatars for the Care inbox', () => {
  beforeEach(() => _initTestDatabase());

  it('merges the daemon answer over the stored rows and keeps it for a while', async () => {
    const account = createZaloAccount('Nick');
    const group = upsertZaloThread({ accountId: account.id, threadType: 'group', externalId: 'g1', name: 'Nhóm', avatarUrl: 'https://cdn/g-old.jpg' });
    upsertZaloThread({ accountId: account.id, threadType: 'user', externalId: 'binh', name: 'Bình', avatarUrl: 'https://cdn/binh.jpg' });
    const clock = { now: 1_000 };
    const asked: number[] = [];
    const people = createCareProfiles({
      now: () => clock.now,
      resolve: async (threadId) => {
        asked.push(threadId);
        return { thread: { name: '', avatarUrl: 'https://cdn/g.jpg' }, senders: { an: { name: 'An', avatarUrl: 'https://cdn/an.jpg' }, me: { name: 'Tôi', avatarUrl: '' } } };
      },
    });

    const first = await people.profiles(account.id, 'g1', ['an', 'binh', 'ghost']);
    expect(first).toEqual({
      thread: { name: 'Nhóm', avatarUrl: 'https://cdn/g.jpg' },
      senders: { an: { name: 'An', avatarUrl: 'https://cdn/an.jpg' }, binh: { name: 'Bình', avatarUrl: 'https://cdn/binh.jpg' } },
    });
    await people.profiles(account.id, 'g1', ['an']);
    expect(asked).toEqual([group.id]); // the second call is served from memory
    clock.now += CARE_PROFILES_TTL_MS;
    await people.profiles(account.id, 'g1', ['an']);
    expect(asked).toEqual([group.id, group.id]);
  });

  it('answers from the stored rows without the daemon, keeps an expired answer over none, and knows nothing of other threads', async () => {
    const account = createZaloAccount('Nick');
    upsertZaloThread({ accountId: account.id, threadType: 'user', externalId: 'toan', name: 'Toàn Trần', avatarUrl: 'https://cdn/toan.jpg' });
    let answer: ZaloPeople | null = null;
    const clock = { now: 1_000 };
    const people = createCareProfiles({ now: () => clock.now, resolve: async () => answer });

    expect(await people.profiles(account.id, 'toan', ['toan'])).toEqual({
      thread: { name: 'Toàn Trần', avatarUrl: 'https://cdn/toan.jpg' },
      senders: { toan: { name: 'Toàn Trần', avatarUrl: 'https://cdn/toan.jpg' } },
    });
    expect(people.storedAvatarUrl(account.id, 'toan')).toBe('https://cdn/toan.jpg');

    answer = { thread: { name: 'Toàn', avatarUrl: 'https://cdn/new.jpg' }, senders: {} };
    expect((await people.profiles(account.id, 'toan', []))?.thread.avatarUrl).toBe('https://cdn/new.jpg');
    answer = null;
    clock.now += CARE_PROFILES_TTL_MS;
    expect((await people.profiles(account.id, 'toan', []))?.thread).toEqual({ name: 'Toàn', avatarUrl: 'https://cdn/new.jpg' });

    expect(await people.profiles(account.id, 'nobody', [])).toBeNull();
    expect(await people.profiles('other-account', 'toan', [])).toBeNull();
    expect(people.storedAvatarUrl(account.id, 'nobody')).toBeNull();
  });
});
