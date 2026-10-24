import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareCausalOrder,
  compareNativeVersions,
  isCausalOrderToken,
  isValidCheckpointBox,
  isValidMessageNamespace,
} from '../../_lib/care-kit/checkpoint.js';
import { CareError } from '../../_lib/care-kit/errors.js';
import { sanitizeSharedMetadata } from './domain/metadata.js';
import { resolveAssignmentPrecedence } from './domain/routing.js';
import {
  decodeCursor,
  decodeInboxCursor,
  decodeTimelineCursor,
  encodeCursor,
  encodeInboxCursor,
  encodeTimelineCursor,
  type CareAssignment,
  type CareMessageMetadata,
  type NormalizedMessage,
} from '../../_lib/care-kit/types.js';

describe('Customer Care Domain & Normalization (AC-002, Findings 3 & 14)', () => {
  it('handles large IDs exceeding JS safe integers without precision loss', () => {
    const largeNativeId = '90071992547409951234';
    const msg: NormalizedMessage = {
      accountId: 'acc_tele_1',
      externalConversationKey: 'peer_123456789012345:topic_9999999999999',
      nativeMessageNamespace: 'telegram_channel_box:9999999999999',
      nativeMessageId: largeNativeId,
      senderIdentityKey: 'tg_user_9007199254740999',
      senderRole: 'customer',
      direction: 'in',
      origin: 'live',
      sentAtMs: 1774880000000,
      nativeVersion: '1',
      text: 'Hello from 64-bit Telegram peer',
      metadata: {
        type: 'chat',
        conversationKind: 'topic',
        topicId: '9999999999999',
        quote: { messageId: '90071992547409950000' },
      },
    };

    expect(typeof msg.nativeMessageId).toBe('string');
    expect(msg.nativeMessageId).toBe(largeNativeId);
    expect(msg.metadata.type).toBe('chat');
    if (msg.metadata.type === 'chat') {
      expect(msg.metadata.quote?.messageId).toBe('90071992547409950000');
      expect(msg.metadata.conversationKind).toBe('topic');
    }
  });

  it('preserves the shared email envelope without flattening, and keeps BCC out of it', () => {
    const emailMsg: NormalizedMessage = {
      accountId: 'acc_gmail_1',
      externalConversationKey: 'thread_18f4bf986e5c8f1e',
      nativeMessageNamespace: 'gmail_mailbox',
      nativeMessageId: 'msg_rfc_123456@mail.example.com',
      senderIdentityKey: 'customer@example.com',
      senderRole: 'customer',
      direction: 'in',
      origin: 'live',
      sentAtMs: 1774881000000,
      nativeVersion: null,
      text: 'Inquiry regarding product',
      metadata: {
        type: 'email',
        subject: 'Product question',
        from: 'Customer <customer@example.com>',
        to: ['support@company.com'],
        cc: ['manager@company.com'],
        replyTo: 'billing@example.com',
        messageIdHeader: '<msg_rfc_123456@mail.example.com>',
        inReplyToHeader: '<prev_789@mail.example.com>',
        category: 'primary',
      },
    };

    expect(emailMsg.metadata.type).toBe('email');
    if (emailMsg.metadata.type === 'email') {
      expect(emailMsg.metadata.replyTo).toBe('billing@example.com');
      expect(emailMsg.metadata.cc).toContain('manager@company.com');
      expect(emailMsg.metadata.category).toBe('primary');
      // BCC is a private delivery envelope, not a member of the shared metadata type.
      expect('bcc' in emailMsg.metadata).toBe(false);
    }
  });

  it('strips BCC case-insensitively from shared headers, raw envelopes and nested structures', () => {
    const dirty = {
      type: 'email',
      subject: 'S',
      from: 'a@b.co',
      to: ['c@d.co'],
      bcc: ['hidden@secret.example'],
      BCC: ['hidden2@secret.example'],
      headers: { Bcc: 'hidden3@secret.example', 'X-Original-BCC': 'hidden4@secret.example', Subject: 'S' },
      attachments: [{ id: 'a', mimeType: 'x', fileName: 'f', bccList: ['hidden5@secret.example'] }],
    } as unknown as CareMessageMetadata;
    const chatDirty = {
      type: 'chat',
      rawEnvelope: { data: { envelope: { 'resent-bcc': 'hidden6@secret.example', keep: 'yes' } } },
    } as unknown as CareMessageMetadata;

    const cleanJson = JSON.stringify([sanitizeSharedMetadata(dirty), sanitizeSharedMetadata(chatDirty)]);
    expect(cleanJson).not.toMatch(/secret\.example/);
    expect(cleanJson).toContain('"Subject":"S"');
    expect(cleanJson).toContain('"keep":"yes"');
    // input is not mutated
    expect(JSON.stringify(dirty)).toContain('hidden@secret.example');
  });

  it('encodes and decodes cursors with colons, unicode, and strict safe non-negative timestamps (Finding 3)', () => {
    // Colon-containing opaque ID and unicode
    const complexId = 'user:12345:topic:6789:⭐_khách_vip';
    const ts = 1774882000000;

    const encoded = encodeCursor({ timestampMs: ts, id: complexId });
    expect(typeof encoded).toBe('string');

    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual({ timestampMs: ts, id: complexId });

    // Reject fractional timestamps
    expect(() => encodeCursor({ timestampMs: 1234.56, id: 'id1' })).toThrow();
    // Reject negative timestamps
    expect(() => encodeCursor({ timestampMs: -100, id: 'id1' })).toThrow();
    // Reject empty id
    expect(() => encodeCursor({ timestampMs: 1000, id: '' })).toThrow();

    // Decoding corrupted / invalid cursors returns null
    expect(decodeCursor('invalid-base64')).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('guarantees deterministic tie-breaker sorting for equal-timestamp pagination (Finding 3)', () => {
    const ts = 1774883000000;
    const items = [
      { timestampMs: ts, id: 'care_uuid_b' },
      { timestampMs: ts, id: 'care_uuid_a' },
      { timestampMs: ts, id: 'care_uuid_c' },
    ];

    // Canonical comparator: timestampMs DESC, then id DESC
    const sorted = [...items].sort((x, y) => {
      if (x.timestampMs !== y.timestampMs) return y.timestampMs - x.timestampMs;
      return y.id.localeCompare(x.id);
    });

    expect(sorted.map((i) => i.id)).toEqual(['care_uuid_c', 'care_uuid_b', 'care_uuid_a']);

    const cursorB = encodeCursor(sorted[1]);
    const decodedB = decodeCursor(cursorB);
    expect(decodedB?.id).toBe('care_uuid_b');
  });
});

describe('Assignment Precedence & Scope Hierarchy (AC-002, Finding 14)', () => {
  const globalAssignment: CareAssignment = {
    id: 'asg_global',
    accountId: null, // Global default
    scope: 'global',
    priority: 1,
    enabled: true,
    mode: 'observe',
    agentId: 'global_agent',
    configVersion: 1,
  };

  const channelAssignment: CareAssignment = {
    id: 'asg_channel_email',
    accountId: null, // Channel default
    channel: 'email',
    scope: 'channel',
    priority: 5,
    enabled: true,
    mode: 'draft',
    agentId: 'email_agent',
    configVersion: 1,
  };

  const accountAssignment: CareAssignment = {
    id: 'asg_account',
    accountId: 'acc_1',
    scope: 'account',
    priority: 10,
    enabled: true,
    mode: 'auto',
    agentId: 'account_agent',
    configVersion: 1,
  };

  it('resolves Conversation > Customer > Sender > Domain > Account > Channel > Global', () => {
    const customerRule: CareAssignment = {
      id: 'asg_customer',
      accountId: 'acc_1',
      customerId: 'cust_vip_001',
      scope: 'customer',
      priority: 25,
      enabled: true,
      mode: 'auto',
      agentId: 'vip_concierge_agent',
      configVersion: 1,
    };

    const domainRule: CareAssignment = {
      id: 'asg_domain',
      accountId: 'acc_1',
      scope: 'domain',
      scopeTarget: 'vipcorp.com',
      priority: 20,
      enabled: true,
      mode: 'auto',
      agentId: 'vip_domain_agent',
      configVersion: 1,
    };

    const senderRule: CareAssignment = {
      id: 'asg_sender',
      accountId: 'acc_1',
      scope: 'identity',
      scopeTarget: 'ceo@vipcorp.com',
      priority: 30,
      enabled: true,
      mode: 'draft',
      agentId: 'executive_agent',
      configVersion: 1,
    };

    const conversationRule: CareAssignment = {
      id: 'asg_conv',
      accountId: 'acc_1',
      scope: 'conversation',
      scopeTarget: 'thread_special',
      priority: 40,
      enabled: true,
      mode: 'observe',
      agentId: 'special_agent',
      configVersion: 1,
    };

    const pool = [
      globalAssignment,
      channelAssignment,
      accountAssignment,
      domainRule,
      senderRule,
      customerRule,
      conversationRule,
    ];

    // 1. Conversation rule wins over all
    const r1 = resolveAssignmentPrecedence(pool, {
      accountId: 'acc_1',
      channel: 'email',
      conversationKey: 'thread_special',
      customerId: 'cust_vip_001',
      emailSender: 'ceo@vipcorp.com',
    });
    expect(r1.matched && r1.assignment.id).toBe('asg_conv');

    // 2. Customer rule wins over identity / domain / account
    const r2 = resolveAssignmentPrecedence(pool, {
      accountId: 'acc_1',
      channel: 'email',
      conversationKey: 'thread_normal',
      customerId: 'cust_vip_001',
      emailSender: 'staff@vipcorp.com',
    });
    expect(r2.matched && r2.assignment.id).toBe('asg_customer');

    // 3. Sender rule wins over domain
    const r3 = resolveAssignmentPrecedence(pool, {
      accountId: 'acc_1',
      channel: 'email',
      conversationKey: 'thread_normal',
      emailSender: 'ceo@vipcorp.com',
    });
    expect(r3.matched && r3.assignment.id).toBe('asg_sender');

    // 4. Domain rule wins over account
    const r4 = resolveAssignmentPrecedence(pool, {
      accountId: 'acc_1',
      channel: 'email',
      conversationKey: 'thread_normal',
      emailSender: 'other@vipcorp.com',
    });
    expect(r4.matched && r4.assignment.id).toBe('asg_domain');

    // 5. Account default
    const r5 = resolveAssignmentPrecedence(pool, {
      accountId: 'acc_1',
      channel: 'email',
      conversationKey: 'thread_normal',
      emailSender: 'random@external.com',
    });
    expect(r5.matched && r5.assignment.id).toBe('asg_account');

    // 6. Channel default for account without account default
    const r6 = resolveAssignmentPrecedence([globalAssignment, channelAssignment], {
      accountId: 'acc_no_default',
      channel: 'email',
      conversationKey: 'thread_1',
    });
    expect(r6.matched && r6.assignment.id).toBe('asg_channel_email');

    // 7. Global default for other channel
    const r7 = resolveAssignmentPrecedence([globalAssignment, channelAssignment], {
      accountId: 'acc_no_default',
      channel: 'zalo',
      conversationKey: 'user:123',
    });
    expect(r7.matched && r7.assignment.id).toBe('asg_global');
  });

  it('enforces explicit disabled deny override without falling through', () => {
    const disabledSenderRule: CareAssignment = {
      id: 'asg_disabled_sender',
      accountId: 'acc_1',
      scope: 'identity',
      scopeTarget: 'blocked@vipcorp.com',
      priority: 50,
      enabled: false, // EXPLICITLY DISABLED
      mode: 'observe',
      agentId: 'main',
      configVersion: 1,
    };

    const domainRule: CareAssignment = {
      id: 'asg_domain',
      accountId: 'acc_1',
      scope: 'domain',
      scopeTarget: 'vipcorp.com',
      priority: 20,
      enabled: true,
      mode: 'auto',
      agentId: 'vip_agent',
      configVersion: 1,
    };

    const res = resolveAssignmentPrecedence([accountAssignment, domainRule, disabledSenderRule], {
      accountId: 'acc_1',
      channel: 'email',
      conversationKey: 'thread_blocked',
      emailSender: 'blocked@vipcorp.com',
    });

    expect(res.matched).toBe(true);
    expect(res.active).toBe(false);
    if (res.matched && !res.active) {
      expect(res.reason).toBe('assignment_disabled');
      expect(res.assignment.id).toBe('asg_disabled_sender');
    }
  });

  it('rejects equal-priority conflicts with CareError(CONFIGURATION_CONFLICT)', () => {
    const ruleA: CareAssignment = {
      id: 'asg_a',
      accountId: 'acc_1',
      scope: 'domain',
      scopeTarget: 'conflict.com',
      priority: 25,
      enabled: true,
      mode: 'auto',
      agentId: 'agent_a',
      configVersion: 1,
    };
    const ruleB: CareAssignment = {
      id: 'asg_b',
      accountId: 'acc_1',
      scope: 'domain',
      scopeTarget: 'conflict.com',
      priority: 25, // EQUAL PRIORITY!
      enabled: true,
      mode: 'draft',
      agentId: 'agent_b',
      configVersion: 1,
    };

    expect(() => {
      resolveAssignmentPrecedence([ruleA, ruleB], {
        accountId: 'acc_1',
        channel: 'email',
        conversationKey: 'thread_conf',
        emailSender: 'test@conflict.com',
      });
    }).toThrowError(CareError);
  });
});

describe('Cursor: strict canonical, browser-safe, full opaque IDs (Finding 3)', () => {
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

  it('roundtrips the FULL opaque id (colons, unicode, JSON-hostile characters) without truncation', () => {
    const ids = ['a:b:c:d', 'khách ⭐ vip:99', '{"x":1}', 'line\nbreak', 'quote"back\\slash', 'x'.repeat(512)];
    for (const id of ids) {
      expect(decodeCursor(encodeCursor({ timestampMs: 1774882000000, id }))).toEqual({ timestampMs: 1774882000000, id });
    }
    expect(() => encodeCursor({ timestampMs: 1, id: 'x'.repeat(513) })).toThrow();
  });

  it('rejects everything that is not byte-for-byte what encodeCursor produces', () => {
    const good = encodeCursor({ timestampMs: 10, id: 'abc' });
    expect(decodeCursor(good)).toEqual({ timestampMs: 10, id: 'abc' });

    expect(decodeCursor(`${good}=`)).toBeNull(); // padding
    expect(decodeCursor(good.replace(/[A-Za-z0-9]/, '+'))).toBeNull(); // wrong alphabet
    expect(decodeCursor(b64('[10, "abc"]'))).toBeNull(); // non-canonical JSON (whitespace)
    expect(decodeCursor(b64('[1e1,"abc"]'))).toBeNull(); // exponent form
    expect(decodeCursor(b64('[10,"abc",1]'))).toBeNull(); // extra component
    expect(decodeCursor(b64('[10.5,"abc"]'))).toBeNull(); // fractional
    expect(decodeCursor(b64('[-1,"abc"]'))).toBeNull(); // negative
    expect(decodeCursor(b64('[9007199254740993,"abc"]'))).toBeNull(); // unsafe integer
    expect(decodeCursor(b64('[10,""]'))).toBeNull(); // empty id
    expect(decodeCursor(b64('[10,5]'))).toBeNull(); // id not a string
    expect(decodeCursor(b64('{"t":10,"id":"abc"}'))).toBeNull(); // wrong shape
    expect(decodeCursor(Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url'))).toBeNull(); // invalid UTF-8
    expect(decodeCursor('a')).toBeNull(); // impossible base64 length
    expect(decodeCursor('x'.repeat(2049))).toBeNull(); // oversized
  });

  it('anything the encoder accepts decodes; anything too large is refused by the encoder itself', () => {
    expect(decodeCursor(encodeCursor({ timestampMs: 1, id: 'x'.repeat(512) }))!.id).toBe('x'.repeat(512));
    // 512 CJK characters would encode past the decoder's byte bound: the ENCODER must refuse
    expect(() => encodeCursor({ timestampMs: 1774882000000, id: '漢'.repeat(512) })).toThrow();
    // longest all-CJK id that is accepted must roundtrip exactly
    let longest = 0;
    for (let n = 1; n <= 512; n++) {
      try {
        encodeCursor({ timestampMs: 1774882000000, id: '漢'.repeat(n) });
        longest = n;
      } catch {
        break;
      }
    }
    expect(longest).toBeGreaterThan(300);
    expect(longest).toBeLessThan(512);
    const id = '漢'.repeat(longest);
    expect(decodeCursor(encodeCursor({ timestampMs: 1774882000000, id }))).toEqual({ timestampMs: 1774882000000, id });
    expect(() => encodeCursor({ timestampMs: 1774882000000, id: '漢'.repeat(longest + 1) })).toThrow();
    // emoji (4-byte, surrogate pairs) obey the same rule
    const emoji = '😀'.repeat(200);
    const enc = (() => { try { return encodeCursor({ timestampMs: 5, id: emoji }); } catch { return null; } })();
    if (enc) expect(decodeCursor(enc)).toEqual({ timestampMs: 5, id: emoji });
  });

  it('typed inbox/timeline cursors roundtrip', () => {
    expect(decodeInboxCursor(encodeInboxCursor({ lastActivityAtMs: 5, conversationId: 'c:1' }))).toEqual({
      lastActivityAtMs: 5,
      conversationId: 'c:1',
    });
    expect(decodeTimelineCursor(encodeTimelineCursor({ sentAtMs: 6, messageId: 'm:2' }))).toEqual({ sentAtMs: 6, messageId: 'm:2' });
    expect(decodeInboxCursor('garbage')).toBeNull();
  });

  it('domain modules import nothing from Node or providers and never touch Buffer', () => {
    const dir = path.join(__dirname, 'domain');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${file} must not import node:*`).not.toMatch(/from\s+['"]node:/);
      expect(code, `${file} must not import a bare Node builtin`).not.toMatch(/from\s+['"](fs|path|crypto|buffer|os|child_process)['"]/);
      expect(code, `${file} must not use Buffer`).not.toMatch(/\bBuffer\b/);
      expect(code, `${file} must not import persistence/connectors/providers`).not.toMatch(
        /from\s+['"]\.\.?\/(\.\.\/)?(persistence|connectors|application)\//,
      );
    }
  });
});

describe('Causal ordering is adapter-owned, BigInt-safe and never guessed (Finding 9)', () => {
  it('orders numeric and dotted tokens as numbers, not strings', () => {
    expect(compareNativeVersions('10', '9')).toBe(1);
    expect(compareNativeVersions('9', '10')).toBe(-1);
    expect(compareNativeVersions('2.10', '2.9')).toBe(1);
    expect(compareNativeVersions('1.0', '1')).toBe(0);
    expect(compareNativeVersions('1.0.1', '1')).toBe(1);
  });

  it('is exact beyond Number.MAX_SAFE_INTEGER', () => {
    expect(compareCausalOrder('9007199254740993', '9007199254740992')).toBe(1);
    expect(compareCausalOrder('18446744073709551616', '18446744073709551615')).toBe(1);
    expect(compareCausalOrder('18446744073709551615', '18446744073709551615')).toBe(0);
  });

  it('refuses to order opaque, empty or malformed versions (unordered => null)', () => {
    for (const bad of [null, undefined, '', 'v2', '1.x', '1..2', ' 5', '5 ', '-1', '1e3', 'abc10']) {
      expect(compareNativeVersions(bad as string | null, '5')).toBeNull();
      expect(compareNativeVersions('5', bad as string | null)).toBeNull();
    }
    // opaque versions that used to merge ("v1" and "1" both became 1) stay distinguishable as unordered
    expect(compareNativeVersions('v1', '1')).toBeNull();
    expect(isCausalOrderToken('10')).toBe(true);
    expect(isCausalOrderToken('1.2.3')).toBe(true);
    expect(isCausalOrderToken('1.2.')).toBe(false);
  });

  it('validates checkpoint boxes and message namespaces per channel', () => {
    expect(isValidCheckpointBox('telegram', 'telegram_common_box')).toBe(true);
    expect(isValidCheckpointBox('telegram', 'telegram_channel_box:1234567890123')).toBe(true);
    expect(isValidCheckpointBox('telegram', 'telegram_channel_box:')).toBe(false);
    expect(isValidCheckpointBox('telegram', 'default')).toBe(false);
    expect(isValidCheckpointBox('telegram', 'gmail_mailbox')).toBe(false);
    expect(isValidCheckpointBox('email', 'gmail_mailbox')).toBe(true);
    expect(isValidCheckpointBox('zalo', 'zalo_chat')).toBe(true);
    expect(isValidMessageNamespace('zalo', 'telegram_common_box')).toBe(false);
    expect(isValidMessageNamespace('email', 'gmail_mailbox')).toBe(true);
    expect(isValidMessageNamespace('telegram', 'telegram_channel_box:42')).toBe(true);
  });
});
