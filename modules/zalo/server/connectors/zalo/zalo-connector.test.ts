import { afterEach, describe, expect, it } from 'vitest';
import type { DeliveryCommand } from '../../../../_lib/care-kit/index.js';
import { ZaloTransportError } from './transport.js';
import { cmd, expectCode, makeZaloRig, rawIn, type ZaloRig } from './zalo-test-kit.js';

let rig: ZaloRig;
afterEach(() => rig?.close());

describe('capabilities are honest', () => {
  it('Zalo has no client dedupe token; quote / seen marker / media follow what the transport really does', async () => {
    rig = makeZaloRig({ legacyFeatures: true });
    const caps = await rig.connector.capabilities(rig.account.id);
    expect(caps).toMatchObject({
      text: true,
      reply: false,
      replyAll: false,
      edit: false,
      delete: false,
      reaction: false,
      typing: true,
      remoteRead: false,
      backfill: true,
      sendDedupe: false,
      bcc: false,
      newMail: false,
      mediaKinds: [],
    });
    rig.transport.featureSet = { ...rig.transport.featureSet, quote: true, markRead: true };
    expect(await rig.connector.capabilities(rig.account.id)).toMatchObject({ reply: true, remoteRead: true });
    // a send-locked nick cannot send text, and cannot quote either
    rig.transport.featureSet = { ...rig.transport.featureSet, text: false };
    expect(await rig.connector.capabilities(rig.account.id)).toMatchObject({ text: false, reply: false });
  });
});

describe('boundary validation happens before the provider (contract conformance)', () => {
  it('rejects wrong channel/kind, email recipients, BCC and a Telegram topic without touching Zalo', async () => {
    rig = makeZaloRig();
    const base = cmd(rig);
    await expectCode(() => rig.connector.dispatch({ ...base, kind: 'email', channel: 'email', target: { to: ['a@b.co'], subject: 's' } } as unknown as DeliveryCommand), 'INVALID_TARGET');
    await expectCode(() => rig.connector.dispatch({ ...base, channel: 'telegram', adapterRetryToken: '123456' } as unknown as DeliveryCommand), 'INVALID_TARGET');
    await expectCode(() => rig.connector.dispatch({ ...base, bcc: ['x@y.co'] } as unknown as DeliveryCommand), 'INVALID_TARGET');
    await expectCode(() => rig.connector.dispatch({ ...base, target: { ...base.target, topicId: '5' } }), 'INVALID_TARGET');
    await expectCode(() => rig.connector.dispatch({ ...base, adapterRetryToken: 'bad token!' }), 'INVALID_COMMAND');
    await expectCode(() => rig.connector.dispatch({ ...base, text: '   ' }), 'INVALID_COMMAND');
    await expectCode(() => rig.connector.dispatch({ ...base, text: 'x'.repeat(2001) }), 'INVALID_COMMAND');
    expect(rig.transport.sendCalls).toHaveLength(0);
  });

  it('fences a stale AND a desynced-future epoch', async () => {
    rig = makeZaloRig();
    rig.state.epoch = 3;
    expect((await expectCode(() => rig.connector.dispatch(cmd(rig, { ownerEpoch: 2 })), 'FENCING_REJECTED')).status).toBe(409);
    await expectCode(() => rig.connector.dispatch(cmd(rig, { ownerEpoch: 4 })), 'FENCING_REJECTED');
    expect(rig.transport.sendCalls).toHaveLength(0);
  });

  it('needs a known conversation kind and honours capability limits (no quote support)', async () => {
    rig = makeZaloRig({ legacyFeatures: true });
    await expectCode(() => rig.connector.dispatch(cmd(rig, { target: { externalConversationKey: 'nobody' } })), 'INVALID_TARGET');
    await expectCode(() => rig.connector.dispatch(cmd(rig, { target: { externalConversationKey: 'peer-1', replyToMessageId: '123' } })), 'UNSUPPORTED_CAPABILITY');
    expect(rig.transport.sendCalls).toHaveLength(0);
    rig.transport.featureSet = { ...rig.transport.featureSet, quote: true };
    await rig.connector.dispatch(cmd(rig, { target: { externalConversationKey: 'peer-1', replyToMessageId: '123' } }));
    expect(rig.transport.sendCalls[0]).toMatchObject({ threadId: 'peer-1', threadKind: 'user', replyToMessageId: '123' });
  });
});

describe('accepted ack', () => {
  it('returns the provider id/time as accepted and sends exactly once', async () => {
    rig = makeZaloRig();
    const c = cmd(rig);
    const res = await rig.connector.dispatch(c);
    expect(res).toMatchObject({ outcome: 'accepted', receiptLevel: 'accepted', adapterRetryToken: c.adapterRetryToken });
    expect(res.nativeMessageId).toBe(rig.transport.delivered[0].msgId);
    expect(res.remoteTimestampMs).toBe(rig.transport.delivered[0].tsMs);
    expect(rig.transport.sendCalls).toHaveLength(1);
    expect(rig.transport.sendCalls[0]).toEqual({
      threadId: 'peer-1',
      threadKind: 'user',
      text: c.text,
      requestId: c.clientRequestId,
      attemptToken: c.adapterRetryToken,
      ownerEpoch: c.ownerEpoch,
      actor: 'manual',
    });
  });

  it('a repeated dispatch of the same request returns the first acceptance without a second send; a changed payload is a 409', async () => {
    rig = makeZaloRig();
    const c = cmd(rig);
    const first = await rig.connector.dispatch(c);
    expect(await rig.connector.dispatch(c)).toEqual(first);
    expect(rig.transport.delivered).toHaveLength(1);
    expect((await expectCode(() => rig.connector.dispatch({ ...c, text: 'different' }), 'DUPLICATE_REQUEST_PAYLOAD_MISMATCH')).status).toBe(409);
    // a token already bound to another request
    const other = cmd(rig, { adapterRetryToken: c.adapterRetryToken });
    await expectCode(() => rig.connector.dispatch(other), 'DUPLICATE_REQUEST_PAYLOAD_MISMATCH');
    expect(rig.transport.delivered).toHaveLength(1);
  });

  it('the same request key on another account is independent', async () => {
    rig = makeZaloRig();
    const a = cmd(rig);
    await rig.connector.dispatch(a);
    const b = { ...a, accountId: 'care-acc-2', ownerEpoch: 1 };
    expect((await rig.connector.dispatch(b)).outcome).toBe('accepted');
    expect(rig.transport.delivered).toHaveLength(2);
  });
});

describe('lost ack and uncertainty (AC-024)', () => {
  it('a lost ack is a timeout error; the request is never resent, not even on a direct retry', async () => {
    rig = makeZaloRig();
    rig.transport.behavior = 'lost-ack';
    const c = cmd(rig);
    expect((await expectCode(() => rig.connector.dispatch(c), 'NETWORK_TIMEOUT')).status).toBe(504);
    expect(rig.transport.delivered).toHaveLength(1);

    rig.transport.behavior = 'normal';
    await expectCode(() => rig.connector.dispatch(c), 'UNRESOLVED_UNCERTAINTY');
    expect(rig.transport.sendCalls).toHaveLength(1);
  });

  it('an ack that names no message is uncertain, not accepted', async () => {
    rig = makeZaloRig();
    rig.transport.behavior = 'ack-without-id';
    const c = cmd(rig);
    const res = await rig.connector.dispatch(c);
    expect(res.outcome).toBe('uncertain');
    expect(res.nativeMessageId).toBeUndefined();
    rig.transport.behavior = 'normal';
    await expectCode(() => rig.connector.dispatch(c), 'UNRESOLVED_UNCERTAINTY');
    expect(rig.transport.delivered).toHaveLength(1);
  });

  it('reconcile without hard evidence stays uncertain, even though an identical echo exists (no body matching by default)', async () => {
    rig = makeZaloRig();
    rig.transport.behavior = 'lost-ack';
    const c = cmd(rig);
    await expectCode(() => rig.connector.dispatch(c), 'NETWORK_TIMEOUT');
    await rig.connector.sync({ accountId: rig.account.id }); // the echo is now known
    const res = await rig.connector.reconcile({ clientRequestId: c.clientRequestId, accountId: rig.account.id, adapterRetryToken: c.adapterRetryToken, ownerEpoch: 1 });
    expect(res.outcome).toBe('uncertain');
    expect(res.nativeMessageId).toBeUndefined();
  });

  it('after a reconcile found nothing, a human resend of the same request is allowed again', async () => {
    rig = makeZaloRig();
    rig.transport.behavior = 'lost-ack';
    const c = cmd(rig);
    await expectCode(() => rig.connector.dispatch(c), 'NETWORK_TIMEOUT');
    await rig.connector.reconcile({ clientRequestId: c.clientRequestId, accountId: rig.account.id, ownerEpoch: 1 });
    rig.transport.behavior = 'normal';
    expect((await rig.connector.dispatch(c)).outcome).toBe('accepted');
    expect(rig.transport.delivered).toHaveLength(2); // the operator took responsibility for the possible duplicate
  });

  it('echo-text correlation (opt-in) confirms exactly one identical echo and refuses ambiguity', async () => {
    rig = makeZaloRig({ echoTextCorrelation: true });
    rig.transport.behavior = 'lost-ack';
    const c = cmd(rig, { text: 'cảm ơn anh' });
    await expectCode(() => rig.connector.dispatch(c), 'NETWORK_TIMEOUT');
    await rig.connector.sync({ accountId: rig.account.id });
    const res = await rig.connector.reconcile({ clientRequestId: c.clientRequestId, accountId: rig.account.id, ownerEpoch: 1 });
    expect(res).toMatchObject({ outcome: 'accepted', nativeMessageId: rig.transport.delivered[0].msgId });

    // two open requests with the same text in the same thread: nothing may be claimed
    rig.transport.behavior = 'lost-ack';
    const x = cmd(rig, { text: 'dạ vâng' });
    const y = cmd(rig, { text: 'dạ vâng' });
    await expectCode(() => rig.connector.dispatch(x), 'NETWORK_TIMEOUT');
    await expectCode(() => rig.connector.dispatch(y), 'NETWORK_TIMEOUT');
    await rig.connector.sync({ accountId: rig.account.id });
    expect((await rig.connector.reconcile({ clientRequestId: x.clientRequestId, accountId: rig.account.id, ownerEpoch: 1 })).outcome).toBe('uncertain');
  });

  it('reconcile confirms only the delivery it refers to and recognises a native id Care already holds after a restart', async () => {
    rig = makeZaloRig();
    const c = cmd(rig);
    const ok = await rig.connector.dispatch(c);
    expect((await rig.connector.reconcile({ clientRequestId: c.clientRequestId, accountId: rig.account.id, ownerEpoch: 1 })).outcome).toBe('accepted');
    for (const wrong of [{ adapterRetryToken: 'care-token-other-zz' }, { nativeMessageId: '1' }, { externalConversationKey: 'peer-2' }]) {
      const res = await rig.connector.reconcile({ clientRequestId: c.clientRequestId, accountId: rig.account.id, ownerEpoch: 1, ...wrong });
      expect(res.outcome).toBe('uncertain');
    }
    // a new process has no ledger: the id Care recorded from our own ack is honoured, an empty reference is not
    const restarted = rig.newConnector();
    expect(await restarted.reconcile({ clientRequestId: c.clientRequestId, accountId: rig.account.id, ownerEpoch: 1, nativeMessageId: ok.nativeMessageId })).toMatchObject({
      outcome: 'accepted',
      nativeMessageId: ok.nativeMessageId,
    });
    expect((await restarted.reconcile({ clientRequestId: 'unknown-request', accountId: rig.account.id, ownerEpoch: 1 })).outcome).toBe('uncertain');
  });
});

describe('definite failures, flood limits and cooldown', () => {
  it('flood control becomes RATE_LIMITED with a retry time, and the cooldown stops further sends without an RPC', async () => {
    rig = makeZaloRig();
    rig.transport.behavior = 'flood';
    rig.transport.floodRetryMs = 45_000;
    const c = cmd(rig);
    const err = await expectCode(() => rig.connector.dispatch(c), 'RATE_LIMITED');
    expect(err.status).toBe(429);
    expect(err.details).toMatchObject({ retryAtMs: rig.clock.t + 45_000, scope: 'zalo' });
    expect(rig.transport.sendCalls).toHaveLength(1);

    // within the cooldown any send of this nick fails fast, no RPC
    rig.transport.behavior = 'normal';
    rig.clock.t += 10_000;
    const other = await expectCode(() => rig.connector.dispatch(cmd(rig)), 'RATE_LIMITED');
    expect((other.details as { retryAtMs: number }).retryAtMs).toBe(rig.clock.t - 10_000 + 45_000);
    expect(rig.transport.sendCalls).toHaveLength(1);

    // after it, the SAME request goes through (flood is a definite not-sent) and is delivered once
    rig.clock.t += 40_000;
    expect((await rig.connector.dispatch(c)).outcome).toBe('accepted');
    expect(rig.transport.delivered).toHaveLength(1);
  });

  it('an exhausted daily/burst budget is a persisted-style cooldown, checked before any RPC', async () => {
    rig = makeZaloRig();
    rig.transport.rate = { ok: false, reason: 'daily', retryAfterMs: 3 * 3600_000 };
    const err = await expectCode(() => rig.connector.dispatch(cmd(rig)), 'RATE_LIMITED');
    expect(err.details).toMatchObject({ retryAtMs: rig.clock.t + 3 * 3600_000 });
    expect(rig.transport.sendCalls).toHaveLength(0);
    // the persisted-style cooldown also holds the nick until it ends, without asking the transport again
    const sendsBefore = rig.transport.sendCalls.length;
    await expectCode(() => rig.connector.dispatch(cmd(rig)), 'RATE_LIMITED');
    expect(rig.transport.sendCalls.length).toBe(sendsBefore);
    rig.clock.t += 4 * 3600_000;
    rig.transport.rate = { ok: false, reason: 'locked' };
    await expectCode(() => rig.connector.dispatch(cmd(rig)), 'SEND_DISABLED');
  });

  it('session expired / not connected are definite (SEND_DISABLED) and the request can be sent after re-login', async () => {
    rig = makeZaloRig();
    rig.transport.behavior = 'session-expired';
    const c = cmd(rig);
    const err = await expectCode(() => rig.connector.dispatch(c), 'SEND_DISABLED');
    expect(err.details).toMatchObject({ reason: 'session_expired' });
    rig.transport.behavior = 'normal';
    rig.transport.connected = false;
    await expectCode(() => rig.connector.dispatch(c), 'SEND_DISABLED');
    rig.transport.connected = true;
    expect((await rig.connector.dispatch(c)).outcome).toBe('accepted');
    expect(rig.transport.delivered).toHaveLength(1);
  });

  it('a permanent refusal is a terminal rejection', async () => {
    rig = makeZaloRig();
    rig.transport.behavior = 'reject';
    expect((await expectCode(() => rig.connector.dispatch(cmd(rig)), 'TERMINAL_REJECTION')).status).toBe(400);
    expect(rig.transport.delivered).toHaveLength(0);
  });

  it('an unknown transport failure is uncertain (the request may have left)', async () => {
    rig = makeZaloRig();
    rig.transport.send = async () => {
      throw new Error('boom');
    };
    await expectCode(() => rig.connector.dispatch(cmd(rig)), 'NETWORK_TIMEOUT');
    rig.transport.send = async () => {
      throw new ZaloTransportError('network', 'ECONNRESET');
    };
    await expectCode(() => rig.connector.dispatch(cmd(rig)), 'NETWORK_TIMEOUT');
  });
});

describe('one lane per account', () => {
  it('concurrent dispatches of one nick reach the transport strictly one after another', async () => {
    rig = makeZaloRig();
    const order: string[] = [];
    const real = rig.transport.send.bind(rig.transport);
    rig.transport.send = async (acc, req) => {
      order.push(`start:${req.text}`);
      await new Promise((r) => setTimeout(r, 15));
      const ack = await real(acc, req);
      order.push(`end:${req.text}`);
      return ack;
    };
    await Promise.all([rig.connector.dispatch(cmd(rig, { text: 'one' })), rig.connector.dispatch(cmd(rig, { text: 'two' }))]);
    expect(order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
  });
});

describe('auth, read marker, media', () => {
  it('qr_start returns the QR step; a connected nick is authorized; session_restore is unsupported', async () => {
    rig = makeZaloRig();
    expect(await rig.connector.connect({ channel: 'zalo', method: 'qr_start', accountId: rig.account.id })).toMatchObject({ ok: true, step: 'authorized', nativeAccountId: 'own-uid-1' });
    rig.transport.connected = false;
    expect(await rig.connector.connect({ channel: 'zalo', method: 'qr_start', accountId: rig.account.id })).toMatchObject({ ok: false, step: 'qr_pending', qr: expect.stringContaining('base64') });
    expect(await rig.connector.connect({ channel: 'zalo', method: 'session_restore', accountId: rig.account.id, sessionJson: '{}' })).toMatchObject({ ok: false, step: 'unsupported' });
    await expect(rig.connector.connect({ channel: 'telegram', method: 'qr_start', accountId: rig.account.id })).rejects.toMatchObject({ code: 'INVALID_TARGET' });
  });

  it('markRead is a capability error unless the transport can do it', async () => {
    rig = makeZaloRig({ legacyFeatures: true });
    await expectCode(() => rig.connector.markRead({ accountId: rig.account.id, externalConversationKey: 'peer-1', nativeMessageId: '9' }), 'UNSUPPORTED_CAPABILITY');
    rig.transport.featureSet = { ...rig.transport.featureSet, markRead: true };
    expect(await rig.connector.markRead({ accountId: rig.account.id, externalConversationKey: 'peer-1', nativeMessageId: '9' })).toEqual({ ok: true });
    expect(rig.transport.readMarks).toEqual([{ threadId: 'peer-1', nativeMessageId: '9' }]);
  });

  it('fetches media only from https Zalo CDN hosts (the URL comes from a customer message)', async () => {
    rig = makeZaloRig();
    rig.transport.media.set('https://f1.zdn.vn/a.jpg', { buffer: Buffer.from('img'), mimeType: 'image/jpeg' });
    const got = await rig.connector.fetchAttachment({ accountId: rig.account.id, attachmentId: 'zalo:123', mediaUrl: 'https://f1.zdn.vn/a.jpg' });
    expect(got).toMatchObject({ mimeType: 'image/jpeg', fileName: 'zalo_123' });
    for (const bad of ['http://f1.zdn.vn/a.jpg', 'https://evil.example/a.jpg', 'https://169.254.169.254/x', 'https://zdn.vn.evil.com/a', 'nope']) {
      await expect(rig.connector.fetchAttachment({ accountId: rig.account.id, attachmentId: 'zalo:1', mediaUrl: bad })).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    }
    await expectCode(() => rig.connector.fetchAttachment({ accountId: rig.account.id, attachmentId: 'zalo:1' }), 'UNSUPPORTED_CAPABILITY');
  });
});

void rawIn;
