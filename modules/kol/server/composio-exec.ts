/**
 * The one exit from KOL Studio to the social platforms (Instagram, TikTok,
 * YouTube; Facebook goes through Content Studio). Every tool call goes through
 * executeTool(), which reuses Content Studio's Composio client (same key, same
 * upload allowlist FB_MEDIA_DIR) and maps failures to typed errors.
 *
 * Never log tool arguments or results: they carry captions, tokens and
 * account data. Only the slug, the duration and ok/failed are logged.
 *
 * Tests replace the executor with _setToolExecutor(); nothing in a unit test
 * may reach Composio.
 */

import {
  ComposioAuthError,
  ComposioConnectionExpiredError,
  ComposioRateLimitError,
  classifyComposioError,
  getComposio,
  hasComposioKey,
  listConnections,
  type ComposioConnection,
} from '../../_lib/composio.js';
import { logger } from './compat.js';

export { ComposioAuthError, ComposioConnectionExpiredError, ComposioRateLimitError, hasComposioKey };
export type { ComposioConnection };

export interface ExecTarget {
  /** Composio connected account id (kol_accounts.connection_id). */
  connectionId: string;
  /** Composio user_id owning that connection (kol_accounts.entity_id). */
  entityId: string;
}

export type ToolExecutor = (slug: string, args: Record<string, unknown>, target: ExecTarget) => Promise<unknown>;
export type ConnectionLister = (toolkit: string) => Promise<ComposioConnection[]>;

/**
 * Thrown by a platform adapter when a call that may already have made the
 * post public failed in a way that leaves the outcome unknown. The publisher
 * fails the target with UNCERTAIN_MESSAGE and never retries it.
 */
export class UncertainOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UncertainOutcomeError';
  }
}

/** Error texts that mean the connection's token is no longer usable (Composio's classifier misses some). */
const EXPIRED_HINTS = /access_token_invalid|invalid_grant|token (?:has been )?(?:revoked|invalidated)|NoActiveConnection|connected account (?:is )?(?:not active|inactive|disabled)|"code"\s*:\s*190\b/i;

/**
 * Content Studio's classifier treats any "expired" as an expired connection;
 * platforms also say "expired" about media (an Instagram container, a TikTok
 * upload URL). Only messages about the login itself mark an account EXPIRED.
 */
const AUTH_WORDS = /token|oauth|session|auth|credential|reauthori|connect|log ?in|"code"\s*:\s*190\b/i;

/** Maps any failure to ComposioAuthError / ComposioConnectionExpiredError / ComposioRateLimitError or a plain Error. */
export function classifyExecError(err: unknown): Error {
  const typed = classifyComposioError(err);
  if (typed instanceof ComposioConnectionExpiredError && !AUTH_WORDS.test(typed.message)) return new Error(typed.message);
  if (typed instanceof ComposioAuthError || typed instanceof ComposioConnectionExpiredError || typed instanceof ComposioRateLimitError) return typed;
  const message = typed.message;
  if (EXPIRED_HINTS.test(message)) return new ComposioConnectionExpiredError(message);
  return typed;
}

const defaultExecutor: ToolExecutor = async (slug, args, target) => {
  const start = Date.now();
  let ok = false;
  try {
    const result = await getComposio().tools.execute(slug, {
      userId: target.entityId,
      connectedAccountId: target.connectionId,
      arguments: args,
      dangerouslySkipVersionCheck: true,
    });
    if (!result.successful) throw new Error(result.error ?? `${slug} failed`);
    ok = true;
    return result.data;
  } catch (err) {
    throw classifyExecError(err);
  } finally {
    logger.info({ slug, ok, durationMs: Date.now() - start }, 'kol composio call');
  }
};

let executor: ToolExecutor = defaultExecutor;
let lister: ConnectionLister = (toolkit) => listConnections(toolkit);

/**
 * Runs one Composio tool and returns its `data`. Throws a typed error on
 * failure. file_uploadable params take local paths under FB_MEDIA_DIR.
 */
export async function executeTool<T = unknown>(slug: string, args: Record<string, unknown>, target: ExecTarget): Promise<T> {
  try {
    return (await executor(slug, args, target)) as T;
  } catch (err) {
    throw classifyExecError(err);
  }
}

/** Composio connected accounts of one toolkit (any status). */
export function listToolkitConnections(toolkit: string): Promise<ComposioConnection[]> {
  return lister(toolkit);
}

/** Test hook: replace (or restore with null) the tool executor. */
export function _setToolExecutor(fn: ToolExecutor | null): void {
  executor = fn ?? defaultExecutor;
}

/** Test hook: replace (or restore with null) the connection lister. */
export function _setConnectionLister(fn: ConnectionLister | null): void {
  lister = fn ?? ((toolkit) => listConnections(toolkit));
}

// ── Response helpers ─────────────────────────────────────────────────
// Composio wraps tool results inconsistently (`data`, `data.data`,
// `response_data`…). These helpers dig for a field without assuming a shape.

export const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function asStr(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** Counters arrive as numbers or numeric strings; anything else is unknown (null), never 0. */
export function asNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

const WRAPPERS = ['data', 'response_data', 'response', 'result', 'body', 'user'];

/**
 * The innermost object that has at least one of `keys`, searching the value
 * itself and then the usual wrappers (breadth first, depth ≤ 4).
 */
export function findRecord(value: unknown, keys: string[]): Record<string, unknown> | null {
  let level: unknown[] = [value];
  for (let depth = 0; depth < 5 && level.length; depth++) {
    const next: unknown[] = [];
    for (const v of level) {
      const o = asObj(v);
      if (keys.some((k) => o[k] !== undefined && o[k] !== null)) return o;
      for (const w of WRAPPERS) if (o[w] && typeof o[w] === 'object') next.push(Array.isArray(o[w]) ? (o[w] as unknown[])[0] : o[w]);
    }
    level = next;
  }
  return null;
}

/** First string value of one of `keys` found by findRecord, or null. */
export function findString(value: unknown, keys: string[]): string | null {
  const rec = findRecord(value, keys);
  if (!rec) return null;
  for (const k of keys) {
    const s = asStr(rec[k]);
    if (s) return s;
  }
  return null;
}
