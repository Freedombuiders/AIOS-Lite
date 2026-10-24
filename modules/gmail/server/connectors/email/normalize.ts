/**
 * Gmail message -> Care `NormalizedMessage` (pure).
 *
 * Preserved from the legacy rows, kept SEPARATE on purpose:
 *  - sender (`metadata.from`, `senderIdentityKey`) vs Reply-To (`metadata.replyTo`): the customer
 *    identity is the sender; a different Reply-To is where an answer should go, never who they are;
 *  - thread = conversation (the Gmail thread id), message = Gmail message id in `gmail_mailbox`;
 *  - RFC Message-ID / In-Reply-To / References, plain + HTML body, labels, category, automated state;
 *  - attachments are METADATA only (no url, no download support is advertised).
 * BCC is never read: it is a private delivery envelope of the sending account.
 */

import { detectAutomated, gmailCategory } from '../../parse.js';
import type { CareAttachmentDescriptor, CareOrigin, CareSenderRole, EmailMetadata, NormalizedMessage } from '../../../../_lib/care-kit/types.js';
import type { GmailMessage } from './transport.js';
import { GMAIL_BOX, type WindowKind } from './window.js';

/**
 * Live-care boundary (legacy `origin = sentAtMs >= care_since*1000 ? 'live' : 'backfill'`, where
 * Care's name for 'backfill' is 'history'). A deliberate full re-read (`full_backfill`) that finds
 * mail newer than the boundary labels it `recovery`: it was missed, so it is provenance, never a
 * trigger for an automatic turn.
 */
export function classifyOrigin(sentAtMs: number, careSinceMs: number | null, kind: WindowKind): CareOrigin {
  if (careSinceMs == null || sentAtMs < careSinceMs) return 'history';
  return kind === 'full_backfill' ? 'recovery' : 'live';
}

export function isOutbound(msg: Pick<GmailMessage, 'labelIds'>): boolean {
  return msg.labelIds.includes('SENT');
}

export function isDraft(msg: Pick<GmailMessage, 'labelIds'>): boolean {
  return msg.labelIds.includes('DRAFT');
}

export function attachmentDescriptors(msg: Pick<GmailMessage, 'attachments'>): CareAttachmentDescriptor[] {
  return msg.attachments.map((a) => ({
    id: a.attachmentId,
    mimeType: a.mimeType,
    fileName: a.filename,
    sizeBytes: a.size,
  }));
}

export interface NormalizeInput {
  accountId: string;
  msg: GmailMessage;
  origin: CareOrigin;
  /** Outbound mail only: who sent it (our agent/operator via an attempt, or the owner elsewhere). */
  outboundRole?: Exclude<CareSenderRole, 'customer'>;
  extraAutomatedPatterns: string[];
}

export function toNormalizedMessage(input: NormalizeInput): NormalizedMessage {
  const { msg } = input;
  const outbound = isOutbound(msg);
  const references = (msg.headers['references'] ?? '').split(/\s+/).filter(Boolean);
  const automated = outbound ? null : detectAutomated(msg, input.extraAutomatedPatterns);
  const category = outbound ? '' : gmailCategory(msg.labelIds);

  const metadata: EmailMetadata = {
    type: 'email',
    subject: msg.subject,
    from: msg.fromEmail,
    ...(msg.fromName ? { fromName: msg.fromName } : {}),
    to: [...msg.to],
    ...(msg.cc.length > 0 ? { cc: [...msg.cc] } : {}),
    ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
    ...(msg.headers['message-id'] ? { messageIdHeader: msg.headers['message-id'] } : {}),
    ...(msg.headers['in-reply-to'] ? { inReplyToHeader: msg.headers['in-reply-to'] } : {}),
    ...(references.length > 0 ? { referencesHeaders: references } : {}),
    isAutomated: automated != null,
    ...(automated ? { automatedReason: automated } : {}),
    ...(category ? { category } : {}),
    headers: { ...msg.headers },
    attachments: attachmentDescriptors(msg),
    ...(msg.bodyHtml ? { bodyHtml: msg.bodyHtml } : {}),
    labels: [...msg.labelIds],
    ...(msg.snippet ? { snippet: msg.snippet } : {}),
  };

  return {
    accountId: input.accountId,
    externalConversationKey: msg.gmailThreadId,
    nativeMessageNamespace: GMAIL_BOX,
    nativeMessageId: msg.gmailMessageId,
    // Identity = the sender address, never the Reply-To. Outbound mail has no customer identity.
    senderIdentityKey: outbound ? null : msg.fromEmail || null,
    senderRole: outbound ? (input.outboundRole ?? 'self') : 'customer',
    direction: outbound ? 'out' : 'in',
    origin: input.origin,
    sentAtMs: msg.sentAtMs,
    // Gmail messages are immutable: there is no edit version.
    nativeVersion: null,
    // Provider receive time (internalDate, ms) is the adapter's order token; absent => unordered.
    // (historyId is NOT used: it moves when labels change.)
    ...(msg.internalDateMs !== undefined ? { nativeOrder: String(msg.internalDateMs) } : {}),
    text: msg.bodyText,
    metadata,
  };
}
