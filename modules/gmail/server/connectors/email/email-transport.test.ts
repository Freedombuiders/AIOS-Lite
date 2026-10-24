/**
 * Pure pieces of the Gmail connector: window arithmetic (parity with the legacy poller), the
 * checkpoint cursor codec, and the production transport shell over `src/email/gmail.ts`
 * (mocked: no Composio client, no key, no network).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchGmailMessages = vi.fn();
const fetchGmailProfile = vi.fn();
const sendGmailReply = vi.fn();

vi.mock('../../gmail.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../gmail.js')>();
  return {
    ...orig,
    fetchGmailMessages: (...a: unknown[]) => fetchGmailMessages(...a),
    fetchGmailProfile: (...a: unknown[]) => fetchGmailProfile(...a),
    sendGmailReply: (...a: unknown[]) => sendGmailReply(...a),
  };
});

import { EmailBudgetExceeded } from '../../gmail.js';
const windowQuery = (a: {sync_cursor: number | null; backfill_days: number}, start: number) => openWindowState({coveredSec: a.sync_cursor, backfillDays:a.backfill_days, startSec:start}).query;
import { EMAIL_ENTITY_ID } from '../../gmail.js';
import { normalizeGmailMessage } from '../../parse.js';
import { ComposioAuthError, ComposioConnectionExpiredError, ComposioRateLimitError } from '../../../../_lib/composio.js';
import { createGmailTransport, mapGmailError } from './gmail-transport.js';
import { EmailTransportError, isDefinitePreSendFailure } from './transport.js';
import {
  buildWindowQuery,
  cursorPosition,
  decodeCursor,
  encodeCursor,
  nextHourMs,
  openWindowState,
  textHash,
} from './window.js';
import { compareCausalOrder } from '../../../../_lib/care-kit/checkpoint.js';

const target = { connectionId: 'ca_1', entityId: 'user_1' };

describe('window arithmetic', () => {
  it('matches the legacy poller exactly (first sync, later poll, clamp at zero)', () => {
    for (const [cursor, days, start] of [
      [null, 2, 1_800_000_000],
      [1_799_990_000, 2, 1_800_000_000],
      [100, 2, 1_800_000_000],
      [null, 10_000_000, 5],
    ] as const) {
      const legacy = windowQuery({ sync_cursor: cursor, backfill_days: days }, start);
      const mine = openWindowState({ coveredSec: cursor, backfillDays: days, startSec: start }).query;
      expect(mine).toBe(legacy);
    }
    expect(buildWindowQuery(10, 20)).toBe('after:10 before:21 {in:inbox in:sent}');
  });

  it('page size and kind follow first sync / poll / full re-read', () => {
    expect(openWindowState({ coveredSec: null, backfillDays: 1, startSec: 100_000 })).toMatchObject({ kind: 'backfill', pageSize: 50 });
    expect(openWindowState({ coveredSec: 99_000, backfillDays: 1, startSec: 100_000 })).toMatchObject({ kind: 'poll', pageSize: 25, lowerSec: 98_400 });
    expect(openWindowState({ coveredSec: 99_000, backfillDays: 1, startSec: 200_000, fullBackfill: true })).toMatchObject({ kind: 'full_backfill', pageSize: 50 });
  });

  it('the next budget window is the top of the next hour', () => {
    const t = Date.UTC(2027, 0, 1, 10, 30, 0);
    expect(nextHourMs(t)).toBe(Date.UTC(2027, 0, 1, 11, 0, 0));
    expect(nextHourMs(Date.UTC(2027, 0, 1, 11, 0, 0))).toBe(Date.UTC(2027, 0, 1, 12, 0, 0));
  });
});

describe('checkpoint cursor', () => {
  it('round-trips and rejects anything else', () => {
    const c = { coveredSec: 1_800_000_000, windowEndSec: 1_800_000_600, windowLowerSec: 1_799_999_000, step: 7 };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(encodeCursor({ ...c, coveredSec: null }))).toEqual({ ...c, coveredSec: null });
    for (const bad of ['', 'gm1.x.1.2.3', 'gm2.1.1.1.1', 'gm1.1.1.1', undefined, null]) expect(decodeCursor(bad as string)).toBeNull();
  });

  it('positions are causal tokens that grow with every step, window and completion', () => {
    const open1 = cursorPosition({ coveredSec: 100, windowEndSec: 200, windowLowerSec: 50, step: 1 });
    const open2 = cursorPosition({ coveredSec: 100, windowEndSec: 200, windowLowerSec: 50, step: 2 });
    const done = cursorPosition({ coveredSec: 200, windowEndSec: 0, windowLowerSec: 0, step: 3 });
    const next = cursorPosition({ coveredSec: 200, windowEndSec: 300, windowLowerSec: 150, step: 4 });
    expect(compareCausalOrder(open1, open2)).toBe(-1);
    expect(compareCausalOrder(open2, done)).toBe(-1);
    expect(compareCausalOrder(done, next)).toBe(-1);
  });

  it('echo recognition hashes whitespace-normalised text only', () => {
    expect(textHash('Hello   world\n')).toBe(textHash(' Hello world'));
    expect(textHash('Hello world')).not.toBe(textHash('Hello world!'));
  });
});

describe('production transport shell', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is honest about what the Composio reply tool cannot do', () => {
    expect(createGmailTransport({ fetchGmailMessages, fetchGmailProfile, sendGmailReply } as unknown as import('../../gmail.js').GmailApi).features).toEqual({ explicitThreadingHeaders: false, outgoingReplyTo: false, sentLookup: false });
    expect(createGmailTransport({ fetchGmailMessages, fetchGmailProfile, sendGmailReply } as unknown as import('../../gmail.js').GmailApi).findSent).toBeUndefined();
  });

  it('listPage / getProfile go through gmail.ts and nowhere else', async () => {
    fetchGmailMessages.mockResolvedValue({ messages: [], nextPageToken: 'n' });
    fetchGmailProfile.mockResolvedValue({ emailAddress: 'shop@gmail.com' });
    const t = createGmailTransport({ fetchGmailMessages, fetchGmailProfile, sendGmailReply } as unknown as import('../../gmail.js').GmailApi);
    expect(await t.listPage(target, { query: 'q', maxResults: 25, pageToken: 'p' })).toEqual({ messages: [], nextPageToken: 'n' });
    expect(fetchGmailMessages).toHaveBeenCalledWith(target, { query: 'q', maxResults: 25, pageToken: 'p' });
    expect(await t.getProfile(target)).toEqual({ emailAddress: 'shop@gmail.com' });
  });

  it('send: one primary recipient + CC + body to the thread; the id and thread come back; the attempt token never leaves', async () => {
    sendGmailReply.mockResolvedValue({ gmailMessageId: 'g1', gmailThreadId: 't1' });
    const out = await createGmailTransport({ fetchGmailMessages, fetchGmailProfile, sendGmailReply } as unknown as import('../../gmail.js').GmailApi).send(target, {
      threadId: 't1',
      to: ['a@example.com'],
      cc: ['b@example.com'],
      subject: 'Re: x',
      body: 'text',
      inReplyTo: '<m@x>',
      attemptToken: 'care-token-1',
    });
    expect(out).toEqual({ messageId: 'g1', threadId: 't1' });
    expect(sendGmailReply).toHaveBeenCalledWith(target, { gmailThreadId: 't1', to: 'a@example.com', cc: ['b@example.com'], body: 'text' });
  });

  it('several primary recipients are refused before anything is called', async () => {
    await expect(createGmailTransport({ fetchGmailMessages, fetchGmailProfile, sendGmailReply } as unknown as import('../../gmail.js').GmailApi).send(target, { threadId: 't', to: ['a@x.com', 'b@x.com'], cc: [], subject: 's', body: 'b', attemptToken: 'care-token-2' })).rejects.toMatchObject({ kind: 'rejected' });
    expect(sendGmailReply).not.toHaveBeenCalled();
  });

  it('typed provider errors become the port vocabulary; everything else on a send is ambiguous', async () => {
    const now = Date.UTC(2027, 0, 1, 10, 30);
    expect(mapGmailError(new EmailBudgetExceeded(10, 10), now)).toMatchObject({ kind: 'budget_exhausted', retryAtMs: Date.UTC(2027, 0, 1, 11) });
    expect(mapGmailError(new ComposioRateLimitError())).toMatchObject({ kind: 'rate_limited' });
    expect(mapGmailError(new ComposioConnectionExpiredError())).toMatchObject({ kind: 'connection_expired' });
    expect(mapGmailError(new ComposioAuthError())).toMatchObject({ kind: 'auth' });
    expect(mapGmailError(new Error('Invalid page_token supplied'))).toMatchObject({ kind: 'invalid_page_token' });
    expect(mapGmailError(new Error('socket hang up'))).toMatchObject({ kind: 'ambiguous' });

    // a "page token" wording on a SEND says nothing about whether it went out
    sendGmailReply.mockRejectedValue(new Error('bad request: page_token'));
    await expect(createGmailTransport({ fetchGmailMessages, fetchGmailProfile, sendGmailReply } as unknown as import('../../gmail.js').GmailApi).send(target, { threadId: 't', to: ['a@x.com'], cc: [], subject: 's', body: 'b', attemptToken: 'care-token-3' })).rejects.toMatchObject({ kind: 'ambiguous' });
    // provider text is never forwarded
    expect(mapGmailError(new Error('leaks user@private.com')).message).not.toContain('private.com');
    expect(isDefinitePreSendFailure('ambiguous')).toBe(false);
    expect(isDefinitePreSendFailure('rate_limited')).toBe(true);
    expect(new EmailTransportError('rejected', 'x').kind).toBe('rejected');
  });
});

describe('provider order fields (additive in parse.ts)', () => {
  const raw = { messageId: 'm1', threadId: 't1', labelIds: ['INBOX'] };
  it('keeps internalDate / historyId when present and is unchanged when absent', () => {
    expect(normalizeGmailMessage({ ...raw, internalDate: '1800000000123', historyId: '98765' })).toMatchObject({ internalDateMs: 1800000000123, historyId: '98765' });
    const bare = normalizeGmailMessage(raw)!;
    expect('internalDateMs' in bare).toBe(false);
    expect('historyId' in bare).toBe(false);
    expect('internalDateMs' in normalizeGmailMessage({ ...raw, internalDate: 'x' })!).toBe(false);
  });
  it('the entity id default is the one gmail.ts uses', () => {
    expect(EMAIL_ENTITY_ID).toBe('aios-gmail');
  });
});
