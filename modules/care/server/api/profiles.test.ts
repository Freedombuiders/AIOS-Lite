import { afterEach, describe, expect, it } from 'vitest';
import type { CareConnectorExt, CareConnectorProfiles, ConnectorRegistry } from '../connectors/registry.js';
import { chatMessage, createEligibleAccount, emailMessage } from '../test-fixtures.js';
import type { CareConversationDto, CareConversationListDto, CareConversationProfilesDto, CareMessagePageDto } from './dto.js';
import { makeFileApi } from './test-helpers.js';

let api: ReturnType<typeof makeFileApi> | null = null;
afterEach(() => {
  api?.close();
  api = null;
});
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const T0 = 1_700_000_000_000;
const GROUP = { type: 'chat', conversationKind: 'group' } as const;

/** A Zalo-like connector that knows names/avatars; `calls` records what Care asked for. */
function fakeConnector(answer: CareConnectorProfiles | null | Error, stored: Record<string, string> = {}) {
  const calls: Array<{ key: string; senders: string[] }> = [];
  const connector = {
    kind: 'fake',
    channel: 'zalo',
    async profiles(_accountId: string, key: string, senders: string[]) {
      calls.push({ key, senders });
      if (answer instanceof Error) throw answer;
      return answer;
    },
    storedAvatarUrl: (_accountId: string, key: string) => stored[key] ?? null,
  } as unknown as CareConnectorExt;
  const registry: ConnectorRegistry = { forAccount: (a) => (a.channel === 'zalo' ? connector : null) };
  return { registry, calls };
}

function setup(connectors?: ConnectorRegistry) {
  const a = makeFileApi(connectors ? { connectors } : {});
  api = a;
  const zalo = createEligibleAccount(a.stores, { channel: 'zalo', nativeAccountId: 'zalo-P' });
  const mail = createEligibleAccount(a.stores, { channel: 'email', connectorKind: 'gmail', nativeAccountId: 'shop@example.com' });
  const chat = (key: string, conv: string, id: string, at: number, over: Record<string, unknown> = {}) =>
    a.put(chatMessage(zalo, { senderIdentityKey: key, externalConversationKey: conv, nativeMessageId: id, sentAtMs: at, text: `text ${id}`, ...over })).messageId!;
  const conv = (key: string) => a.stores.conversations.getConversationByExternalKey(zalo.id, key)!;
  return { a, zalo, mail, chat, conv };
}

describe('GET /conversations/:id/profiles', () => {
  it('maps the connector answer onto sender identities and names a 1-1 chat after its title when the channel has no name', async () => {
    const f = fakeConnector({
      thread: { name: '', avatarUrl: 'https://s120-ava-talk.zadn.vn/an.jpg' },
      senders: { '111': { name: 'Toàn Trần', avatarUrl: 'https://s120-ava-talk.zadn.vn/an.jpg' }, '999': { name: 'Not asked', avatarUrl: '' } },
    });
    const w = setup(f.registry);
    w.chat('111', '111', 'd1', T0);
    const direct = w.conv('111');
    w.a.stores.conversations.upsertConversation({ accountId: w.zalo.id, externalKey: '111', kind: 'direct', title: 'Toàn Trần' });

    const res = await w.a.get(`/api/m/care/conversations/${direct.id}/profiles`);
    expect(res.status).toBe(200);
    const body = await json<CareConversationProfilesDto>(res);
    const identity = w.a.stores.identities.getIdentityByExternal(w.zalo.id, 'user', '111')!;
    expect(body).toEqual({
      thread: { name: 'Toàn Trần', avatarUrl: 'https://s120-ava-talk.zadn.vn/an.jpg' },
      senders: { [identity.id]: { name: 'Toàn Trần', avatarUrl: 'https://s120-ava-talk.zadn.vn/an.jpg' } },
    });
    expect(f.calls).toEqual([{ key: '111', senders: ['111'] }]);
    expect(JSON.stringify(body)).not.toContain('Not asked');
  });

  it('asks for the recent customer senders of a group and drops non-https pictures', async () => {
    const f = fakeConnector({
      thread: { name: 'Nhóm khách', avatarUrl: 'javascript:alert(1)' },
      senders: { a: { name: 'An', avatarUrl: 'http://cdn.example/a.jpg' }, b: { name: '', avatarUrl: '' } },
    });
    const w = setup(f.registry);
    w.chat('a', 'g:1', 'g1', T0, { metadata: GROUP });
    w.chat('b', 'g:1', 'g2', T0 + 1, { metadata: GROUP });
    w.chat('a', 'g:1', 'g3', T0 + 2, { metadata: GROUP });
    w.chat('me', 'g:1', 'g4', T0 + 3, { metadata: GROUP, direction: 'out', senderRole: 'self', senderIdentityKey: null });

    const body = await json<CareConversationProfilesDto>(await w.a.get(`/api/m/care/conversations/${w.conv('g:1').id}/profiles`));
    const an = w.a.stores.identities.getIdentityByExternal(w.zalo.id, 'user', 'a')!;
    expect(f.calls[0].senders).toEqual(['a', 'b']); // newest first, each once, customers only
    expect(body).toEqual({ thread: { name: 'Nhóm khách', avatarUrl: '' }, senders: { [an.id]: { name: 'An', avatarUrl: '' } } });
  });

  it('is a 404 without a connector hook, for an unknown conversation, and when the connector answers null or throws', async () => {
    const statusWith = async (registry: ConnectorRegistry | undefined): Promise<number> => {
      const w = setup(registry);
      w.chat('1', '1', 'x1', T0);
      const status = (await w.a.get(`/api/m/care/conversations/${w.conv('1').id}/profiles`)).status;
      w.a.close();
      api = null;
      return status;
    };
    expect(await statusWith(undefined)).toBe(404);
    expect(await statusWith(fakeConnector(null).registry)).toBe(404);
    expect(await statusWith(fakeConnector(new Error('daemon down')).registry)).toBe(404);

    const w = setup(fakeConnector({ thread: { name: 'X', avatarUrl: '' }, senders: {} }).registry);
    w.chat('1', '1', 'x1', T0);
    expect((await w.a.get('/api/m/care/conversations/nope/profiles')).status).toBe(404);
    w.a.gate.canRead = false; // the module read gate closes this route like every other
    expect((await w.a.get(`/api/m/care/conversations/${w.conv('1').id}/profiles`)).status).toBe(403);
  });
});

describe('conversation rows carry the stored picture', () => {
  it('list and single view take it from the connector, https only, chat only', async () => {
    const f = fakeConnector(null, { '1': 'https://s120-ava-talk.zadn.vn/1.jpg', '2': 'http://insecure.example/2.jpg' });
    const w = setup(f.registry);
    w.chat('1', '1', 'a1', T0);
    w.chat('2', '2', 'a2', T0 + 1);
    w.a.put(emailMessage(w.mail, { senderIdentityKey: 'b@example.com', externalConversationKey: '1', nativeMessageId: 'm1', sentAtMs: T0 + 2 }));

    const rows = (await json<CareConversationListDto>(await w.a.get('/api/m/care/conversations'))).items;
    const byKey = (acct: string, key: string) => rows.find((r) => r.id === w.a.stores.conversations.getConversationByExternalKey(acct, key)!.id)!;
    expect(byKey(w.zalo.id, '1').avatarUrl).toBe('https://s120-ava-talk.zadn.vn/1.jpg');
    expect(byKey(w.zalo.id, '2')).not.toHaveProperty('avatarUrl');
    expect(byKey(w.mail.id, '1')).not.toHaveProperty('avatarUrl');
    const one = await json<CareConversationDto>(await w.a.get(`/api/m/care/conversations/${w.conv('1').id}`));
    expect(one.avatarUrl).toBe('https://s120-ava-talk.zadn.vn/1.jpg');
  });
});

describe('group sender names', () => {
  it('fall back to the display name the channel sent with the message, never a native id', async () => {
    const w = setup();
    const sent = (name: string) => ({ ...GROUP, rawEnvelope: { connector: 'zalo', senderName: name, senderUid: 'x' } });
    w.chat('u1', 'g:2', 'n1', T0, { metadata: sent(' Chị Lan ') });
    w.chat('u2', 'g:2', 'n2', T0 + 1, { metadata: sent('u2') });
    w.chat('u3', 'g:2', 'n3', T0 + 2, { metadata: GROUP });
    w.chat('u4', 'peer:u4', 'n4', T0 + 3, { metadata: { type: 'chat', conversationKind: 'direct', rawEnvelope: { senderName: 'Direct' } } });

    const page = await json<CareMessagePageDto>(await w.a.get(`/api/m/care/conversations/${w.conv('g:2').id}/messages`));
    expect(page.items.map((m) => [m.text, m.senderName])).toEqual([
      ['text n3', null],
      ['text n2', null],
      ['text n1', 'Chị Lan'],
    ]);
    expect(JSON.stringify(page)).not.toContain('rawEnvelope');
    const direct = await json<CareMessagePageDto>(await w.a.get(`/api/m/care/conversations/${w.conv('peer:u4').id}/messages`));
    expect(direct.items[0].senderName).toBeNull();
  });
});
