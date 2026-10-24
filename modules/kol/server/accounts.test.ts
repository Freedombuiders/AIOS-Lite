import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ personas: new Map<string, unknown>(), hasKey: true }));

vi.mock('./personas.js', async () => {
  const { KolError } = await import('./core.js');
  return {
    getPersona: (id: string) => h.personas.get(id) ?? null,
    requirePersona: (id: string) => {
      const p = h.personas.get(id);
      if (!p) throw new KolError(404, 'Không tìm thấy KOL.');
      return p;
    },
    listPersonaIds: () => [...h.personas.keys()],
  };
});
vi.mock('../../_lib/composio.js', async (orig) => ({ ...(await orig<typeof import('../../_lib/composio.js')>()), hasComposioKey: () => h.hasKey }));

import { _initTestDatabase, addFbPage, setFbPage } from './test-db.js';
import {
  deleteAccount,
  linkAccount,
  listAccounts,
  listKolConnections,
  refreshAccount,
  setPublishNotifier,
  tiktokPrivacyChoice,
  updateAccount,
  _resetAccountsState,
} from './accounts.js';
import { _setConnectionLister, _setToolExecutor, type ComposioConnection, type ToolExecutor } from './composio-exec.js';
import { kolDb } from './core.js';
import type { PersonaDto } from './types.js';

const T0 = Date.UTC(2026, 9, 20, 5, 0, 0) / 1000;

let notes: string[];
let calls: { slug: string; args: Record<string, unknown>; target: unknown }[];
let connections: ComposioConnection[];

function script(map: Record<string, (args: Record<string, unknown>) => unknown>): void {
  const exec: ToolExecutor = async (slug, args, target) => {
    calls.push({ slug, args, target });
    const fn = map[slug];
    if (!fn) throw new Error(`unexpected tool ${slug}`);
    return fn(args);
  };
  _setToolExecutor(exec);
}

const conn = (id: string, toolkit: string, status = 'ACTIVE'): ComposioConnection => ({ id, toolkit, status, alias: null, entityId: `user-${id}`, authConfigId: 'ac' });

beforeEach(() => {
  _initTestDatabase();
  _resetAccountsState();
  h.personas.clear();
  h.personas.set('p1', { id: 'p1', name: 'Mai' } as PersonaDto);
  h.hasKey = true;
  notes = [];
  calls = [];
  connections = [conn('ca_ig', 'instagram'), conn('ca_yt', 'youtube'), conn('ca_tt', 'tiktok'), conn('ca_old', 'instagram', 'EXPIRED')];
  _setConnectionLister(async (toolkit) => connections.filter((c) => c.toolkit === toolkit));
  setPublishNotifier(async (t) => { notes.push(t); });
  vi.useFakeTimers();
  vi.setSystemTime(T0 * 1000);
});

afterEach(() => {
  _setToolExecutor(null);
  _setConnectionLister(null);
  setPublishNotifier(null);
  vi.useRealTimers();
});

describe('connections', () => {
  it('composio false without a key; ACTIVE first otherwise', async () => {
    h.hasKey = false;
    expect(await listKolConnections()).toEqual({ composio: false, connections: [] });
    h.hasKey = true;
    const out = await listKolConnections();
    expect(out.composio).toBe(true);
    expect(out.connections.map((c) => `${c.toolkit}:${c.status}`)).toEqual(['instagram:ACTIVE', 'tiktok:ACTIVE', 'youtube:ACTIVE', 'instagram:EXPIRED']);
  });
});

describe('linking', () => {
  it('Instagram Business: identity from INSTAGRAM_GET_USER_INFO, followers recorded for the local day', async () => {
    script({ INSTAGRAM_GET_USER_INFO: () => ({ data: { id: 'app-scoped-9', user_id: '1784', username: 'mai.ai', name: 'Mai', account_type: 'BUSINESS', profile_picture_url: 'https://pic', followers_count: 1200 } }) });
    const a = await linkAccount('p1', { platform: 'instagram', connectionId: 'ca_ig' });
    expect(a).toMatchObject({ platform: 'instagram', externalId: '1784', handle: '@mai.ai', displayName: 'Mai', pictureUrl: 'https://pic', followers: 1200, status: 'ACTIVE', timezone: 'Asia/Ho_Chi_Minh' });
    expect(calls[0]).toMatchObject({ args: { ig_user_id: 'me', fields: expect.stringContaining('account_type') }, target: { connectionId: 'ca_ig', entityId: 'user-ca_ig' } });
    expect(kolDb().prepare('SELECT day, followers FROM kol_account_daily').all()).toEqual([{ day: '2026-10-20', followers: 1200 }]);
    await expect(linkAccount('p1', { platform: 'instagram', connectionId: 'ca_ig' })).rejects.toMatchObject({ status: 409 });
  });

  it('Instagram personal account is refused with an explanation', async () => {
    script({ INSTAGRAM_GET_USER_INFO: () => ({ id: '1', username: 'me', account_type: 'PERSONAL' }) });
    await expect(linkAccount('p1', { platform: 'instagram', connectionId: 'ca_ig' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Business hoặc Creator') });
  });

  it('refuses unknown or inactive connections', async () => {
    await expect(linkAccount('p1', { platform: 'instagram', connectionId: 'ca_old' })).rejects.toMatchObject({ status: 409 });
    await expect(linkAccount('p1', { platform: 'instagram', connectionId: 'nope' })).rejects.toMatchObject({ status: 404 });
    await expect(linkAccount('ghost', { platform: 'instagram', connectionId: 'ca_ig' })).rejects.toMatchObject({ status: 404 });
  });

  it('YouTube: channel id, handle and subscribers', async () => {
    script({ YOUTUBE_GET_CHANNEL_STATISTICS: () => ({ items: [{ id: 'UC123', snippet: { title: 'Mai TV', customUrl: '@maitv', thumbnails: { default: { url: 'https://t' } } }, statistics: { subscriberCount: '5400' } }] }) });
    const a = await linkAccount('p1', { platform: 'youtube', connectionId: 'ca_yt' });
    expect(a).toMatchObject({ externalId: 'UC123', handle: '@maitv', displayName: 'Mai TV', followers: 5400, youtubePrivacy: 'public', youtubeCategory: '22' });
    expect(calls[0].args).toEqual({ mine: true, part: 'snippet,statistics' });
  });

  it('one channel can serve several KOLs: the second starts with the first one\'s rules, channel rules stay in sync', async () => {
    h.personas.set('p2', { id: 'p2', name: 'Tony' } as PersonaDto);
    const addPersona = kolDb().prepare('INSERT INTO kol_personas (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)');
    addPersona.run('p1', 'Mai', T0, T0);
    addPersona.run('p2', 'Tony', T0, T0);
    script({ YOUTUBE_GET_CHANNEL_STATISTICS: () => ({ items: [{ id: 'UC123', snippet: { title: 'Mai TV' }, statistics: { subscriberCount: '5400' } }] }) });
    const first = await linkAccount('p1', { platform: 'youtube', connectionId: 'ca_yt' });
    await updateAccount(first.id, { youtubePrivacy: 'unlisted', maxPostsPerDay: 1, enabled: false });

    const second = await linkAccount('p2', { platform: 'youtube', connectionId: 'ca_yt' });
    expect(second).toMatchObject({ externalId: 'UC123', youtubePrivacy: 'unlisted', maxPostsPerDay: 1, enabled: true, sharedWith: ['Mai'] });
    expect(listAccounts('p1')[0].sharedWith).toEqual(['Tony']);
    await expect(linkAccount('p2', { platform: 'youtube', connectionId: 'ca_yt' })).rejects.toMatchObject({ status: 409 });

    await updateAccount(second.id, { minGapMinutes: 240, autoPublish: true });
    expect(listAccounts('p1')[0]).toMatchObject({ minGapMinutes: 240, autoPublish: false, enabled: false });

    deleteAccount(second.id);
    expect(listAccounts('p1')[0].sharedWith).toEqual([]);
  });

  it('TikTok: creator info, privacy options kept to validate later changes', async () => {
    script({
      TIKTOK_QUERY_CREATOR_INFO: () => ({ data: { creator_username: 'mai.tt', creator_nickname: 'Mai', privacy_level_options: ['SELF_ONLY'] } }),
      TIKTOK_GET_USER_STATS: () => ({ data: { user: { open_id: 'open-1', follower_count: 77 } } }),
    });
    const a = await linkAccount('p1', { platform: 'tiktok', connectionId: 'ca_tt' });
    expect(a).toMatchObject({ externalId: 'open-1', handle: '@mai.tt', followers: 77, tiktokPrivacy: 'SELF_ONLY' });
    await expect(updateAccount(a.id, { tiktokPrivacy: 'PUBLIC_TO_EVERYONE' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('SELF_ONLY') });
    expect(tiktokPrivacyChoice('PUBLIC_TO_EVERYONE', ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'])).toBe('PUBLIC_TO_EVERYONE');
    expect(tiktokPrivacyChoice('PUBLIC_TO_EVERYONE', ['FOLLOWER_OF_CREATOR'])).toBe('FOLLOWER_OF_CREATOR');
  });

  it('Facebook: needs a synced and enabled Content Studio Page', async () => {
    await expect(linkAccount('p1', { platform: 'facebook', connectionId: '', externalId: 'page1' })).rejects.toMatchObject({ status: 404, message: expect.stringContaining('Marketing › Pages') });
    addFbPage({ id: 'page1', entity_id: 'u9', enabled: 0, timezone: 'Asia/Bangkok', followers: 900 });
    await expect(linkAccount('p1', { platform: 'facebook', connectionId: '', externalId: 'page1' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('chưa được bật') });
    setFbPage('page1', { enabled: 1 });
    const a = await linkAccount('p1', { platform: 'facebook', connectionId: '', externalId: 'page1' });
    expect(a).toMatchObject({ externalId: 'page1', connectionId: 'ca_fb', handle: 'Mai Page', followers: 900, timezone: 'Asia/Bangkok' });
    expect(calls).toEqual([]);
  });
});

describe('update / refresh / delete', () => {
  async function ig() {
    script({ INSTAGRAM_GET_USER_INFO: () => ({ id: '1784', username: 'mai.ai', account_type: 'MEDIA_CREATOR', followers_count: 1000 }) });
    return linkAccount('p1', { platform: 'instagram', connectionId: 'ca_ig' });
  }

  it('validates posting rules', async () => {
    const a = await ig();
    expect(await updateAccount(a.id, { windowStart: '7:30', windowEnd: '21:00', maxPostsPerDay: 3, minGapMinutes: 90, timezone: 'Asia/Tokyo', enabled: false })).toMatchObject({
      windowStart: '07:30', windowEnd: '21:00', maxPostsPerDay: 3, minGapMinutes: 90, timezone: 'Asia/Tokyo', enabled: false,
    });
    await expect(updateAccount(a.id, { windowStart: '25:00' })).rejects.toMatchObject({ status: 400 });
    await expect(updateAccount(a.id, { timezone: 'Mars/Base' })).rejects.toMatchObject({ status: 400 });
    await expect(updateAccount(a.id, { maxPostsPerDay: 99 })).rejects.toMatchObject({ status: 400 });
    await expect(updateAccount(a.id, { externalId: 'other' })).rejects.toMatchObject({ status: 400 });
    expect(listAccounts('p1')).toHaveLength(1);
  });

  it('refresh updates followers; an expired connection marks EXPIRED and notifies once', async () => {
    const a = await ig();
    script({ INSTAGRAM_GET_USER_INFO: () => ({ id: '1784', username: 'mai.ai', account_type: 'BUSINESS', followers_count: 1100 }) });
    vi.setSystemTime((T0 + 86_400) * 1000);
    expect((await refreshAccount(a.id, T0 + 86_400)).followers).toBe(1100);
    expect(kolDb().prepare('SELECT day, followers FROM kol_account_daily ORDER BY day').all()).toEqual([
      { day: '2026-10-20', followers: 1000 }, { day: '2026-10-21', followers: 1100 },
    ]);
    script({ INSTAGRAM_GET_USER_INFO: () => { throw new Error('Error validating access token: Session has expired'); } });
    await expect(refreshAccount(a.id)).rejects.toMatchObject({ status: 409 });
    await expect(refreshAccount(a.id)).rejects.toMatchObject({ status: 409 });
    expect(listAccounts('p1')[0].status).toBe('EXPIRED');
    expect(notes).toHaveLength(1);
    // Choosing a fresh connection makes it ACTIVE again.
    connections.push(conn('ca_ig2', 'instagram'));
    expect((await updateAccount(a.id, { connectionId: 'ca_ig2' })).status).toBe('ACTIVE');
  });

  it('delete skips waiting targets and is refused while publishing', async () => {
    const a = await ig();
    kolDb().prepare(`INSERT INTO kol_posts (id, persona_id, status, scheduled_at, created_at, updated_at) VALUES ('post1', 'p1', 'scheduled', ?, ?, ?)`).run(T0 + 600, T0, T0);
    kolDb().prepare(`INSERT INTO kol_post_targets (id, post_id, account_id, platform, status, updated_at) VALUES ('t1', 'post1', ?, 'instagram', 'publishing', ?)`).run(a.id, T0);
    expect(() => deleteAccount(a.id)).toThrow(/đang có bài/);
    kolDb().prepare(`UPDATE kol_post_targets SET status = 'scheduled'`).run();
    expect(deleteAccount(a.id)).toEqual(['post1']);
    expect(kolDb().prepare('SELECT status FROM kol_post_targets').get()).toEqual({ status: 'skipped' });
    expect(listAccounts('p1')).toEqual([]);
  });
});
