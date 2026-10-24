/**
 * Production `EmailTransport`: a thin shell over `src/email/gmail.ts`.
 *
 * `gmail.ts` stays the ONLY provider exit (hourly budget check, call accounting, Composio client
 * and key handling). This file adds no network code, no key reads and no Composio client; it only
 * translates between the port and those functions and maps their typed errors to the port's
 * failure vocabulary.
 *
 * What the Composio reply tool cannot do (reported honestly through `features`):
 *  - GMAIL_REPLY_TO_THREAD derives In-Reply-To/References from the thread itself, so explicit
 *    threading headers and a custom Reply-To cannot be set;
 *  - there is no custom header or Message-ID control, so the attempt token cannot ride on the mail
 *    and no provider-side lookup by token exists (`sentLookup: false`);
 *  - exactly one primary recipient (+ CC), no BCC.
 * Because the tool reports failures as plain error text, the only errors treated as "nothing was
 * sent" are the typed ones raised before/at the Composio boundary (budget, rate limit, expired,
 * key); any other failure of a send is ambiguous.
 */

import { EmailBudgetExceeded, type GmailApi } from '../../gmail.js';
import {
  ComposioAuthError,
  ComposioConnectionExpiredError,
  ComposioRateLimitError,
} from '../../../../_lib/composio.js';
import {
  EmailTransportError,
  type EmailListPage,
  type EmailListRequest,
  type EmailSendReceipt,
  type EmailSendRequest,
  type EmailTarget,
  type EmailTransport,
} from './transport.js';
import { nextHourMs } from './window.js';

const PAGE_TOKEN_ERROR = /page[_ -]?token|invalid (argument|request|cursor)|bad request|unknown (cursor|token)/i;

export function mapGmailError(err: unknown, nowMs: number = Date.now()): EmailTransportError {
  if (err instanceof EmailTransportError) return err;
  if (err instanceof EmailBudgetExceeded) return new EmailTransportError('budget_exhausted', err.name, nextHourMs(nowMs));
  if (err instanceof ComposioRateLimitError) return new EmailTransportError('rate_limited', err.name);
  if (err instanceof ComposioConnectionExpiredError) return new EmailTransportError('connection_expired', err.name);
  if (err instanceof ComposioAuthError) return new EmailTransportError('auth', err.name);
  const message = err instanceof Error ? err.message : String(err);
  // Never forward provider text: it can carry addresses and mail content.
  return new EmailTransportError(PAGE_TOKEN_ERROR.test(message) ? 'invalid_page_token' : 'ambiguous', err instanceof Error ? err.name : 'Error');
}

export function createGmailTransport(api: GmailApi, now: () => number = () => Date.now()): EmailTransport {
  const { fetchGmailMessages, fetchGmailProfile, sendGmailReply } = api;
  return {
    features: { explicitThreadingHeaders: false, outgoingReplyTo: false, sentLookup: false },

    async listPage(target: EmailTarget, req: EmailListRequest): Promise<EmailListPage> {
      try {
        return await fetchGmailMessages(target, {
          query: req.query,
          maxResults: req.maxResults,
          ...(req.pageToken ? { pageToken: req.pageToken } : {}),
        });
      } catch (err) {
        throw mapGmailError(err, now());
      }
    },

    async send(target: EmailTarget, req: EmailSendRequest): Promise<EmailSendReceipt> {
      if (req.to.length !== 1) throw new EmailTransportError('rejected', 'the reply tool takes exactly one primary recipient');
      try {
        const sent = await sendGmailReply(target, { gmailThreadId: req.threadId, to: req.to[0], cc: req.cc, body: req.body });
        return { messageId: sent.gmailMessageId, threadId: sent.gmailThreadId };
      } catch (err) {
        const mapped = mapGmailError(err, now());
        // A page-token style message on a SEND means nothing about the token: it may have been sent.
        throw mapped.kind === 'invalid_page_token' ? new EmailTransportError('ambiguous', mapped.message) : mapped;
      }
    },

    async getProfile(target: EmailTarget): Promise<{ emailAddress: string }> {
      try {
        return await fetchGmailProfile(target);
      } catch (err) {
        throw mapGmailError(err, now());
      }
    },
  };
}
