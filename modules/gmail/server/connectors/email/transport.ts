/**
 * Email transport port for the Care Gmail connector.
 *
 * The connector never talks to Composio itself. It talks to this port; the production adapter
 * (`gmail-transport.ts`) is a thin shell over `src/email/gmail.ts`, the ONLY provider exit
 * (budget + connection accounting), so no second Composio client or key path can appear. Tests
 * use `fake-transport.ts`.
 *
 * Failure vocabulary (what the connector may conclude from each):
 *  - rate_limited / budget_exhausted / connection_expired / auth / rejected were raised BEFORE
 *    the provider executed anything -> definite, nothing was sent;
 *  - invalid_page_token is a read-side hint to restart the window from page one;
 *  - ambiguous is everything else (timeout, dropped connection, unknown error, a "successful"
 *    answer without a message id): the provider MAY have acted, so a send is `uncertain`.
 */

import type { GmailMessage } from '../../parse.js';

export type { GmailMessage };

/** The Composio connection that holds the mailbox. */
export interface EmailTarget {
  connectionId: string;
  entityId: string;
}

export interface EmailListRequest {
  /** Absolute-bound Gmail query (`after:<epoch s> before:<epoch s> {in:inbox in:sent}`). */
  query: string;
  maxResults: number;
  pageToken?: string;
}

export interface EmailListPage {
  messages: GmailMessage[];
  nextPageToken: string | null;
}

export interface EmailSendRequest {
  /** Gmail thread the reply belongs to (the Care conversation key). */
  threadId: string;
  /** Exactly one primary recipient is supported by the production adapter. */
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  /** RFC Message-ID of the mail being answered. Providers that cannot set it must say so in `features`. */
  inReplyTo?: string;
  references?: string[];
  /** Reply-To of the OUTGOING mail (not the address the customer asked us to answer). */
  replyTo?: string;
  /** Persisted attempt token. A provider that can carry it (header, Message-ID) makes `findSent` possible. */
  attemptToken: string;
}

export interface EmailSendReceipt {
  messageId: string;
  threadId: string;
}

export interface EmailSentEvidence {
  messageId: string;
  threadId: string;
  sentAtMs?: number;
}

export interface EmailTransportFeatures {
  /** In-Reply-To / References headers are honoured exactly as given. */
  explicitThreadingHeaders: boolean;
  /** A Reply-To header on the outgoing mail is honoured. */
  outgoingReplyTo: boolean;
  /** `findSent` can find a message by attempt token (real provider evidence for reconcile). */
  sentLookup: boolean;
}

export interface EmailTransport {
  readonly features: EmailTransportFeatures;
  listPage(target: EmailTarget, request: EmailListRequest): Promise<EmailListPage>;
  send(target: EmailTarget, request: EmailSendRequest): Promise<EmailSendReceipt>;
  getProfile(target: EmailTarget): Promise<{ emailAddress: string }>;
  /** Only when `features.sentLookup`: the provider message that carries `attemptToken`, if any. */
  findSent?(target: EmailTarget, query: { attemptToken: string; threadId: string }): Promise<EmailSentEvidence | null>;
  /** Optional: release anything the transport holds (process shutdown). The Composio transport is stateless and has none. */
  close?(): void | Promise<void>;
}

export type EmailTransportFailure =
  | 'rate_limited'
  | 'budget_exhausted'
  | 'connection_expired'
  | 'auth'
  | 'invalid_page_token'
  | 'rejected'
  | 'ambiguous';

export class EmailTransportError extends Error {
  constructor(
    public readonly kind: EmailTransportFailure,
    message: string,
    /** Earliest wall-clock ms at which a retry makes sense (rate limit / budget window), when known. */
    public readonly retryAtMs?: number,
  ) {
    super(message);
    this.name = 'EmailTransportError';
  }
}

/** Failures that prove nothing left the process / reached Gmail. */
export function isDefinitePreSendFailure(kind: EmailTransportFailure): boolean {
  return kind !== 'ambiguous' && kind !== 'invalid_page_token';
}
