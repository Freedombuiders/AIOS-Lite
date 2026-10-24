/**
 * The thin adapter over the legacy Zalo objects, exercised with structural stand-ins for the session
 * pool, the limiter and the zca-js API object. No real session, no DB, no network.
 */
import { EventEmitter } from 'node:events';
import { ThreadType } from 'zca-js';
import { describe, expect, it } from 'vitest';
import { makeZaloRig } from './zalo-test-kit.js';
import { ZaloCareConnector } from './zalo-connector.js';
import { ZaloTransportError } from './transport.js';
import { ZcaZaloTransport, type ZcaApiLike, type ZcaLimiterLike, type ZcaPoolLike } from './zca-transport.js';

class FakeApi implements ZcaApiLike {
  listener = new EventEmitter() as unknown as ZcaApiLike['listener'] & EventEmitter;
  sent: Array<{ msg: string; threadId: string; type: number }> = [];
  oldRequests: Array<[number, string | null]> = [];
  groupHistory: unknown[] = [];
  sendImpl: () => Promise<{ message?: { msgId?: number | string } | null }> = async () => ({ message: { msgId: '7400000000000000555' } });
  constructor() {
    (this.listener as unknown as { requestOldMessages: unknown }).requestOldMessages = (type: number, cursor: string | null) => {
      this.oldRequests.push([type, cursor]);
    };
  }
  async sendMessage(content: { msg: string }, threadId: string, type: number) {
    this.sent.push({ msg: content.msg, threadId, type });
    return this.sendImpl();
  }
  async getGroupChatHistory() {
    return { groupMsgs: this.groupHistory };
  }
  async getUserInfo(uid: string) {
    return { changed_profiles: { [uid]: { zaloName: 'Chị Hoa' } } };
  }
  async getGroupInfo(id: string) {
    return { gridInfoMap: { [id]: { name: 'Nhóm VIP' } } };
  }
}

function setup(over: { locked?: boolean } = {}) {
  const api = new FakeApi();
  const pool = { api: api as FakeApi | null, status: 'connected', qr: null as { image: string | null; phase: string; error?: string } | null, qrStarts: 0 };
  const poolLike: ZcaPoolLike = {
    getApi: () => pool.api,
    getContext: () => (pool.api ? { ownUid: 'own-uid-1' } : null),
    getLiveStatus: () => pool.status,
    getQrState: () => pool.qr,
    startQrLogin: () => {
      pool.qrStarts += 1;
    },
  };
  const lim = { ok: true, reason: undefined as 'daily' | 'burst' | undefined, used: 0, limit: 1000, retryAfterMs: undefined as number | undefined, queryOk: true, records: 0, consumed: [] as string[] };
  const limiter: ZcaLimiterLike = {
    check: () => ({ ok: lim.ok, reason: lim.reason, used: lim.used, limit: lim.limit, retryAfterMs: lim.retryAfterMs }),
    consume: (_a, cat) => {
      lim.consumed.push(cat);
      return { ok: lim.queryOk };
    },
    record: () => {
      lim.records += 1;
    },
    limitFor: () => ({ daily: lim.limit }),
  };
  const state = { locked: over.locked ?? false, now: 1_700_000_000_000, coreToday: undefined as number | undefined };
  const transport = new ZcaZaloTransport({
    pool: poolLike,
    limiter,
    sendState: () => ({ chatEnabled: !state.locked, sendLockReason: state.locked ? 'auto-lock' : '' }),
    now: () => state.now,
    dayStartMs: (n) => n - (n % 86_400_000),
    ...(state.coreToday !== undefined ? { coreSentToday: () => state.coreToday! } : {}),
  });
  return { api, pool, lim, state, transport };
}

describe('honest features', () => {
  it('cannot quote, mark read or send media today; a locked nick cannot send text', () => {
    const { transport, state } = setup();
    expect(transport.features('a')).toEqual({
      text: true,
      quote: false,
      typing: true,
      markRead: false,
      sendMedia: [],
      fetchMedia: true,
      history: { group: true, directPush: true },
    });
    state.locked = true;
    expect(transport.features('a').text).toBe(false);
    expect(transport.rateStatus('a')).toEqual({ ok: false, reason: 'locked' });
  });
});

describe('send', () => {
  it('goes straight to api.sendMessage with the right thread type, counts the budget first, and returns the id as a string', async () => {
    const { transport, api, lim } = setup();
    const ack = await transport.send('a', { threadId: 'g-1', threadKind: 'group', text: 'hi' });
    expect(ack.msgId).toBe('7400000000000000555');
    expect(api.sent).toEqual([{ msg: 'hi', threadId: 'g-1', type: ThreadType.Group }]);
    await transport.send('a', { threadId: 'u-1', threadKind: 'user', text: 'yo' });
    expect(api.sent[1].type).toBe(ThreadType.User);
    expect(lim.records).toBe(2);
  });

  it('an answer without a message id is returned as such (the connector turns it into uncertain)', async () => {
    const { transport, api } = setup();
    api.sendImpl = async () => ({ message: null });
    expect((await transport.send('a', { threadId: 'u-1', threadKind: 'user', text: 'x' })).msgId).toBeUndefined();
  });

  it.each([
    ['session expired: please login required', 'session_expired'],
    ['Zalo refused [zalo:114]', 'rejected'],
    ['user left the group', 'rejected'],
    ['fetch failed', 'network'],
    ['ECONNRESET', 'network'],
    ['rate limit hit', 'rate_limited'],
    ['something odd', 'unknown'],
  ])('classifies "%s" as %s and does not retry on its own', async (message, kind) => {
    const { transport, api } = setup();
    let calls = 0;
    api.sendImpl = async () => {
      calls += 1;
      throw new Error(message);
    };
    await expect(transport.send('a', { threadId: 'u-1', threadKind: 'user', text: 'x' })).rejects.toMatchObject({ name: 'ZaloTransportError', kind });
    expect(calls).toBe(1); // the legacy sender would retry here; Care must not, the request may have left
  });

  it('refuses before the call when not connected, send-locked or over budget', async () => {
    const s = setup();
    s.pool.api = null;
    await expect(s.transport.send('a', { threadId: 'u', threadKind: 'user', text: 'x' })).rejects.toMatchObject({ kind: 'not_connected' });
    s.pool.api = s.api;
    s.state.locked = true;
    await expect(s.transport.send('a', { threadId: 'u', threadKind: 'user', text: 'x' })).rejects.toMatchObject({ kind: 'send_locked' });
    s.state.locked = false;
    s.lim.ok = false;
    s.lim.reason = 'burst';
    s.lim.retryAfterMs = 12_000;
    await expect(s.transport.send('a', { threadId: 'u', threadKind: 'user', text: 'x' })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 12_000 });
    expect(s.api.sent).toHaveLength(0);
  });

  it('counts what Care itself sent against the daily cap (the legacy count only sees zalo_messages)', async () => {
    const s = setup();
    s.lim.limit = 2;
    s.lim.used = 0;
    expect(s.transport.rateStatus('a').ok).toBe(true);
    await s.transport.send('a', { threadId: 'u', threadKind: 'user', text: '1' });
    expect(s.transport.rateStatus('a').ok).toBe(true);
    await s.transport.send('a', { threadId: 'u', threadKind: 'user', text: '2' });
    const status = s.transport.rateStatus('a');
    expect(status).toMatchObject({ ok: false, reason: 'daily' });
    expect(status.retryAfterMs).toBeGreaterThan(0);
    await expect(s.transport.send('a', { threadId: 'u', threadKind: 'user', text: '3' })).rejects.toBeInstanceOf(ZaloTransportError);
    expect(s.api.sent).toHaveLength(2);
  });
});

describe('live feed over the websocket listener', () => {
  it('buffers messages, history batches and recalls; peek does not consume; ack does; the gap is reported once', () => {
    const { transport, api } = setup();
    const first = transport.peekLive('a', 10);
    expect(first.items).toEqual([]);
    expect(first.gap).toBe(true); // nothing before the first attach is in the buffer
    expect(transport.peekLive('a', 10).gap).toBe(false);

    api.listener.emit('message', { type: ThreadType.User, threadId: 'u-1', isSelf: false, data: { msgId: '1', uidFrom: 'u-1', content: 'a' } });
    api.listener.emit('message', { type: ThreadType.Group, threadId: 'g-1', isSelf: true, data: { msgId: '2' } });
    api.listener.emit('old_messages', [{ threadId: 'u-2', isSelf: false, data: { msgId: '0' } }], ThreadType.User);
    api.listener.emit('undo', { threadId: 'u-1', data: { content: { globalMsgId: '1' } } });

    const page = transport.peekLive('a', 10);
    expect(page.items.map((i) => [i.seq, i.kind])).toEqual([[1, 'message'], [2, 'message'], [3, 'message'], [4, 'undo']]);
    expect(page.items[0]).toMatchObject({ origin: 'live', message: { threadKind: 'user', threadId: 'u-1' } });
    expect(page.items[1]).toMatchObject({ message: { threadKind: 'group', isSelf: true } });
    expect(page.items[2]).toMatchObject({ origin: 'history', message: { threadKind: 'user', threadId: 'u-2' } });
    expect(transport.peekLive('a', 2)).toMatchObject({ hasMore: true });

    transport.ackLive('a', 'wrong-feed', 99);
    expect(transport.peekLive('a', 10).items).toHaveLength(4);
    transport.ackLive('a', page.feedId, 3);
    expect(transport.peekLive('a', 10).items.map((i) => i.seq)).toEqual([4]);
  });

  it('a reconnect (new api object) and a buffer overflow both raise the gap flag', () => {
    const s = setup();
    s.transport.peekLive('a', 1); // attach
    s.transport.peekLive('a', 1);
    const second = new FakeApi();
    s.pool.api = second;
    expect(s.transport.peekLive('a', 1).gap).toBe(true);
    // old listener detached: its events no longer arrive
    s.api.listener.emit('message', { type: 0, threadId: 'x', data: { msgId: '9' } });
    expect(s.transport.peekLive('a', 5).items).toHaveLength(0);

    const small = new ZcaZaloTransport({
      pool: { getApi: () => second, getContext: () => ({ ownUid: 'o' }), getLiveStatus: () => 'connected', getQrState: () => null, startQrLogin: () => {} },
      limiter: s.transport['deps'].limiter,
      sendState: () => null,
      bufferLimit: 2,
    });
    small.peekLive('b', 1);
    small.peekLive('b', 1);
    for (let i = 0; i < 3; i += 1) second.listener.emit('message', { type: 0, threadId: 'x', data: { msgId: String(i + 1) } });
    const page = small.peekLive('b', 10);
    expect(page.items.map((i) => i.seq)).toEqual([2, 3]);
    expect(page.gap).toBe(true);
  });

  it('requestDirectHistory asks the server once through the same listener (batches arrive in the feed)', () => {
    const { transport, api } = setup();
    transport.requestDirectHistory('a', null);
    transport.requestDirectHistory('a', ' 77 ');
    expect(api.oldRequests).toEqual([[ThreadType.User, null], [ThreadType.User, ' 77 ']]);
    api.listener.emit('old_messages', [{ threadId: 'u', data: { msgId: '5' } }], ThreadType.User);
    expect(transport.peekLive('a', 5).items[0]).toMatchObject({ origin: 'history' });
  });
});

describe('history, titles, auth', () => {
  it('reads group history through the group_read budget and maps it to raw messages', async () => {
    const { transport, api, lim } = setup();
    api.groupHistory = [{ isSelf: false, data: { msgId: '5', uidFrom: 'm' } }, { isSelf: true, data: { msgId: '6' } }];
    const raws = await transport.readGroupHistory('a', 'g-1', 50);
    expect(raws.map((r) => [r.threadKind, r.threadId, r.isSelf, r.data.msgId])).toEqual([['group', 'g-1', false, '5'], ['group', 'g-1', true, '6']]);
    expect(lim.consumed).toEqual(['group_read']);
    lim.queryOk = false;
    await expect(transport.readGroupHistory('a', 'g-1', 5)).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('resolves titles within budget and gives up quietly when over it', async () => {
    const { transport, lim } = setup();
    expect(await transport.resolveTitle('a', 'u-1', 'user')).toBe('Chị Hoa');
    expect(await transport.resolveTitle('a', 'g-1', 'group')).toBe('Nhóm VIP');
    expect(lim.consumed).toEqual(['query', 'group_read']);
    lim.queryOk = false;
    expect(await transport.resolveTitle('a', 'u-1', 'user')).toBeNull();
  });

  it('QR login: connected -> authorized; otherwise starts the legacy flow and hands back the image', async () => {
    const s = setup();
    expect(await s.transport.startQrLogin('a')).toMatchObject({ step: 'authorized', nativeAccountId: 'own-uid-1' });
    s.pool.status = 'disconnected';
    s.pool.qr = { image: 'QUJD', phase: 'waiting' };
    expect(await s.transport.startQrLogin('a')).toEqual({ step: 'qr_pending', qr: 'data:image/png;base64,QUJD' });
    expect(s.pool.qrStarts).toBe(1);
    s.pool.qr = { image: null, phase: 'expired' };
    expect(await s.transport.startQrLogin('a')).toMatchObject({ step: 'failed' });
  });

  it('media: size capped, redirects refused, non-2xx is an error', async () => {
    const s = setup();
    const mk = (res: Partial<Response> & { body?: Buffer }) =>
      new ZcaZaloTransport({
        pool: { getApi: () => s.api, getContext: () => null, getLiveStatus: () => 'connected', getQrState: () => null, startQrLogin: () => {} },
        limiter: s.transport['deps'].limiter,
        sendState: () => null,
        fetchImpl: (async (_u: unknown, init: RequestInit) => {
          expect(init.redirect).toBe('error');
          return {
            ok: res.ok ?? true,
            status: res.status ?? 200,
            headers: new Headers(res.headers ?? { 'content-type': 'image/png; charset=x', 'content-length': String(res.body?.length ?? 3) }),
            arrayBuffer: async () => (res.body ?? Buffer.from('abc')).buffer.slice((res.body ?? Buffer.from('abc')).byteOffset),
          } as unknown as Response;
        }) as typeof fetch,
      });
    expect(await mk({}).fetchMedia('a', 'https://f.zdn.vn/x')).toMatchObject({ mimeType: 'image/png' });
    await expect(mk({ ok: false, status: 404 }).fetchMedia('a', 'https://f.zdn.vn/x')).rejects.toBeInstanceOf(ZaloTransportError);
    await expect(mk({ headers: new Headers({ 'content-length': String(30 * 1024 * 1024) }) }).fetchMedia('a', 'https://f.zdn.vn/x')).rejects.toBeInstanceOf(ZaloTransportError);
  });
});

describe('the connector on top of the adapter (end to end, still synthetic)', () => {
  it('accepted ack / network failure / flood map through the same Care semantics', async () => {
    const s = setup();
    const rig = makeZaloRig();
    try {
      const connector = new ZaloCareConnector({
        transport: s.transport,
        getActiveEpoch: () => rig.state.epoch,
        resolveThreadKind: () => 'user',
        now: () => s.state.now,
      });
      const base = {
        kind: 'chat' as const,
        channel: 'zalo' as const,
        accountId: rig.account.id,
        target: { externalConversationKey: 'u-1' },
        purpose: 'care' as const,
        actor: 'manual' as const,
        ownerEpoch: rig.state.epoch,
      };
      const ok = await connector.dispatch({ ...base, clientRequestId: 'e2e-1', text: 'xin chào', adapterRetryToken: 'care-token-e2e-1' });
      expect(ok).toMatchObject({ outcome: 'accepted', nativeMessageId: '7400000000000000555' });

      s.api.sendImpl = async () => {
        throw new Error('fetch failed');
      };
      await expect(connector.dispatch({ ...base, clientRequestId: 'e2e-2', text: 'lần hai', adapterRetryToken: 'care-token-e2e-2' })).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
      // the legacy "retry on network blip" never happens here
      expect(s.api.sent.map((m) => m.msg)).toEqual(['xin chào', 'lần hai']);

      s.api.sendImpl = async () => ({ message: { msgId: '1' } });
      s.lim.ok = false;
      s.lim.reason = 'burst';
      s.lim.retryAfterMs = 20_000;
      const err = await connector.dispatch({ ...base, clientRequestId: 'e2e-3', text: 'ba', adapterRetryToken: 'care-token-e2e-3' }).catch((e) => e);
      expect(err).toMatchObject({ code: 'RATE_LIMITED', details: { retryAtMs: s.state.now + 20_000 } });
    } finally {
      rig.close();
    }
  });
});
