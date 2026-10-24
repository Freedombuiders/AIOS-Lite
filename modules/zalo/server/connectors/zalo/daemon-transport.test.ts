/**
 * The main-process client of the Zalo daemon, wired loopback to the real Care control routes (no socket):
 * ZaloCareConnector -> DaemonZaloTransport -> control.ts hop -> daemon-care routes -> ZcaZaloTransport -> fake zca-js.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonZaloTransport } from './daemon-transport.js';
import { makeDaemonWorld, type DaemonWorld } from './daemon-test-kit.js';
import { ZaloCareConnector } from './zalo-connector.js';
import { cmd, expectCode, makeZaloRig, resume, type ZaloRig } from './zalo-test-kit.js';

let rig: ZaloRig;
let w: DaemonWorld;
afterEach(() => rig?.close());

function setup() {
  w = makeDaemonWorld();
  rig = makeZaloRig();
  // The Care account of the rig maps to the daemon's `zalo-1`.
  const transport = new DaemonZaloTransport({ call: w.call, zaloAccountIdOf: () => 'zalo-1', now: () => rig.clock.t });
  const connector = new ZaloCareConnector({
    transport,
    getActiveEpoch: () => rig.state.epoch,
    now: () => rig.clock.t,
    resolveThreadKind: () => 'user',
  });
  return { transport, connector };
}

describe('send over the control channel', () => {
  it('accepted ack, the daemon saw the attempt identity, exactly one RPC', async () => {
    const { connector } = setup();
    const c = cmd(rig, { target: { externalConversationKey: 'u-1' } });
    const res = await connector.dispatch(c);
    expect(res).toMatchObject({ outcome: 'accepted', nativeMessageId: '7400000000000000001' });
    expect(w.api.sent).toEqual([{ msg: c.text, threadId: 'u-1', type: 0 }]);
    expect(w.state.gateCalls).toEqual([{ zid: 'zalo-1', epoch: rig.state.epoch, actor: 'manual' }]);
  });

  it('the daemon refusing ownership is a definite failure: legacy-owned -> SEND_DISABLED, stale epoch -> FENCING_REJECTED', async () => {
    const { connector } = setup();
    w.state.owner = 'legacy';
    const denied = await expectCode(() => connector.dispatch(cmd(rig, { target: { externalConversationKey: 'u-1' } })), 'SEND_DISABLED');
    expect(denied.status).toBe(409);
    w.state.owner = 'core';
    w.state.epoch = 9; // the daemon's gate has moved on, the connector still believes in epoch 1
    await expectCode(() => connector.dispatch(cmd(rig, { target: { externalConversationKey: 'u-1' } })), 'FENCING_REJECTED');
    expect(w.api.sent).toHaveLength(0);
  });

  it('daemon not running / refused connection: definite, nothing sent, the same request can go later', async () => {
    const { connector } = setup();
    const c = cmd(rig, { target: { externalConversationKey: 'u-1' } });
    w.fault.mode = 'not-running';
    await expectCode(() => connector.dispatch(c), 'SEND_DISABLED');
    w.fault.mode = 'refused';
    await expectCode(() => connector.dispatch(c), 'SEND_DISABLED');
    w.fault.mode = 'none';
    expect((await connector.dispatch(c)).outcome).toBe('accepted');
    expect(w.api.sent).toHaveLength(1);
  });

  it('a timeout after the daemon processed the send is UNCERTAIN, never retried, and reconcile finds the daemon ledger', async () => {
    const { connector } = setup();
    const c = cmd(rig, { target: { externalConversationKey: 'u-1' } });
    w.fault.mode = 'abort-after-processing';
    expect((await expectCode(() => connector.dispatch(c), 'NETWORK_TIMEOUT')).status).toBe(504);
    w.fault.mode = 'none';
    await expectCode(() => connector.dispatch(c), 'UNRESOLVED_UNCERTAINTY');
    expect(w.api.sent).toHaveLength(1);

    // a new process (no connector ledger) still gets hard evidence from the daemon
    const restarted = new ZaloCareConnector({
      transport: new DaemonZaloTransport({ call: w.call, zaloAccountIdOf: () => 'zalo-1' }),
      getActiveEpoch: () => rig.state.epoch,
      resolveThreadKind: () => 'user',
    });
    const res = await restarted.reconcile({ clientRequestId: c.clientRequestId, accountId: rig.account.id, ownerEpoch: rig.state.epoch });
    expect(res).toMatchObject({ outcome: 'accepted', nativeMessageId: '7400000000000000001' });
    expect(w.api.sent).toHaveLength(1);
  });

  it('a request the daemon never saw (timeout before processing) reconciles to uncertain, not to failed', async () => {
    const { connector } = setup();
    const c = cmd(rig, { target: { externalConversationKey: 'u-1' } });
    w.fault.mode = 'abort-before-processing';
    await expectCode(() => connector.dispatch(c), 'NETWORK_TIMEOUT'); // the client cannot tell: uncertain
    w.fault.mode = 'none';
    expect((await connector.reconcile({ clientRequestId: c.clientRequestId, accountId: rig.account.id, ownerEpoch: rig.state.epoch })).outcome).toBe('uncertain');
    expect(w.api.sent).toHaveLength(0);
  });

  it('flood / budget from the daemon becomes RATE_LIMITED with the retry time; 5xx during send is uncertain', async () => {
    const { connector } = setup();
    w.limiter.ok = false;
    w.limiter.reason = 'burst';
    w.limiter.retryAfterMs = 15_000;
    // the status snapshot already says "rate not ok", so the connector refuses before even calling send
    const err = await expectCode(() => connector.dispatch(cmd(rig, { target: { externalConversationKey: 'u-1' } })), 'RATE_LIMITED');
    expect(err.details).toMatchObject({ retryAtMs: rig.clock.t + 15_000 });
    expect(w.api.sent).toHaveLength(0);

    w.limiter.ok = true;
    rig.clock.t += 60_000;
    w.fault.mode = 'status';
    w.fault.status = 502;
    await expectCode(() => connector.dispatch(cmd(rig, { target: { externalConversationKey: 'u-1' } })), 'NETWORK_TIMEOUT');
  });

  it('an unbridged Care account never reaches the daemon', async () => {
    const world = makeDaemonWorld();
    rig = makeZaloRig();
    const connector = new ZaloCareConnector({
      transport: new DaemonZaloTransport({ call: world.call, zaloAccountIdOf: () => null }),
      getActiveEpoch: () => rig.state.epoch,
      resolveThreadKind: () => 'user',
    });
    await expectCode(() => connector.dispatch(cmd(rig, { target: { externalConversationKey: 'u-1' } })), 'SEND_DISABLED');
    expect(world.api.sent).toHaveLength(0);
  });
});

describe('capabilities, feed and history over the channel', () => {
  it('reports the daemon\'s honest features, and a safe default when the daemon is down', async () => {
    const { connector } = setup();
    expect(await connector.capabilities(rig.account.id)).toMatchObject({ text: true, reply: false, remoteRead: false, sendDedupe: false, backfill: true });
    w.state.locked = true;
    rig.clock.t += 5_000; // past the snapshot TTL
    expect((await connector.capabilities(rig.account.id)).text).toBe(false);
    w.fault.mode = 'not-running';
    rig.clock.t += 5_000;
    expect((await connector.capabilities(rig.account.id)).text).toBe(true); // an outage is not a revoked capability
  });

  it('sync reads the daemon feed and commit acknowledges it remotely', async () => {
    const { connector } = setup();
    w.control.onConnected('zalo-1');
    await connector.sync({ accountId: rig.account.id }); // first slice (gap flag), nothing in it
    w.api.listener.emit('message', { type: 0, threadId: 'peer-1', isSelf: false, data: { msgId: '7000000000000000001', uidFrom: 'peer-1', ts: '1700000000000', msgType: 'webchat', content: 'chào shop' } });
    const slice = await connector.sync({ accountId: rig.account.id });
    // the name came from the daemon's budgeted lookup
    expect(slice.events.map((e) => e.type)).toEqual(['conversation.updated', 'message.created']);

    // before commit the daemon still holds it (a crash would redeliver); after commit it is gone
    expect(((await w.call<{ items: unknown[] }>('GET', '/care/accounts/zalo-1/feed')).data).items).toHaveLength(1);
    await connector.commit(slice.commits[0]);
    expect(((await w.call<{ items: unknown[] }>('GET', '/care/accounts/zalo-1/feed')).data).items).toHaveLength(0);
    expect((await connector.sync({ accountId: rig.account.id, checkpoint: resume(slice.nextCheckpoint) })).events).toEqual([]);
  });

  it('first-login backfill asks the daemon for older 1-1 messages; group history comes back normalized', async () => {
    const { connector } = setup();
    rig.upsertConversation('g-1', 'group');
    await connector.sync({ accountId: rig.account.id, fullBackfill: true });
    expect(w.api.oldRequests).toEqual([[0, null]]);
    w.api.groupHistory = [{ isSelf: false, data: { msgId: '7100000000000000001', uidFrom: 'm1', ts: '1700000000000', msgType: 'webchat', content: 'hi nhóm' } }];
    const res = await connector.sync({ accountId: rig.account.id, checkpoint: { namespace: 'zalo_thread:g-1', cursor: '' } });
    expect(res.events.filter((e) => e.type === 'message.created')).toHaveLength(1);
    expect(res.nextCheckpoint).toMatchObject({ cursor: 'h:7100000000000000001' });
  });

  it('media downloads go straight to the CDN (no daemon hop); QR login uses the existing account routes', async () => {
    const { transport } = setup();
    const bytes = Buffer.from('img');
    const t = new DaemonZaloTransport({
      call: w.call,
      zaloAccountIdOf: () => 'zalo-1',
      fetchImpl: (async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'image/png' }), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset) })) as unknown as typeof fetch,
    });
    expect(await t.fetchMedia('care-1', 'https://f.zdn.vn/a.png')).toMatchObject({ mimeType: 'image/png' });
    w.pool.status = 'connected';
    expect(await transport.startQrLogin('care-1')).toMatchObject({ step: 'authorized', nativeAccountId: 'own-uid-1' });
  });
});
