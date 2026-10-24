/**
 * Fake Gmail transport for tests: an in-memory mailbox that honours the absolute-bound query
 * (`after:` inclusive, `before:` exclusive, epoch seconds), pages with opaque tokens bound to a
 * query, and fails on demand. Synthetic only; it can never reach a network or a Composio key.
 *
 * Provider honesty:
 *  - `lost-ack` / `ambiguous-before`: the first has the side effect and then throws an ambiguous
 *    error, the second throws before any effect; the connector cannot tell them apart;
 *  - sent mail lands in the mailbox with the SENT label (the "echo") when `echoSent` is on;
 *  - `findSent` only exists when `features.sentLookup` is on, like a provider that carries the token.
 */

import {
  EmailTransportError,
  type EmailListPage,
  type EmailListRequest,
  type EmailSendReceipt,
  type EmailSendRequest,
  type EmailSentEvidence,
  type EmailTarget,
  type EmailTransport,
  type EmailTransportFeatures,
  type GmailMessage,
} from './transport.js';

export type FakeSendMode =
  | 'normal'
  | 'lost-ack'
  | 'ambiguous-before'
  | 'no-id'
  | 'rate-limit'
  | 'budget'
  | 'expired'
  | 'auth'
  | 'reject';

let seq = 0;

export function gmailMessage(over: Partial<GmailMessage> & { sentAtMs: number }): GmailMessage {
  seq += 1;
  return {
    gmailMessageId: `m${seq}`,
    gmailThreadId: `t${seq}`,
    labelIds: ['INBOX'],
    fromEmail: 'buyer@example.com',
    fromName: '',
    replyTo: '',
    to: ['shop@example.com'],
    cc: [],
    subject: 'Question about my order',
    bodyText: 'Hello, where is my parcel?',
    bodyHtml: '',
    snippet: 'Hello, where is my parcel?',
    headers: {},
    attachments: [],
    ...over,
  };
}

interface ListRecord {
  query: string;
  pageToken: string | null;
}

export class FakeEmailTransport implements EmailTransport {
  features: EmailTransportFeatures = { explicitThreadingHeaders: true, outgoingReplyTo: false, sentLookup: false };

  /** Newest-first in listings, like Gmail. Hidden messages exist but are not listed yet (late arrival). */
  readonly mailbox: GmailMessage[] = [];
  private readonly hidden = new Set<string>();
  readonly listCalls: ListRecord[] = [];
  readonly sendCalls: EmailSendRequest[] = [];
  readonly profileCalls: EmailTarget[] = [];
  /** Provider-side effects of sends (a lost ack still counts: the mail is out). */
  sentCount = 0;

  profileAddress = 'shop@example.com';
  clock = { nowMs: Date.now() };
  /** Sent mail appears in the mailbox's SENT (the echo the sync sees). */
  echoSent = true;
  sendMode: FakeSendMode = 'normal';
  /** Optional hint carried by rate-limit / budget errors (epoch ms). */
  retryAtMs: number | undefined;

  /** Errors thrown by the next list calls (consumed one per call, `null` = let the call pass). */
  listFailures: Array<Error | null> = [];
  /** Fail the list call with this 1-based number within the current test (cumulative). */
  failListCall: { n: number; error: Error } | null = null;
  /** Reject the next page token it is given (token restart). */
  rejectNextToken = false;
  profileError: Error | null = null;
  /** When set, a send that already had its provider-side effect waits here before it answers (an in-flight RPC). */
  sendGate: Promise<void> | null = null;

  private tokenSeq = 0;
  private readonly tokens = new Map<string, { query: string; offset: number }>();
  private readonly tokenIndex = new Map<string, EmailSentEvidence>();
  private listCallCount = 0;

  deliver(msg: GmailMessage, opts: { hidden?: boolean } = {}): GmailMessage {
    this.mailbox.push(msg);
    if (opts.hidden) this.hidden.add(msg.gmailMessageId);
    return msg;
  }

  reveal(gmailMessageId: string): void {
    this.hidden.delete(gmailMessageId);
  }

  private matches(msg: GmailMessage, query: string): boolean {
    const after = /after:(\d+)/.exec(query);
    const before = /before:(\d+)/.exec(query);
    const sec = Math.floor(msg.sentAtMs / 1000);
    if (after && sec < Number(after[1])) return false;
    if (before && sec >= Number(before[1])) return false;
    const wantsInbox = /in:inbox/.test(query);
    const wantsSent = /in:sent/.test(query);
    const labelOk = (wantsInbox && msg.labelIds.includes('INBOX')) || (wantsSent && msg.labelIds.includes('SENT'));
    return !(wantsInbox || wantsSent) || labelOk;
  }

  async listPage(_target: EmailTarget, req: EmailListRequest): Promise<EmailListPage> {
    this.listCallCount += 1;
    this.listCalls.push({ query: req.query, pageToken: req.pageToken ?? null });
    if (this.failListCall && this.failListCall.n === this.listCallCount) throw this.failListCall.error;
    const scripted = this.listFailures.shift();
    if (scripted) throw scripted;

    let offset = 0;
    if (req.pageToken) {
      const t = this.tokens.get(req.pageToken);
      if (this.rejectNextToken || !t || t.query !== req.query) {
        this.rejectNextToken = false;
        throw new EmailTransportError('invalid_page_token', 'page token rejected');
      }
      offset = t.offset;
    }
    const all = this.mailbox
      .filter((m) => !this.hidden.has(m.gmailMessageId) && this.matches(m, req.query))
      .sort((a, b) => b.sentAtMs - a.sentAtMs || (a.gmailMessageId < b.gmailMessageId ? 1 : -1));
    const slice = all.slice(offset, offset + req.maxResults);
    let next: string | null = null;
    if (offset + req.maxResults < all.length) {
      this.tokenSeq += 1;
      next = `pt-${this.tokenSeq}`;
      this.tokens.set(next, { query: req.query, offset: offset + req.maxResults });
    }
    return { messages: slice.map((m) => ({ ...m, headers: { ...m.headers }, attachments: [...m.attachments] })), nextPageToken: next };
  }

  async send(target: EmailTarget, req: EmailSendRequest): Promise<EmailSendReceipt> {
    void target;
    this.sendCalls.push(req);
    const mode = this.sendMode;
    switch (mode) {
      case 'rate-limit':
        throw new EmailTransportError('rate_limited', 'slow down', this.retryAtMs);
      case 'budget':
        throw new EmailTransportError('budget_exhausted', 'hourly budget spent', this.retryAtMs);
      case 'expired':
        throw new EmailTransportError('connection_expired', 'token revoked');
      case 'auth':
        throw new EmailTransportError('auth', 'key rejected');
      case 'reject':
        throw new EmailTransportError('rejected', 'recipient refused');
      case 'ambiguous-before':
        throw new EmailTransportError('ambiguous', 'socket hang up');
      default:
        break;
    }
    // From here the mail is out.
    this.sentCount += 1;
    const id = `sent-${this.sentCount}`;
    const sent = gmailMessage({
      gmailMessageId: id,
      gmailThreadId: req.threadId,
      labelIds: ['SENT'],
      fromEmail: this.profileAddress,
      to: [...req.to],
      cc: [...req.cc],
      subject: req.subject,
      bodyText: req.body,
      snippet: req.body.slice(0, 80),
      headers: req.inReplyTo ? { 'in-reply-to': req.inReplyTo } : {},
      sentAtMs: this.clock.nowMs,
    });
    if (this.echoSent) this.mailbox.push(sent);
    this.tokenIndex.set(req.attemptToken, { messageId: id, threadId: req.threadId, sentAtMs: sent.sentAtMs });
    if (this.sendGate) await this.sendGate;
    if (mode === 'lost-ack') throw new EmailTransportError('ambiguous', 'connection reset after write');
    if (mode === 'no-id') return { messageId: '', threadId: req.threadId };
    return { messageId: id, threadId: req.threadId };
  }

  async getProfile(target: EmailTarget): Promise<{ emailAddress: string }> {
    this.profileCalls.push(target);
    if (this.profileError) throw this.profileError;
    return { emailAddress: this.profileAddress };
  }

  async findSent(_target: EmailTarget, q: { attemptToken: string; threadId: string }): Promise<EmailSentEvidence | null> {
    const hit = this.tokenIndex.get(q.attemptToken);
    return hit && hit.threadId === q.threadId ? hit : null;
  }
}
