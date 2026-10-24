/** Shared request context + parsing helpers for the /api/m/care route groups. */

import type { Context } from 'hono';
import type { ZodType } from 'zod';
import { invalid, capability } from './errors.js';
import type { CareReplyPort } from './ports.js';
import type { CareReadModel } from './read-model.js';
import type { CareApiChannel } from './dto.js';
import type { CareAccountRecord } from '../../../_lib/care-kit/types.js';
import type { CareCustomerOps } from '../application/customer-ops.js';
import type { CareMediaCache } from '../application/media-cache.js';
import type { CareOutboxService } from '../application/outbox-service.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import type { BacklogSource } from '../runtime/backlog.js';
import type { CareWorkflowService } from '../workflow/contract.js';

export interface CareApiContext {
  /** Throws a typed 503 when the store/handle is not available (never a raw SQLite error). */
  model(): CareReadModel;
  replyPort: CareReplyPort | undefined;
  now(): number;
  /** Per-account read gate (fail-closed: a throwing gate is a closed gate). Always explicit, never defaulted by a service. */
  canReadSource(accountId: string): boolean;
  /** Read-only mailbox signature of an email account (the same source the agent turn uses); null otherwise. */
  signatureOf(account: CareAccountRecord | null): string | null;
  /** Customer link/unlink/timeline service bound to `canReadSource`. */
  customerOps(): CareCustomerOps;
  /** CC-11 service; draft approve/discard answer 501 without it. */
  outbox: CareOutboxService | undefined;
  /** Extra backlog sources parked together with care_jobs when a switch comes back on. */
  backlogSources: BacklogSource[];
  /** Label recorded as the acting party on audited writes. Not an authorization identity. */
  actor: string;
  /** Inbox v2: workflow state, notes, canned replies. Throws a typed 503 like model() when the store is unavailable. */
  workflow(): CareWorkflowService;
  /** Stored copies of chat images; absent: the media route answers 404. */
  media: Pick<CareMediaCache, 'get'> | undefined;
  /** Channel connectors (names and avatars); absent: the profiles route answers 404 and rows carry no picture. */
  connectors: ConnectorRegistry | undefined;
}

const MAX_BODY_CHARS = 300_000;
const CHANNELS: readonly CareApiChannel[] = ['zalo', 'email'];

/** Parses and validates a JSON body. Failure text is fixed: field values are never echoed. */
export async function parseBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    throw invalid();
  }
  if (text.length > MAX_BODY_CHARS) throw invalid('The request body is too large.');
  let raw: unknown = {};
  if (text.trim().length > 0) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw invalid('The request body is not valid JSON.');
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalid('The request body failed validation.');
  return parsed.data;
}

/** An unknown channel is a capability error, never a silent fallback to another channel. */
export function parseChannel(raw: string | undefined | null): CareApiChannel | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (!(CHANNELS as readonly string[]).includes(raw)) throw capability('This channel is not supported.');
  return raw as CareApiChannel;
}
