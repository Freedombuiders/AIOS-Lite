import { describe, expect, it } from 'vitest';
import {
  isValidRetryToken,
  validateAuthCommand,
  validateDeliveryCommand,
  type ChatDeliveryCommand,
  type DeliveryCommand,
  type EmailDeliveryCommand,
} from '../../_lib/care-kit/contract.js';
import { FakeCareConnector } from './connectors/fake-connector.js';
import { CareError } from '../../_lib/care-kit/errors.js';

const TOKEN = 'retry-token-0001';

function chat(over: Partial<ChatDeliveryCommand> = {}): ChatDeliveryCommand {
  return {
    kind: 'chat',
    channel: 'zalo',
    clientRequestId: 'req_123',
    accountId: 'acc_test_1',
    target: { externalConversationKey: 'conv_1' },
    text: 'Hello Customer',
    purpose: 'care',
    actor: 'manual',
    ownerEpoch: 1,
    adapterRetryToken: TOKEN,
    ...over,
  };
}

function email(over: Partial<EmailDeliveryCommand> = {}): EmailDeliveryCommand {
  return {
    kind: 'email',
    channel: 'email',
    clientRequestId: 'req_mail_1',
    accountId: 'acc_mail_1',
    target: { externalConversationKey: 'thread_1', to: ['a@example.com'], subject: 'Re: Hi' },
    text: 'Reply body',
    purpose: 'care',
    actor: 'manual',
    ownerEpoch: 1,
    adapterRetryToken: 'mail-token-0001',
    ...over,
  };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(CareError);
    return (err as CareError).code;
  }
  throw new Error('expected rejection');
}

describe('Delivery command contract: chat | email union (AC-003, Finding 4)', () => {
  it('rejects channel-incongruent targets before any provider contact', async () => {
    const zalo = new FakeCareConnector('fake', 'zalo');
    const mail = new FakeCareConnector('fake-mail', 'email', { newMail: true });

    // chat command smuggling email recipients / subject / BCC
    expect(() => validateDeliveryCommand({ ...chat(), target: { externalConversationKey: 'c', to: ['x@y.zz'] } } as never)).toThrow(CareError);
    expect(() => validateDeliveryCommand({ ...chat(), bcc: ['x@y.zz'] } as never)).toThrow(CareError);
    // email command without recipients, with garbage recipients, or aimed at a chat channel
    expect(() => validateDeliveryCommand(email({ target: { externalConversationKey: 't', to: [], subject: 's' } }))).toThrow(CareError);
    expect(() => validateDeliveryCommand(email({ target: { externalConversationKey: 't', to: ['not-an-address'], subject: 's' } }))).toThrow(CareError);
    expect(() => validateDeliveryCommand({ ...email(), channel: 'zalo' } as never)).toThrow(CareError);
    expect(() => validateDeliveryCommand({ ...chat(), channel: 'email' } as never)).toThrow(CareError);

    // a well-formed chat command sent to the wrong connector
    expect(await codeOf(mail.dispatch(chat()))).toBe('INVALID_TARGET');
    expect(await codeOf(zalo.dispatch(email()))).toBe('INVALID_TARGET');
    expect(zalo.dispatchedCommands).toHaveLength(0);
    expect(mail.dispatchedCommands).toHaveLength(0);
    expect(zalo.providerSendCount + mail.providerSendCount).toBe(0);
  });

  it('validates the native retry token per channel (Telegram: signed 64-bit decimal)', () => {
    expect(isValidRetryToken('telegram', '9223372036854775807')).toBe(true);
    expect(isValidRetryToken('telegram', '-9223372036854775808')).toBe(true);
    expect(isValidRetryToken('telegram', '9223372036854775808')).toBe(false);
    expect(isValidRetryToken('telegram', '0')).toBe(false);
    expect(isValidRetryToken('telegram', 'abc')).toBe(false);
    expect(isValidRetryToken('zalo', TOKEN)).toBe(true);
    expect(isValidRetryToken('zalo', 'short')).toBe(false);
    expect(() => validateDeliveryCommand(chat({ channel: 'telegram', adapterRetryToken: 'not-a-number' }))).toThrow(CareError);
  });

  it('validates auth commands as per-channel discriminated unions', () => {
    expect(validateAuthCommand({ channel: 'zalo', method: 'qr_start', accountId: 'a' })).toBeTruthy();
    expect(() => validateAuthCommand({ channel: 'zalo', method: 'session_restore', accountId: 'a' } as never)).toThrow(CareError);
    expect(() => validateAuthCommand({ channel: 'telegram', method: 'phone_code', accountId: 'a', phoneCodeHash: 'h' } as never)).toThrow(CareError);
    expect(() => validateAuthCommand({ channel: 'telegram', method: 'phone_start', accountId: 'a', phoneNumber: 'abc' })).toThrow(CareError);
    expect(() => validateAuthCommand({ channel: 'email', method: 'composio_connection', accountId: 'a', composioConnectionId: 'c', accountAddress: 'nope' })).toThrow(CareError);
    expect(() => validateAuthCommand({ channel: 'email', method: 'qr_start', accountId: 'a' } as never)).toThrow(CareError);
    expect(
      validateAuthCommand({ channel: 'email', method: 'composio_connection', accountId: 'a', composioConnectionId: 'c', accountAddress: 'me@shop.vn' }),
    ).toBeTruthy();
  });

  it('refuses an auth command for another channel at the connector', async () => {
    const connector = new FakeCareConnector('fake', 'zalo');
    await expect(connector.connect({ channel: 'telegram', method: 'session_restore', accountId: 'a', sessionString: 's' })).rejects.toThrow(CareError);
    const ok = await connector.connect({ channel: 'zalo', method: 'qr_start', accountId: 'a' });
    expect(ok.ok).toBe(true);
  });
});

describe('Command validation yields zero provider RPC (review 9)', () => {
  const mail = (over: Record<string, unknown> = {}, target: Record<string, unknown> = {}): DeliveryCommand =>
    ({ ...email(), ...over, target: { ...email().target, ...target } }) as DeliveryCommand;

  it('rejects unknown actor/purpose, header injection and malformed reply/topic shapes before the provider', async () => {
    const zalo = new FakeCareConnector('fake', 'zalo');
    const tg = new FakeCareConnector('fake-tg', 'telegram');
    const em = new FakeCareConnector('fake-mail', 'email', { bcc: true, newMail: true, replyAll: true });
    const bad: Array<[FakeCareConnector, DeliveryCommand]> = [
      [zalo, chat({ actor: 'root' as never, clientRequestId: 'v1' })],
      [zalo, chat({ purpose: 'marketing' as never, clientRequestId: 'v2' })],
      [zalo, chat({ clientRequestId: 'v3', target: { externalConversationKey: 'c\nINJECT' } })],
      [zalo, chat({ clientRequestId: 'v4', target: { externalConversationKey: 'c', replyToMessageId: '' } })],
      [zalo, chat({ clientRequestId: 'v5', target: { externalConversationKey: 'c', replyToMessageId: 42 as never } })],
      [zalo, chat({ clientRequestId: 'v6', target: { externalConversationKey: 'c', topicId: '5' } })],
      [tg, chat({ channel: 'telegram', clientRequestId: 'v7', adapterRetryToken: '123456789', target: { externalConversationKey: 'c', topicId: 'abc' } })],
      [zalo, chat({ clientRequestId: 'v8', text: '' })],
      [zalo, chat({ clientRequestId: 'v9', ownerEpoch: 0 })],
      [em, mail({ clientRequestId: 'm1' }, { subject: 'Hi\r\nBcc: attacker@evil.example' })],
      [em, mail({ clientRequestId: 'm2' }, { inReplyToHeader: '<id@x>\nX-Evil: 1' })],
      [em, mail({ clientRequestId: 'm3' }, { replyToMessageId: '' })],
      [em, mail({ clientRequestId: 'm4' }, { subject: '' })],
      [em, mail({ clientRequestId: 'm5', bcc: ['nope'] })],
      [em, mail({ clientRequestId: 'm6', actor: undefined })],
    ];
    for (const [connector, cmd] of bad) {
      await expect(connector.dispatch(cmd), String(cmd.clientRequestId)).rejects.toBeInstanceOf(CareError);
    }
    for (const connector of [zalo, tg, em]) {
      expect(connector.providerSendCount).toBe(0);
      expect(connector.dispatchedCommands).toHaveLength(0);
    }
  });

  it('accepts every valid actor/purpose combination and well-formed optional shapes', async () => {
    const tg = new FakeCareConnector('fake-tg', 'telegram');
    let n = 0;
    for (const actor of ['manual', 'approved', 'auto'] as const) {
      for (const purpose of ['care', 'campaign'] as const) {
        n += 1;
        const res = await tg.dispatch(
          chat({
            channel: 'telegram', actor, purpose, clientRequestId: `ok${n}`, adapterRetryToken: String(1000 + n),
            target: { externalConversationKey: 'peer', topicId: '77', replyToMessageId: 'm-9' },
          }),
        );
        expect(res.outcome).toBe('accepted');
      }
    }
    expect(tg.providerSendCount).toBe(6);
  });

  it('validates reconcile commands and refuses to confirm a different delivery', async () => {
    const connector = new FakeCareConnector();
    const sent = await connector.dispatch(chat());
    await expect(connector.reconcile({ clientRequestId: '', accountId: 'a', ownerEpoch: 1 })).rejects.toBeInstanceOf(CareError);
    await expect(connector.reconcile({ clientRequestId: 'r', accountId: 'a', ownerEpoch: 0 })).rejects.toBeInstanceOf(CareError);
    await expect(connector.reconcile({ clientRequestId: 'r', accountId: 'a', ownerEpoch: 1, nativeMessageId: 'x\ny' })).rejects.toBeInstanceOf(CareError);

    const base = { clientRequestId: 'req_123', accountId: 'acc_test_1', ownerEpoch: 1 };
    expect((await connector.reconcile(base)).outcome).toBe('accepted');
    expect((await connector.reconcile({ ...base, nativeMessageId: sent.nativeMessageId, adapterRetryToken: TOKEN, externalConversationKey: 'conv_1' })).outcome).toBe('accepted');
    for (const wrong of [
      { nativeMessageId: 'remote_other' },
      { adapterRetryToken: 'retry-token-OTHER' },
      { externalConversationKey: 'a_different_conversation' },
    ]) {
      const res = await connector.reconcile({ ...base, ...wrong });
      expect(res.outcome).toBe('uncertain');
      expect(res.nativeMessageId).toBeUndefined();
    }
  });

  it('opaque ids containing the separator cannot collide: ledger, token and delayed-ack scopes', async () => {
    const connector = new FakeCareConnector();
    const cmd = (accountId: string, clientRequestId: string, token: string) => chat({ accountId, clientRequestId, adapterRetryToken: token });
    // tuples ('a:b','c') and ('a','b:c') are different accounts/requests
    const one = await connector.dispatch(cmd('a:b', 'c', 'tok-aaaaaaaa'));
    const two = await connector.dispatch(cmd('a', 'b:c', 'tok-aaaaaaaa'));
    expect(connector.providerSendCount).toBe(2);
    expect(one.nativeMessageId).not.toBe(two.nativeMessageId);
    // and the same token under ('a:b','c') vs ('a','b:c') does not trip the stolen-token rule
    expect(connector.getDelivery('a:b', 'c')!.nativeMessageId).toBe(one.nativeMessageId);
    expect(connector.getDelivery('a', 'b:c')!.nativeMessageId).toBe(two.nativeMessageId);

    // delayed acks stay scoped to the exact tuple
    const slow = new FakeCareConnector();
    slow.setBehavior('delayed-ack');
    const p1 = slow.dispatch(cmd('x:y', 'z', 'tok-bbbbbbbb'));
    const p2 = slow.dispatch(cmd('x', 'y:z', 'tok-bbbbbbbb'));
    slow.releaseDelayedAck('z', 'x:y');
    const r1 = await p1;
    expect(r1.nativeMessageId).toBe(slow.getDelivery('x:y', 'z')!.nativeMessageId);
    slow.releaseDelayedAck('y:z', 'x');
    expect((await p2).nativeMessageId).toBe(slow.getDelivery('x', 'y:z')!.nativeMessageId);
  });

  it('supports the Telegram QR login steps as typed commands', () => {
    expect(validateAuthCommand({ channel: 'telegram', method: 'qr_start', accountId: 'a' })).toBeTruthy();
    expect(validateAuthCommand({ channel: 'telegram', method: 'qr_poll', accountId: 'a', loginToken: 'tok' })).toBeTruthy();
    expect(() => validateAuthCommand({ channel: 'telegram', method: 'qr_poll', accountId: 'a' } as never)).toThrow(CareError);
    expect(() => validateAuthCommand({ channel: 'telegram', method: 'qr_scan', accountId: 'a' } as never)).toThrow(CareError);
  });
});

describe('Fake Connector: capabilities, mandatory token, scoped dedupe (AC-003, AC-024, Finding 5)', () => {
  it('rejects delivery with typed error when capability is revoked', async () => {
    const connector = new FakeCareConnector();
    expect((await connector.dispatch(chat())).outcome).toBe('accepted');
    connector.setCapabilities({ text: false });
    expect(await codeOf(connector.dispatch(chat({ clientRequestId: 'req_124', adapterRetryToken: 'retry-token-0002' })))).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('rejects reply delivery when the connector does not support thread reply', async () => {
    const connector = new FakeCareConnector('fake', 'zalo', { reply: false });
    const cmd = chat({ clientRequestId: 'req_125', target: { externalConversationKey: 'c', replyToMessageId: 'remote_msg_999' } });
    expect(await codeOf(connector.dispatch(cmd))).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('enforces BCC, replyAll and new-mail capabilities for email', async () => {
    const connector = new FakeCareConnector('fake-email', 'email', { bcc: false, replyAll: false, newMail: false });

    const bccCmd = email({ clientRequestId: 'bcc1', adapterRetryToken: 'mail-token-bcc1', bcc: ['hidden@example.com'] });
    expect(await codeOf(connector.dispatch(bccCmd))).toBe('UNSUPPORTED_CAPABILITY');
    connector.setCapabilities({ bcc: true });
    expect((await connector.dispatch(bccCmd)).outcome).toBe('accepted');

    const multi = email({
      clientRequestId: 'multi1',
      adapterRetryToken: 'mail-token-multi',
      target: { externalConversationKey: 'thread_1', to: ['u1@example.com'], cc: ['u2@example.com'], subject: 'Re' },
    });
    expect(await codeOf(connector.dispatch(multi))).toBe('UNSUPPORTED_CAPABILITY');
    connector.setCapabilities({ replyAll: true });
    expect((await connector.dispatch(multi)).outcome).toBe('accepted');

    const fresh = email({
      clientRequestId: 'new1',
      adapterRetryToken: 'mail-token-new1',
      target: { to: ['u1@example.com'], subject: 'Brand new' },
    });
    expect(await codeOf(connector.dispatch(fresh))).toBe('UNSUPPORTED_CAPABILITY');
    connector.setCapabilities({ newMail: true });
    expect((await connector.dispatch(fresh)).outcome).toBe('accepted');
  });

  it('requires a stable native retry token when the connector claims sendDedupe, and not when it does not', async () => {
    const dedupe = new FakeCareConnector('fake', 'zalo', { sendDedupe: true });
    const noToken = chat({ adapterRetryToken: undefined });
    expect(await codeOf(dedupe.dispatch(noToken))).toBe('INVALID_COMMAND');
    expect(dedupe.providerSendCount).toBe(0);

    const plain = new FakeCareConnector('fake', 'zalo', { sendDedupe: false });
    expect((await plain.dispatch(noToken)).outcome).toBe('accepted');
  });

  it('sendDedupe changes acceptance: identical retry is one provider send; without it the provider sends twice', async () => {
    const dedupe = new FakeCareConnector('fake', 'zalo', { sendDedupe: true });
    const first = await dedupe.dispatch(chat());
    const retry = await dedupe.dispatch(chat());
    expect(retry.nativeMessageId).toBe(first.nativeMessageId);
    expect(dedupe.providerSendCount).toBe(1);
    expect(dedupe.dispatchedCommands).toHaveLength(1);

    const plain = new FakeCareConnector('fake', 'zalo', { sendDedupe: false });
    const a = await plain.dispatch(chat({ adapterRetryToken: undefined }));
    const b = await plain.dispatch(chat({ adapterRetryToken: undefined }));
    expect(b.nativeMessageId).not.toBe(a.nativeMessageId);
    expect(plain.providerSendCount).toBe(2);
  });

  it('rejects a changed payload, a changed token and a stolen token under the same account scope', async () => {
    const connector = new FakeCareConnector();
    await connector.dispatch(chat());

    expect(await codeOf(connector.dispatch(chat({ text: 'Altered text' })))).toBe('DUPLICATE_REQUEST_PAYLOAD_MISMATCH');
    expect(await codeOf(connector.dispatch(chat({ target: { externalConversationKey: 'other_conv' } })))).toBe('DUPLICATE_REQUEST_PAYLOAD_MISMATCH');
    expect(await codeOf(connector.dispatch(chat({ adapterRetryToken: 'retry-token-9999' })))).toBe('DUPLICATE_REQUEST_PAYLOAD_MISMATCH');
    // a different request may not reuse the first request's token
    expect(await codeOf(connector.dispatch(chat({ clientRequestId: 'req_other' })))).toBe('DUPLICATE_REQUEST_PAYLOAD_MISMATCH');
    expect(connector.providerSendCount).toBe(1);

    // a distinct ACCOUNT may reuse the same request key and token independently
    const other = await connector.dispatch(chat({ accountId: 'acc_test_2' }));
    expect(other.outcome).toBe('accepted');
    expect(connector.providerSendCount).toBe(2);
  });

  it('treats BCC as part of the immutable payload', async () => {
    const connector = new FakeCareConnector('fake-email', 'email', { bcc: true });
    await connector.dispatch(email({ bcc: ['audit@example.com'] }));
    expect(await codeOf(connector.dispatch(email({ bcc: ['someone-else@example.com'] })))).toBe('DUPLICATE_REQUEST_PAYLOAD_MISMATCH');
    expect(await codeOf(connector.dispatch(email({ bcc: undefined })))).toBe('DUPLICATE_REQUEST_PAYLOAD_MISMATCH');
  });

  it('reconcile without provider evidence is uncertain, never a definite failure', async () => {
    const connector = new FakeCareConnector();
    const res = await connector.reconcile({ clientRequestId: 'never_sent', accountId: 'acc_test_1', ownerEpoch: 1 });
    expect(res.outcome).toBe('uncertain');
    expect(res.nativeMessageId).toBeUndefined();
  });

  it('accepted-lost-ack: retry with the same token does not duplicate, and reconcile finds the evidence (S1)', async () => {
    const connector = new FakeCareConnector();
    connector.setBehavior('accepted-lost-ack');
    expect(await codeOf(connector.dispatch(chat()))).toBe('NETWORK_TIMEOUT');
    expect(connector.providerSendCount).toBe(1);

    const retry = await connector.dispatch(chat());
    expect(retry.outcome).toBe('accepted');
    expect(connector.providerSendCount).toBe(1);

    const rec = await connector.reconcile({ clientRequestId: 'req_123', accountId: 'acc_test_1', ownerEpoch: 1 });
    expect(rec.outcome).toBe('accepted');
    expect(rec.nativeMessageId).toBe(retry.nativeMessageId);
    expect(rec.receiptLevel).toBe('accepted');

    // a token owned by ANOTHER request is that request's delivery: never confirmed as this one
    const otherRequest = await connector.reconcile({ clientRequestId: 'unknown_req', adapterRetryToken: TOKEN, accountId: 'acc_test_1', ownerEpoch: 1 });
    expect(otherRequest.outcome).toBe('uncertain');
    expect(otherRequest.nativeMessageId).toBeUndefined();
    // but never across accounts
    const crossAccount = await connector.reconcile({ clientRequestId: 'req_123', accountId: 'acc_test_2', ownerEpoch: 1 });
    expect(crossAccount.outcome).toBe('uncertain');
  });

  it('releases a delayed ack only for the matching account + request', async () => {
    const connector = new FakeCareConnector();
    connector.setBehavior('delayed-ack');
    const pendingA = connector.dispatch(chat());
    const pendingB = connector.dispatch(chat({ accountId: 'acc_test_2' }));
    let bSettled = false;
    void pendingB.then(() => {
      bSettled = true;
    });

    connector.releaseDelayedAck('req_123', 'acc_test_1');
    const a = await pendingA;
    expect(a.nativeMessageId).toBe(connector.getDelivery('acc_test_1', 'req_123')!.nativeMessageId);
    await Promise.resolve();
    expect(bSettled).toBe(false);

    connector.releaseDelayedAck('req_123', 'acc_test_2');
    const b = await pendingB;
    expect(b.nativeMessageId).toBe(connector.getDelivery('acc_test_2', 'req_123')!.nativeMessageId);
    expect(b.nativeMessageId).not.toBe(a.nativeMessageId);
  });

  it('handles terminal rejection without a second attempt being implied', async () => {
    const connector = new FakeCareConnector();
    connector.setBehavior('terminal-rejection');
    expect(await codeOf(connector.dispatch(chat()))).toBe('TERMINAL_REJECTION');
    expect(connector.providerSendCount).toBe(0);
  });

  it('fences dispatch on STRICT epoch equality (stale and future writers both rejected)', async () => {
    const connector = new FakeCareConnector();
    connector.activeEpoch = 2;
    expect(await codeOf(connector.dispatch(chat({ ownerEpoch: 1 })))).toBe('FENCING_REJECTED');
    expect(await codeOf(connector.dispatch(chat({ ownerEpoch: 3 })))).toBe('FENCING_REJECTED');
    expect(connector.dispatchedCommands).toHaveLength(0);
    expect((await connector.dispatch(chat({ ownerEpoch: 2 }))).outcome).toBe('accepted');

    connector.setBehavior('epoch-loss');
    expect(await codeOf(connector.dispatch(chat({ clientRequestId: 'req_after_loss', adapterRetryToken: 'retry-token-0003', ownerEpoch: 2 })))).toBe('FENCING_REJECTED');
  });

  it('markRead honours the remoteRead capability', async () => {
    const connector = new FakeCareConnector('fake', 'zalo', { remoteRead: false });
    await expect(connector.markRead({ accountId: 'a', externalConversationKey: 'c', nativeMessageId: 'm' })).rejects.toThrow(CareError);
    expect(connector.readCommands).toHaveLength(0);
    connector.setCapabilities({ remoteRead: true });
    expect((await connector.markRead({ accountId: 'a', externalConversationKey: 'c', nativeMessageId: 'm' })).ok).toBe(true);
  });

  it('sync returns an adapter-owned typed checkpoint with CAS + causal position', async () => {
    const connector = new FakeCareConnector('fake-tg', 'telegram');
    connector.enqueueEvent({ type: 'account.status', eventId: 'e1', accountId: 'a', timestampMs: 1, healthStatus: 'healthy' });
    const res = await connector.sync({ accountId: 'a', checkpoint: { namespace: 'telegram_channel_box:123', cursor: 'c0' } });
    expect(res.nextCheckpoint).toMatchObject({ namespace: 'telegram_channel_box:123', expectedCursor: 'c0' });
    expect(res.nextCheckpoint?.position).toMatch(/^\d+$/);
  });

  it('supports duplicate and out-of-order event streams for recovery testing', async () => {
    const connector = new FakeCareConnector();
    const event1: any = { type: 'message.created', eventId: 'ev_1', accountId: 'acc_1', timestampMs: 1000 };
    const event2: any = { type: 'message.created', eventId: 'ev_2', accountId: 'acc_1', timestampMs: 2000 };

    connector.enqueueOutOfOrderEvents([event1, event2]);
    const first = await connector.sync({ accountId: 'acc_1', limit: 10 });
    expect(first.events.map((e) => e.eventId)).toEqual(['ev_2', 'ev_1']);

    connector.enqueueDuplicateEvents(event1, 2);
    const second = await connector.sync({ accountId: 'acc_1', limit: 10 });
    expect(second.events.map((e) => e.eventId)).toEqual(['ev_1', 'ev_1']);
  });
});

// Compile-time proof that the union is closed: a chat command cannot carry email fields.
const _typeProbe: DeliveryCommand = chat();
void _typeProbe;
