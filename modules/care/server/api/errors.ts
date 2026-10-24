/**
 * Error envelope for /api/m/care. Every failure answers `{code, message, retryAt?, currentRevision?}`
 * with a FIXED message per code: raw provider text, SQL errors, stack traces and field values
 * never reach the browser. The original error goes to the optional `onError` hook (server logs).
 */

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { CareError } from '../../../_lib/care-kit/errors.js';
import type { CareApiError, CareApiErrorCode } from './dto.js';

export class ApiError extends Error {
  constructor(
    public readonly code: CareApiErrorCode,
    public readonly status: ContentfulStatusCode,
    message?: string,
    public readonly extra: { retryAt?: number; currentRevision?: number; details?: CareApiError['details'] } = {},
  ) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}

const PUBLIC: Record<CareApiErrorCode, { status: ContentfulStatusCode; message: string }> = {
  UNSUPPORTED_CAPABILITY: { status: 422, message: 'This capability is not available for the selected channel or account.' },
  STALE_REVISION: { status: 409, message: 'The record changed since it was loaded. Reload and try again.' },
  DUPLICATE_REQUEST_PAYLOAD_MISMATCH: { status: 409, message: 'This request ID was already used with a different payload.' },
  ACCOUNT_FROZEN: { status: 409, message: 'The account is frozen.' },
  SEND_DISABLED: { status: 403, message: 'Sending is disabled for this account.' },
  SYNC_DISABLED: { status: 403, message: 'Sync is disabled for this account.' },
  UNRESOLVED_UNCERTAINTY: { status: 409, message: 'A previous delivery is unresolved. Reconcile it first.' },
  CREDENTIAL_DECODE_FAILED: { status: 503, message: 'Stored credentials are unavailable.' },
  RATE_LIMITED: { status: 429, message: 'Rate limited. Try again later.' },
  FENCING_REJECTED: { status: 409, message: 'The account owner changed. Reload and try again.' },
  INVALID_TARGET: { status: 400, message: 'The target is invalid.' },
  INVALID_CURSOR: { status: 400, message: 'The cursor is invalid.' },
  INVALID_COMMAND: { status: 400, message: 'The request is invalid.' },
  CONFIGURATION_CONFLICT: { status: 409, message: 'The request conflicts with the current configuration.' },
  NOT_FOUND: { status: 404, message: 'Not found.' },
  TERMINAL_REJECTION: { status: 422, message: 'The request was rejected.' },
  NETWORK_TIMEOUT: { status: 504, message: 'The upstream service timed out.' },
  READ_DISABLED: { status: 403, message: 'Reading Customer Care data is disabled.' },
  READ_MODEL_UNAVAILABLE: { status: 503, message: 'The Customer Care read model is not available.' },
  STORE_UNAVAILABLE: { status: 503, message: 'The Customer Care store is not available.' },
  INTERNAL_ERROR: { status: 500, message: 'Internal error.' },
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function detail(details: unknown, key: string): number | undefined {
  return details && typeof details === 'object' ? finiteNumber((details as Record<string, unknown>)[key]) : undefined;
}

const REASON = /^[A-Z][A-Z0-9_]{1,63}$/;
const SAFE_ID = /^[A-Za-z0-9_.:@-]{1,256}$/;

/**
 * Only an UPPER_SNAKE `reason` and, for UNDECIDED_ITEMS, a strictly re-shaped list of IDs cross the wire.
 * Anything else a service put into `details` (free text, raw values) is dropped.
 */
function safeDetails(details: unknown): CareApiError['details'] | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const d = details as Record<string, unknown>;
  if (typeof d.reason !== 'string' || !REASON.test(d.reason)) return undefined;
  const out: NonNullable<CareApiError['details']> = { reason: d.reason };
  if (d.reason === 'UNDECIDED_ITEMS' && Array.isArray(d.items)) {
    out.items = d.items.slice(0, 200).flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return [];
      const i = raw as Record<string, unknown>;
      const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && SAFE_ID.test(x)) : []);
      if (typeof i.itemKey !== 'string' || typeof i.id !== 'string') return [];
      return [
        {
          itemKey: i.itemKey.slice(0, 300),
          type: typeof i.type === 'string' ? i.type.slice(0, 32) : 'unknown',
          id: i.id.slice(0, 256),
          accountId: typeof i.accountId === 'string' ? i.accountId : null,
          candidateCustomerIds: ids(i.candidateCustomerIds),
        },
      ];
    });
  }
  return out;
}

/** Normalises any thrown value into `{status, body}`. Never reflects the original message. */
export function toEnvelope(err: unknown): { status: ContentfulStatusCode; body: CareApiError } {
  if (err instanceof ApiError) {
    const pub = PUBLIC[err.code];
    return {
      status: err.status,
      body: {
        code: err.code,
        message: err.message === err.code ? pub.message : err.message,
        ...(err.extra.retryAt !== undefined ? { retryAt: err.extra.retryAt } : {}),
        ...(err.extra.currentRevision !== undefined ? { currentRevision: err.extra.currentRevision } : {}),
        ...(err.extra.details ? { details: err.extra.details } : {}),
      },
    };
  }
  if (err instanceof CareError) {
    const pub = PUBLIC[err.code] ?? PUBLIC.INTERNAL_ERROR;
    // Cross-account / missing targets always read as 404 so existence is not an oracle.
    const status: ContentfulStatusCode = err.status === 404 ? 404 : pub.status;
    const retryAt = detail(err.details, 'retryAt');
    const currentRevision = detail(err.details, 'currentRevision');
    const safe = safeDetails(err.details);
    return {
      status,
      body: {
        code: err.status === 404 ? 'NOT_FOUND' : err.code,
        message: err.status === 404 ? PUBLIC.NOT_FOUND.message : pub.message,
        ...(retryAt !== undefined ? { retryAt } : {}),
        ...(currentRevision !== undefined ? { currentRevision } : {}),
        ...(safe && err.status !== 404 ? { details: safe } : {}),
      },
    };
  }
  // better-sqlite3 failures (missing table on a pre-Care store, locked file, ...) carry SQLite text.
  const sqliteCode = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  if (typeof sqliteCode === 'string' && sqliteCode.startsWith('SQLITE_')) {
    const pub = PUBLIC.STORE_UNAVAILABLE;
    return { status: pub.status, body: { code: 'STORE_UNAVAILABLE', message: pub.message } };
  }
  const pub = PUBLIC.INTERNAL_ERROR;
  return { status: pub.status, body: { code: 'INTERNAL_ERROR', message: pub.message } };
}

export function errorResponse(c: Context, err: unknown, onError?: (err: unknown) => void): Response {
  const { status, body } = toEnvelope(err);
  // Expected client errors are not logged; unexpected ones go to the hook with the real error.
  if (onError && (status >= 500 || !(err instanceof CareError || err instanceof ApiError))) {
    try {
      onError(err);
    } catch {
      /* logging must never break the response */
    }
  }
  return c.json(body, status);
}

export const notFound = (): ApiError => new ApiError('NOT_FOUND', 404, PUBLIC.NOT_FOUND.message);
export const invalid = (message = PUBLIC.INVALID_COMMAND.message): ApiError => new ApiError('INVALID_COMMAND', 400, message);
export const invalidCursor = (): ApiError => new ApiError('INVALID_CURSOR', 400, PUBLIC.INVALID_CURSOR.message);
export const capability = (message = PUBLIC.UNSUPPORTED_CAPABILITY.message): ApiError =>
  new ApiError('UNSUPPORTED_CAPABILITY', 422, message);
