// Normalises any thrown value from the Care client into one shape the UI can branch on.
// Pure (duck-typed) so it stays testable without the dashboard fetch helpers.

import type { CareApiErrorCode } from './dto';

export type CareFailureCode = CareApiErrorCode | 'NETWORK' | 'UNKNOWN';

export interface CareFailure {
  /** HTTP status, or 0 when no response arrived (offline, aborted, DNS). */
  status: number;
  code: CareFailureCode;
  message: string;
  retryAt?: number;
  currentRevision?: number;
  /** Stable UPPER_SNAKE reason (UNDECIDED_ITEMS, LEGACY_OWNED, PRIORITY_CONFLICT, MODULE_DISABLED...). */
  reason?: string;
  /** The scrubbed `details` object of the envelope (IDs and codes only). */
  details?: Record<string, unknown>;
}

const KNOWN: ReadonlySet<string> = new Set<string>([
  'UNSUPPORTED_CAPABILITY', 'STALE_REVISION', 'DUPLICATE_REQUEST_PAYLOAD_MISMATCH', 'ACCOUNT_FROZEN',
  'SEND_DISABLED', 'SYNC_DISABLED', 'UNRESOLVED_UNCERTAINTY', 'CREDENTIAL_DECODE_FAILED', 'RATE_LIMITED',
  'FENCING_REJECTED', 'INVALID_TARGET', 'INVALID_CURSOR', 'INVALID_COMMAND', 'CONFIGURATION_CONFLICT',
  'NOT_FOUND', 'TERMINAL_REJECTION', 'NETWORK_TIMEOUT', 'READ_DISABLED', 'READ_MODEL_UNAVAILABLE',
  'STORE_UNAVAILABLE', 'TELEGRAM_PROTOCOL_UNAVAILABLE', 'TELEGRAM_AUTH_FAILED', 'INTERNAL_ERROR',
]);

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function toCareFailure(err: unknown): CareFailure {
  const status = num((err as { status?: unknown } | null)?.status);
  if (status === undefined) {
    return { status: 0, code: 'NETWORK', message: err instanceof Error ? err.message : String(err) };
  }
  const body = (err as { body?: unknown }).body;
  const rec = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const rawCode = typeof rec.code === 'string' ? rec.code : '';
  // A 501 without our envelope (older server, proxy) still means "no such capability".
  const code: CareFailureCode = KNOWN.has(rawCode) ? (rawCode as CareApiErrorCode) : status === 501 ? 'UNSUPPORTED_CAPABILITY' : 'UNKNOWN';
  const details = rec.details && typeof rec.details === 'object' && !Array.isArray(rec.details) ? (rec.details as Record<string, unknown>) : undefined;
  const reason = details && typeof details.reason === 'string' ? details.reason : undefined;
  return {
    status,
    code,
    message: typeof rec.message === 'string' ? rec.message : `HTTP ${status}`,
    retryAt: num(rec.retryAt),
    currentRevision: num(rec.currentRevision),
    ...(reason ? { reason } : {}),
    ...(details ? { details } : {}),
  };
}

/** True when sending is simply not wired on the server (CC-11 not enabled): a state, not an error. */
export function isReplyUnavailable(f: CareFailure): boolean {
  return f.status === 501 || (f.code === 'UNSUPPORTED_CAPABILITY' && f.status !== 422);
}
