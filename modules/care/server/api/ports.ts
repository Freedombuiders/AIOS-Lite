/**
 * Injected ports for the Care API. The API layer owns request validation and target resolution;
 * the durable intent, payload hash, idempotency, gates and delivery belong to the implementer
 * (CC-11). Until a port is provided the reply/outbox routes answer 501.
 */

import type { CareOutboxIntentDto } from './dto.js';
import type { CareChannel } from '../../../_lib/care-kit/types.js';

/** Immutable chat target, resolved from the stored conversation, never taken from the client. */
export interface CareChatReplyTarget {
  kind: 'chat';
  externalConversationKey: string;
  replyToMessageId?: string;
  topicId?: string;
}

export interface CareEmailReplyTarget {
  kind: 'email';
  externalConversationKey: string;
  to: string[];
  cc?: string[];
  subject: string;
  replyToMessageId?: string;
  inReplyToHeader?: string;
}

export interface CareReplyRequest {
  /** Idempotency key. Same key + same payload returns the same intent; same key + other payload is a 409. */
  clientRequestId: string;
  conversationId: string;
  accountId: string;
  channel: CareChannel;
  purpose: 'care';
  actor: 'manual';
  text: string;
  target: CareChatReplyTarget | CareEmailReplyTarget;
  /** Private delivery envelope; only ever present for email. The port enforces the `bcc` capability. */
  bcc?: string[];
  /** Conversation revision the operator saw; the port may use it for stale-context checks. */
  expectedConversationRevision?: number;
}

export interface CareReplyAcceptance {
  intent: CareOutboxIntentDto;
  /** True when `clientRequestId` had already produced an intent. */
  duplicate: boolean;
}

/**
 * Port contract. Implementations throw `CareError` for expected failures (UNSUPPORTED_CAPABILITY,
 * DUPLICATE_REQUEST_PAYLOAD_MISMATCH, SEND_DISABLED, ...); the API maps them to the error
 * envelope with fixed messages. `getOutbox` returns null for an unknown ID.
 */
export interface CareReplyPort {
  submitReply(request: CareReplyRequest): Promise<CareReplyAcceptance>;
  getOutbox(intentId: string): Promise<CareOutboxIntentDto | null>;
  cancel(intentId: string): Promise<CareOutboxIntentDto | null>;
  reconcile(intentId: string): Promise<CareOutboxIntentDto | null>;
}
