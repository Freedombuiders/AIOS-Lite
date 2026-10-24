/**
 * Gmail connector contract conformance and the send path (AC-018, AC-024, AC-026): the attempt is
 * persisted before the RPC, a token goes on the wire at most once, a lost ack is uncertain,
 * nothing is ever inferred past `accepted`, and capabilities reported false are enforced.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CareError } from '../../../../_lib/care-kit/errors.js';
import { validateAuthCommand, type EmailDeliveryCommand } from '../../../../_lib/care-kit/contract.js';
import { emailCmd, makeEmailHarness, syncOnce, MIN, type EmailHarness } from './test-harness.js';
import { EmailTransportError } from './transport.js';

let h: EmailHarness;
beforeEach(() => {
  h = makeEmailHarness();
});
afterEach(() => h?.close());

async function code(p: Promise<unknown>): Promise<CareError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(CareError);
    return err as CareError;
  }
  throw new Error('expected rejection');
}

const attemptOf = (cmd: EmailDeliveryCommand) => h.connector.store.getAttempt(h.accountId, cmd.adapterRetryToken!);

describe('capabilities', () => {
  it('reports only what is really supported: bcc, new mail, remote read and downloads are FALSE; no send dedupe', async () => {
    expect(await h.connector.capabilities(h.accountId, 't-thread-1')).toEqual({
      text: true,
      reply: true,
      replyAll: true,
      edit: false,
      delete: false,
      reaction: false,
      typing: false,
      remoteRead: false,
      backfill: true,
      sendDedupe: false,
      mediaKinds: [],
      bcc: false,
      newMail: false,
    });
  });

  it('a mailbox the runtime does not know has no capability at all', async () => {
    h.close();
    h = makeEmailHarness({ resolveAccount: () => null });
    expect((await h.connector.capabilities(h.accountId)).text).toBe(false);
  });
});

describe('connect', () => {
  const auth = (over: Record<string, unknown> = {}) =>
    ({ channel: 'email', method: 'composio_connection', accountId: 'acc-x', composioConnectionId: 'ca_test', accountAddress: 'Shop@Example.com', ...over }) as const;

  it('verifies the connection through the profile call and the address (case-insensitive)', async () => {
    const res = await h.connector.connect(auth());
    expect(res).toEqual({ ok: true, accountId: 'acc-x', nativeAccountId: 'shop@example.com', label: 'shop@example.com' });
    expect(h.transport.profileCalls).toEqual([{ connectionId: 'ca_test', entityId: 'entity_test' }]);
  });

  it('an address that is not the connected mailbox is refused', async () => {
    expect(await h.connector.connect(auth({ accountAddress: 'someone@else.com' }))).toEqual({ ok: false, accountId: 'acc-x', error: 'ADDRESS_MISMATCH' });
  });

  it('expired / key / rate-limit failures become short codes and never echo provider text', async () => {
    h.transport.profileError = new EmailTransportError('connection_expired', 'secret token abc');
    expect(await h.connector.connect(auth())).toEqual({ ok: false, accountId: 'acc-x', error: 'CONNECTION_EXPIRED' });
    h.transport.profileError = new Error('boom user@private.com');
    expect(JSON.stringify(await h.connector.connect(auth()))).not.toContain('private.com');
  });

  it('refuses another channel\'s auth and malformed commands', async () => {
    await expect(h.connector.connect({ channel: 'zalo', method: 'qr_start', accountId: 'a' })).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    expect(() => validateAuthCommand(auth({ accountAddress: 'not-an-address' }))).toThrow();
  });
});

describe('dispatch guards (0 RPC for every refusal)', () => {
  const noRpc = () => expect(h.transport.sendCalls).toHaveLength(0);

  it('a chat command, a missing/invalid token and a wrong epoch never reach Gmail', async () => {
    const chat = { kind: 'chat', channel: 'zalo', clientRequestId: 'c1', accountId: h.accountId, target: { externalConversationKey: 'x' }, text: 'hi', purpose: 'care', actor: 'manual', ownerEpoch: 1, adapterRetryToken: 'abcdefgh1' } as const;
    expect((await code(h.connector.dispatch(chat))).code).toBe('INVALID_TARGET');
    expect((await code(h.connector.dispatch({ ...emailCmd(h), adapterRetryToken: undefined }))).code).toBe('INVALID_COMMAND');
    expect((await code(h.connector.dispatch(emailCmd(h, { token: 'bad token!' })))).code).toBe('INVALID_COMMAND');
    const epoch = h.stores.accounts.getAccount(h.accountId)!.ownerEpoch;
    expect((await code(h.connector.dispatch(emailCmd(h, { ownerEpoch: epoch + 1 })))).code).toBe('FENCING_REJECTED');
    noRpc();
    // a writer holding an OLD epoch is fenced as well
    h.close();
    h = makeEmailHarness({ getActiveEpoch: () => 2 });
    expect((await code(h.connector.dispatch(emailCmd(h, { ownerEpoch: 1 })))).code).toBe('FENCING_REJECTED');
    noRpc();
  });

  it('BCC, brand-new mail and several primary recipients are refused as unsupported capabilities', async () => {
    expect((await code(h.connector.dispatch(emailCmd(h, { bcc: ['audit@example.com'] })))).code).toBe('UNSUPPORTED_CAPABILITY');
    const base = emailCmd(h).target;
    const noThread = { ...base };
    delete noThread.externalConversationKey;
    expect((await code(h.connector.dispatch(emailCmd(h, { target: noThread })))).code).toBe('UNSUPPORTED_CAPABILITY');
    expect((await code(h.connector.dispatch(emailCmd(h, { target: { ...base, to: ['a@example.com', 'b@example.com'] } })))).code).toBe('UNSUPPORTED_CAPABILITY');
    noRpc();
  });

  it('markRead and attachment download are unsupported and say so', async () => {
    expect((await code(h.connector.markRead({ accountId: h.accountId, externalConversationKey: 't', nativeMessageId: 'm' }))).code).toBe('UNSUPPORTED_CAPABILITY');
    expect((await code(h.connector.fetchAttachment({ accountId: h.accountId, attachmentId: 'a' }))).code).toBe('UNSUPPORTED_CAPABILITY');
  });
});

describe('a normal send', () => {
  it('persists the attempt BEFORE the RPC, sends exactly what the command previewed, and stops at accepted', async () => {
    const cmd = emailCmd(h, {
      target: {
        externalConversationKey: 't-thread-1',
        // the Reply-To address core chose - NOT the customer's From
        to: ['billing@corp.example.com'],
        cc: ['boss@example.com', 'ops@example.com'],
        subject: 'Re: Invoice',
        replyToMessageId: 'm-orig',
        inReplyToHeader: '<orig@mail.example.com>',
      },
      text: 'Invoice attached next week.',
    });
    let rowAtRpcTime: unknown = null;
    const realSend = h.transport.send.bind(h.transport);
    h.transport.send = async (target, req) => {
      rowAtRpcTime = h.connector.store.getAttempt(h.accountId, req.attemptToken);
      return realSend(target, req);
    };

    const res = await h.connector.dispatch(cmd);
    expect(rowAtRpcTime).toMatchObject({ token: cmd.adapterRetryToken, state: 'prepared', clientRequestId: cmd.clientRequestId, rpcCount: 1, threadKey: 't-thread-1' });
    expect(h.transport.sendCalls).toEqual([
      {
        threadId: 't-thread-1',
        to: ['billing@corp.example.com'],
        cc: ['boss@example.com', 'ops@example.com'],
        subject: 'Re: Invoice',
        body: 'Invoice attached next week.',
        inReplyTo: '<orig@mail.example.com>',
        attemptToken: cmd.adapterRetryToken,
      },
    ]);
    expect(res).toMatchObject({ outcome: 'accepted', nativeMessageId: 'sent-1', nativeThreadId: 't-thread-1', adapterRetryToken: cmd.adapterRetryToken, receiptLevel: 'accepted' });
    expect(res.remoteTimestampMs).toBe(h.clock.ms);
    // accepted is accepted: nothing here claims delivered or read
    expect(res.outcome).not.toBe('delivered');
    expect(attemptOf(cmd)).toMatchObject({ state: 'accepted', gmailMessageId: 'sent-1', gmailThreadId: 't-thread-1' });
  });

  it('threading headers are only sent when the transport really honours them', async () => {
    h.transport.features = { ...h.transport.features, explicitThreadingHeaders: false };
    await h.connector.dispatch(emailCmd(h));
    expect(h.transport.sendCalls[0].inReplyTo).toBeUndefined();
  });

  it('an identical retry is answered from the ledger with no RPC; a changed payload or a re-used token is a 409', async () => {
    const cmd = emailCmd(h);
    const first = await h.connector.dispatch(cmd);
    expect(await h.connector.dispatch(cmd)).toEqual(first);
    expect(h.transport.sendCalls).toHaveLength(1);

    expect((await code(h.connector.dispatch({ ...cmd, text: 'A different answer.' }))).code).toBe('DUPLICATE_REQUEST_PAYLOAD_MISMATCH');
    expect((await code(h.connector.dispatch({ ...cmd, clientRequestId: 'another-request' }))).code).toBe('DUPLICATE_REQUEST_PAYLOAD_MISMATCH');
    expect((await code(h.connector.dispatch({ ...cmd, adapterRetryToken: 'care-token-other-1' }))).code).toBe('DUPLICATE_REQUEST_PAYLOAD_MISMATCH');
    expect(h.transport.sendCalls).toHaveLength(1);
  });

  it('two concurrent dispatches of one request put exactly one mail on the wire (one lane per account)', async () => {
    const cmd = emailCmd(h);
    const [a, b] = await Promise.all([h.connector.dispatch(cmd), h.connector.dispatch(cmd)]);
    expect(a).toEqual(b);
    expect(h.transport.sentCount).toBe(1);
  });

  it('CC recipients are allowed with one primary recipient', async () => {
    const base = emailCmd(h).target;
    const res = await h.connector.dispatch(emailCmd(h, { target: { ...base, cc: ['x@example.com'] } }));
    expect(res.outcome).toBe('accepted');
  });
});

describe('uncertain outcomes never become a second send (AC-024)', () => {
  it('a lost ack is uncertain; the same token is never put on the wire again', async () => {
    h.transport.sendMode = 'lost-ack';
    const cmd = emailCmd(h);
    const res = await h.connector.dispatch(cmd);
    expect(res).toMatchObject({ outcome: 'uncertain', adapterRetryToken: cmd.adapterRetryToken });
    expect(res.error).toContain('NETWORK_UNCERTAIN');
    expect(h.transport.sentCount).toBe(1);

    h.transport.sendMode = 'normal';
    const again = await h.connector.dispatch(cmd);
    expect(again.outcome).toBe('uncertain');
    expect(again.error).toContain('RESEND_BLOCKED');
    expect(h.transport.sendCalls).toHaveLength(1);
    expect(h.transport.sentCount).toBe(1);
  });

  it('a request that failed before reaching Gmail is also uncertain (the connector cannot tell the two apart)', async () => {
    h.transport.sendMode = 'ambiguous-before';
    const cmd = emailCmd(h);
    expect((await h.connector.dispatch(cmd)).outcome).toBe('uncertain');
    expect(h.transport.sentCount).toBe(0);
    h.transport.sendMode = 'normal';
    expect((await h.connector.dispatch(cmd)).outcome).toBe('uncertain');
    expect(h.transport.sendCalls).toHaveLength(1);
  });

  it('a "successful" answer without a message id is uncertain, not accepted', async () => {
    h.transport.sendMode = 'no-id';
    const res = await h.connector.dispatch(emailCmd(h));
    expect(res).toMatchObject({ outcome: 'uncertain', error: 'ACK_WITHOUT_MESSAGE_ID' });
  });

  it('reconcile without provider evidence stays uncertain: thread / body / Message-ID matching is not evidence', async () => {
    h.transport.sendMode = 'lost-ack';
    const cmd = emailCmd(h);
    await h.connector.dispatch(cmd);
    // the mail IS in the mailbox, with identical text and thread - still no confirmation
    const rec = await h.connector.reconcile({ clientRequestId: cmd.clientRequestId, adapterRetryToken: cmd.adapterRetryToken, accountId: h.accountId, ownerEpoch: cmd.ownerEpoch });
    expect(rec.outcome).toBe('uncertain');
    expect(h.transport.sendCalls).toHaveLength(1);
  });

  it('reconcile with real provider evidence (token lookup) accepts it, once, and later dispatches are answered from the ledger', async () => {
    h.transport.features = { ...h.transport.features, sentLookup: true };
    h.transport.sendMode = 'lost-ack';
    const cmd = emailCmd(h);
    await h.connector.dispatch(cmd);
    const rec = await h.connector.reconcile({ clientRequestId: cmd.clientRequestId, adapterRetryToken: cmd.adapterRetryToken, accountId: h.accountId, ownerEpoch: cmd.ownerEpoch });
    expect(rec).toMatchObject({ outcome: 'accepted', nativeMessageId: 'sent-1', receiptLevel: 'accepted' });
    h.transport.sendMode = 'normal';
    expect((await h.connector.dispatch(cmd)).outcome).toBe('accepted');
    expect(h.transport.sendCalls).toHaveLength(1);
  });

  it('reconcile refuses to confirm a reference that is not the recorded attempt, and an unknown request is uncertain', async () => {
    const cmd = emailCmd(h);
    await h.connector.dispatch(cmd);
    const rec = await h.connector.reconcile({ clientRequestId: cmd.clientRequestId, adapterRetryToken: cmd.adapterRetryToken, accountId: h.accountId, nativeMessageId: 'someone-elses', ownerEpoch: cmd.ownerEpoch });
    expect(rec.outcome).toBe('uncertain');
    const unknown = await h.connector.reconcile({ clientRequestId: 'never-sent', accountId: h.accountId, ownerEpoch: 1 });
    expect(unknown.outcome).toBe('uncertain');
  });

  it('the attempt ledger survives a restart: the new process does not resend either', async () => {
    h.transport.sendMode = 'lost-ack';
    const cmd = emailCmd(h);
    await h.connector.dispatch(cmd);
    h.restart();
    h.transport.sendMode = 'normal';
    expect((await h.connector.dispatch(cmd)).outcome).toBe('uncertain');
    expect(h.transport.sendCalls).toHaveLength(1);
  });
});

describe('definite failures, cooldowns and a dead connection', () => {
  it('a rate limit refuses before sending: persisted cooldown with retryAtMs, no RPC while it lasts, then the SAME token goes out once', async () => {
    const until = h.clock.ms + 2 * MIN;
    h.transport.sendMode = 'rate-limit';
    h.transport.retryAtMs = until;
    const cmd = emailCmd(h);
    const err = await code(h.connector.dispatch(cmd));
    expect(err).toMatchObject({ code: 'RATE_LIMITED', details: { retryAtMs: until, nextAttemptAtMs: until } });
    expect(attemptOf(cmd)!.state).toBe('refused');

    h.restart(); // the cooldown is persisted, not in memory
    expect((await code(h.connector.dispatch(cmd))).code).toBe('RATE_LIMITED');
    expect(h.transport.sendCalls).toHaveLength(1);

    h.advance(2 * MIN + 1000);
    h.transport.sendMode = 'normal';
    const ok = await h.connector.dispatch(cmd);
    expect(ok.outcome).toBe('accepted');
    expect(h.transport.sendCalls).toHaveLength(2);
    expect(h.transport.sendCalls[1].attemptToken).toBe(cmd.adapterRetryToken);
    expect(h.transport.sentCount).toBe(1);
  });

  it('the exhausted hourly budget cools sync down as well (it is one shared budget)', async () => {
    h.transport.sendMode = 'budget';
    const err = await code(h.connector.dispatch(emailCmd(h)));
    expect(err.code).toBe('RATE_LIMITED');
    expect((await code(h.connector.sync({ accountId: h.accountId }))).code).toBe('RATE_LIMITED');
    expect(h.transport.listCalls).toHaveLength(0);
  });

  it('an expired connection is ACCOUNT_FROZEN with a recheck time; every later call is refused locally (no storm)', async () => {
    h.transport.sendMode = 'expired';
    const cmd = emailCmd(h);
    const err = await code(h.connector.dispatch(cmd));
    expect(err).toMatchObject({ code: 'ACCOUNT_FROZEN' });
    expect((err.details as { retryAtMs: number }).retryAtMs).toBeGreaterThan(h.clock.ms);

    for (let i = 0; i < 5; i++) expect((await code(h.connector.dispatch(emailCmd(h)))).code).toBe('ACCOUNT_FROZEN');
    expect(h.transport.sendCalls).toHaveLength(1);
    expect((await h.connector.capabilities(h.accountId)).text).toBe(false);
    // the first request is replayable after reconnecting: the token is still unspent
    expect(attemptOf(cmd)!.state).toBe('refused');
  });

  it('a rejected message is terminal and the token stays rejected', async () => {
    h.transport.sendMode = 'reject';
    const cmd = emailCmd(h);
    expect((await code(h.connector.dispatch(cmd))).code).toBe('TERMINAL_REJECTION');
    h.transport.sendMode = 'normal';
    expect((await code(h.connector.dispatch(cmd))).code).toBe('TERMINAL_REJECTION');
    expect(h.transport.sendCalls).toHaveLength(1);
    const rec = await h.connector.reconcile({ clientRequestId: cmd.clientRequestId, adapterRetryToken: cmd.adapterRetryToken, accountId: h.accountId, ownerEpoch: cmd.ownerEpoch });
    expect(rec.outcome).toBe('failed');
  });
});

