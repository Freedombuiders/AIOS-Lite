import type { ModuleContext } from '../../../src/modules/sdk.js';
import type { EmailStore } from './store.js';
/**
 * The one exit to Gmail. Every Composio call for email goes through here:
 * budget check (email_api_calls, EmailProtectionSettings.apiBudgetPerHour),
 * call accounting, error classification. Reuses the shared Composio client
 * from src/fbstudio/composio.ts (getComposio, listConnections,
 * classifyComposioError and the typed errors) — never `new Composio()`.
 *
 * Never log arguments or responses (they carry customer mail); log slug,
 * area, ok and duration only. Owner: workstream B.
 */



import {
  ComposioAuthError,
  ComposioConnectionExpiredError,
  ComposioRateLimitError,
  classifyComposioError,
  getComposio,
  hasComposioKey,
  listConnections,
} from '../../_lib/composio.js';

import type { ComposioConnection } from '../../_lib/composio.js';


import { normalizeGmailMessage } from './parse.js';

import type { GmailMessage } from './parse.js';


export type EmailApiArea = 'sync' | 'send' | 'profile' | 'connect';


export interface GmailTarget {
  /** email_accounts.connection_id */
  connectionId: string;
  /** email_accounts.entity_id (Composio user_id) */
  entityId: string;
}


export class EmailBudgetExceeded extends Error {
  constructor(public readonly cap: number, public readonly used: number) {
    super(`Email Composio budget exhausted for this hour (${used}/${cap})`);
    this.name = 'EmailBudgetExceeded';
  }
}

/** Composio user_id the mailboxes connected from the dashboard belong to. */
export const EMAIL_ENTITY_ID = 'aios-gmail';


type Json = Record<string, unknown>;
export function createGmailApi(ctx: ModuleContext, store: EmailStore) {
const { countEmailApiCallsSince, getEmailProtectionSettings, recordEmailApiCall } = store;
const logger = ctx.log;
const readComposioKey = () => ctx.connections.secret('COMPOSIO_API_KEY');


const COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3';


function nowSec(): number { return Math.floor(Date.now() / 1000); }


function asObj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}


/** Refuses the call when this hour's budget (all mailboxes, all areas) is spent. */
function chargeBudget(): void {
  const now = nowSec();
  const cap = getEmailProtectionSettings().apiBudgetPerHour;
  const used = countEmailApiCallsSince(now - (now % 3600));
  if (used >= cap) throw new EmailBudgetExceeded(cap, used);
}


const TOKEN_REVOKED = /invalid_grant|token has been (expired|revoked)|invalid credentials|reauthenticat|reauthoriz|needs? to (re-?)?(connect|authenticate)/i;


/** classifyComposioError plus the Gmail-specific "token revoked" wordings. */
function classifyGmailError(err: unknown): Error {
  const classified = classifyComposioError(err);
  if (
    classified instanceof ComposioAuthError
    || classified instanceof ComposioConnectionExpiredError
    || classified instanceof ComposioRateLimitError
    || classified instanceof EmailBudgetExceeded
  ) return classified;
  if (TOKEN_REVOKED.test(classified.message)) return new ComposioConnectionExpiredError(classified.message);
  return classified;
}


/** Runs one Gmail tool through Composio; returns `data`. Throws typed errors. */
async function gmailExecute<T = Record<string, unknown>>(
  slug: string, args: Record<string, unknown>, target: GmailTarget, area: EmailApiArea,
): Promise<T> {
  chargeBudget();
  const start = Date.now();
  let ok = false;
  try {
    const result = await getComposio().tools.execute(slug, {
      userId: target.entityId,
      connectedAccountId: target.connectionId,
      arguments: args,
      dangerouslySkipVersionCheck: true,
    });
    if (!result.successful) {
      throw classifyGmailError(new Error(result.error ?? `${slug} failed`));
    }
    ok = true;
    return result.data as T;
  } catch (err) {
    throw classifyGmailError(err);
  } finally {
    recordEmailApiCall(area, ok);
    logger.info({ slug, area, ok, durationMs: Date.now() - start }, 'email composio call');
  }
}


/** Every gmail connected account in the Composio project (any status). */
async function listGmailConnections(): Promise<ComposioConnection[]> {
  let ok = false;
  try {
    const conns = await listConnections('gmail');
    ok = true;
    return conns;
  } catch (err) {
    throw classifyGmailError(err);
  } finally {
    recordEmailApiCall('connect', ok);
  }
}


/** GMAIL_GET_PROFILE → the mailbox address. */
async function fetchGmailProfile(target: GmailTarget): Promise<{ emailAddress: string }> {
  const data = await gmailExecute<Json>('GMAIL_GET_PROFILE', { user_id: 'me' }, target, 'profile');
  const emailAddress = String(data.emailAddress ?? asObj(data.response_data).emailAddress ?? '').trim().toLowerCase();
  return { emailAddress };
}


function readApiKey(): string {
  const key = readComposioKey();
  if (!key || !key.trim()) throw new ComposioAuthError('COMPOSIO_API_KEY is not set');
  return key.trim();
}


/** First gmail auth config of the project (REST: the SDK has no list-by-toolkit that returns ids reliably). */
async function findGmailAuthConfigId(): Promise<string> {
  const url = new URL(`${COMPOSIO_API_BASE}/auth_configs`);
  url.searchParams.set('toolkit_slug', 'gmail');
  const res = await fetch(url, { headers: { 'x-api-key': readApiKey() } });
  if (!res.ok) {
    throw classifyGmailError(Object.assign(new Error(`auth_configs lookup failed: ${res.status}`), { statusCode: res.status }));
  }
  const body = asObj(await res.json().catch(() => ({})));
  const items = Array.isArray(body.items) ? body.items : [];
  for (const item of items) {
    const id = asObj(item).id;
    if (typeof id === 'string' && id) return id;
  }
  return '';
}


/**
 * Starts the Composio OAuth flow for a new Gmail mailbox and returns the
 * URL the owner opens. Auth config: reuse the auth_config of an existing
 * gmail connection, else the first gmail auth config of the project
 * (REST GET /api/v3/auth_configs?toolkit_slug=gmail), else create a
 * Composio-managed one. Entity (user_id): 'claudeclaw-email'.
 */
async function startGmailConnect(): Promise<{ redirectUrl: string }> {
  if (!hasComposioKey()) throw new ComposioAuthError('COMPOSIO_API_KEY is not set');
  let ok = false;
  try {
    let authConfigId = '';
    const existing = await listConnections('gmail');
    authConfigId = existing.find((c) => c.authConfigId)?.authConfigId ?? '';
    if (!authConfigId) authConfigId = await findGmailAuthConfigId();
    if (!authConfigId) {
      const created = await getComposio().authConfigs.create('gmail', { type: 'use_composio_managed_auth', name: 'AIOS Gmail' });
      authConfigId = created.id;
    }
    const request = await getComposio().connectedAccounts.link(EMAIL_ENTITY_ID, authConfigId, { allowMultiple: true });
    if (!request.redirectUrl) throw new Error('Composio không trả về đường dẫn kết nối Gmail.');
    ok = true;
    return { redirectUrl: request.redirectUrl };
  } catch (err) {
    throw classifyGmailError(err);
  } finally {
    recordEmailApiCall('connect', ok);
  }
}


/** GMAIL_FETCH_EMAILS with full payloads, normalized. */
async function fetchGmailMessages(
  target: GmailTarget, opts: { query: string; maxResults: number; pageToken?: string },
): Promise<{ messages: GmailMessage[]; nextPageToken: string | null }> {
  const args: Record<string, unknown> = {
    user_id: 'me',
    query: opts.query,
    max_results: opts.maxResults,
    include_payload: true,
    verbose: true,
  };
  if (opts.pageToken) args.page_token = opts.pageToken;
  const data = await gmailExecute<Json>('GMAIL_FETCH_EMAILS', args, target, 'sync');
  const inner = Array.isArray(data.messages) ? data : asObj(data.response_data);
  const rawMessages = Array.isArray(inner.messages) ? inner.messages : [];
  const messages: GmailMessage[] = [];
  for (const raw of rawMessages) {
    const normalized = normalizeGmailMessage(raw);
    if (normalized) messages.push(normalized);
  }
  const token = inner.nextPageToken ?? data.nextPageToken;
  return { messages, nextPageToken: typeof token === 'string' && token ? token : null };
}


/** GMAIL_REPLY_TO_THREAD (plain text). Returns the sent message id (and thread id) from response_data. */
async function sendGmailReply(
  target: GmailTarget, input: { gmailThreadId: string; to: string; cc?: string[]; body: string },
): Promise<{ gmailMessageId: string; gmailThreadId: string }> {
  const data = await gmailExecute<Json>('GMAIL_REPLY_TO_THREAD', {
    user_id: 'me',
    thread_id: input.gmailThreadId,
    recipient_email: input.to,
    cc: input.cc ?? [],
    message_body: input.body,
    is_html: false,
  }, target, 'send');
  const resp = asObj(data.response_data);
  const id = String(resp.id ?? data.id ?? '');
  if (!id) throw new Error('Gmail không trả về mã thư đã gửi.');
  return { gmailMessageId: id, gmailThreadId: String(resp.threadId ?? data.threadId ?? input.gmailThreadId) };
}
return { gmailExecute, listGmailConnections, fetchGmailProfile, startGmailConnect, fetchGmailMessages, sendGmailReply };
}
export type GmailApi = ReturnType<typeof createGmailApi>;
