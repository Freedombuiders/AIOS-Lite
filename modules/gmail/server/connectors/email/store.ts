/**
 * Gmail connector native store: mailbox coverage (covered cursor + the open query window), the
 * transport-level send-attempt ledger, cooldowns and the connection health flag.
 *
 * Ownership: THESE TABLES BELONG TO THE EMAIL CONNECTOR. They are created by
 * `ensureEmailConnectorSchema(db)`, intentionally NOT called from `createCareSchema`; the
 * coordinator wires it (once, additive, idempotent). No foreign key to `care_accounts`, so the
 * store works on a bare database; call `purgeAccount` when a Care account is deleted.
 *
 * Deliberately NOT here: customers, conversations, messages, drafts, the outbox. `email_connector_attempts`
 * is a transport ledger (attempt token -> request -> accepted Gmail id) that exists so a token is
 * never put on the wire twice and an accepted Gmail id can be mapped back to its attempt; the
 * business delivery state machine stays the Care outbox's. No message text is stored: only
 * hashes (to RECOGNISE our own echo - never as a retry guarantee).
 */

import type Database from 'better-sqlite3';
import { CareError } from '../../../../_lib/care-kit/errors.js';
import type { WindowKind, WindowState } from './window.js';

export const EMAIL_SCHEMA_VERSION = 1;

export function ensureEmailConnectorSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_connector_mailboxes (
      account_id      TEXT PRIMARY KEY,
      covered_sec     INTEGER,
      step            INTEGER NOT NULL DEFAULT 0,
      win_kind        TEXT,
      win_query       TEXT,
      win_page_size   INTEGER,
      win_end_sec     INTEGER,
      win_lower_sec   INTEGER,
      win_token       TEXT,
      win_pages_done  INTEGER NOT NULL DEFAULT 0,
      win_restarts    INTEGER NOT NULL DEFAULT 0,
      win_started_sec INTEGER,
      status          TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','expired')),
      status_rev      INTEGER NOT NULL DEFAULT 0,
      healthy_pending INTEGER NOT NULL DEFAULT 0,
      updated_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_connector_attempts (
      account_id          TEXT NOT NULL,
      token               TEXT NOT NULL,
      client_request_id   TEXT NOT NULL,
      thread_key          TEXT NOT NULL,
      payload_hash        TEXT NOT NULL,
      text_hash           TEXT NOT NULL,
      actor               TEXT NOT NULL,
      state               TEXT NOT NULL CHECK (state IN ('prepared','refused','rejected','accepted','uncertain')),
      gmail_message_id    TEXT,
      gmail_thread_id     TEXT,
      candidate_message_id TEXT,
      accepted_at_ms      INTEGER,
      first_rpc_at_ms     INTEGER,
      rpc_count           INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      PRIMARY KEY (account_id, token)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_email_connector_attempts_request
      ON email_connector_attempts (account_id, client_request_id);
    CREATE INDEX IF NOT EXISTS idx_email_connector_attempts_gmail
      ON email_connector_attempts (account_id, gmail_message_id);
    CREATE INDEX IF NOT EXISTS idx_email_connector_attempts_thread
      ON email_connector_attempts (account_id, thread_key, state);

    CREATE TABLE IF NOT EXISTS email_connector_cooldowns (
      account_id  TEXT NOT NULL,
      scope       TEXT NOT NULL,
      until_ms    INTEGER NOT NULL,
      reason      TEXT,
      PRIMARY KEY (account_id, scope)
    );
  `);
}

export type CooldownScope = 'sync' | 'send';
export type AttemptState = 'prepared' | 'refused' | 'rejected' | 'accepted' | 'uncertain';

export interface MailboxRow {
  accountId: string;
  coveredSec: number | null;
  step: number;
  window: WindowState | null;
  status: 'ok' | 'expired';
  statusRev: number;
  healthyPending: boolean;
}

export interface EmailAttempt {
  accountId: string;
  token: string;
  clientRequestId: string;
  threadKey: string;
  payloadHash: string;
  textHash: string;
  actor: string;
  state: AttemptState;
  gmailMessageId: string | null;
  gmailThreadId: string | null;
  candidateMessageId: string | null;
  acceptedAtMs: number | null;
  firstRpcAtMs: number | null;
  rpcCount: number;
}

/** True when a previous RPC may have reached Gmail (so the same token must never go out again). */
export function maybeSent(a: Pick<EmailAttempt, 'state' | 'rpcCount'>): boolean {
  return a.state === 'accepted' || a.state === 'uncertain' || (a.state === 'prepared' && a.rpcCount > 0);
}

interface MailboxSql {
  account_id: string;
  covered_sec: number | null;
  step: number;
  win_kind: string | null;
  win_query: string | null;
  win_page_size: number | null;
  win_end_sec: number | null;
  win_lower_sec: number | null;
  win_token: string | null;
  win_pages_done: number;
  win_restarts: number;
  win_started_sec: number | null;
  status: 'ok' | 'expired';
  status_rev: number;
  healthy_pending: number;
}

interface AttemptSql {
  account_id: string;
  token: string;
  client_request_id: string;
  thread_key: string;
  payload_hash: string;
  text_hash: string;
  actor: string;
  state: AttemptState;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  candidate_message_id: string | null;
  accepted_at_ms: number | null;
  first_rpc_at_ms: number | null;
  rpc_count: number;
}

function mailboxOf(r: MailboxSql): MailboxRow {
  const window: WindowState | null =
    r.win_kind && r.win_query != null
      ? {
          kind: r.win_kind as WindowKind,
          query: r.win_query,
          pageSize: r.win_page_size ?? 25,
          endSec: r.win_end_sec ?? 0,
          lowerSec: r.win_lower_sec ?? 0,
          pageToken: r.win_token,
          pagesDone: r.win_pages_done,
          restarts: r.win_restarts,
          startedSec: r.win_started_sec ?? 0,
        }
      : null;
  return {
    accountId: r.account_id,
    coveredSec: r.covered_sec,
    step: r.step,
    window,
    status: r.status,
    statusRev: r.status_rev,
    healthyPending: r.healthy_pending === 1,
  };
}

function attemptOf(r: AttemptSql): EmailAttempt {
  return {
    accountId: r.account_id,
    token: r.token,
    clientRequestId: r.client_request_id,
    threadKey: r.thread_key,
    payloadHash: r.payload_hash,
    textHash: r.text_hash,
    actor: r.actor,
    state: r.state,
    gmailMessageId: r.gmail_message_id,
    gmailThreadId: r.gmail_thread_id,
    candidateMessageId: r.candidate_message_id,
    acceptedAtMs: r.accepted_at_ms,
    firstRpcAtMs: r.first_rpc_at_ms,
    rpcCount: r.rpc_count,
  };
}

export interface MailboxAdvance {
  /** Step the caller read; the write is a compare-and-set on it (a stale commit changes nothing). */
  expectedStep: number;
  coveredSec: number | null;
  window: WindowState | null;
}

export class EmailConnectorStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ── mailbox ──────────────────────────────────────────────────────────────────────────────
  getMailbox(accountId: string): MailboxRow | null {
    const r = this.db.prepare('SELECT * FROM email_connector_mailboxes WHERE account_id = ?').get(accountId) as MailboxSql | undefined;
    return r ? mailboxOf(r) : null;
  }

  /** Creates the row (idempotent). `coveredSec` seeds the covered cursor from a legacy mailbox. */
  ensureMailbox(accountId: string, coveredSec: number | null): MailboxRow {
    this.db
      .prepare('INSERT OR IGNORE INTO email_connector_mailboxes (account_id, covered_sec, step, updated_at) VALUES (?, ?, 0, ?)')
      .run(accountId, coveredSec, this.now());
    return this.getMailbox(accountId)!;
  }

  /**
   * Atomic compare-and-set of the covered cursor + window. The covered cursor never moves backwards.
   * Throws STALE_REVISION when another commit got there first.
   */
  advanceMailbox(accountId: string, adv: MailboxAdvance): MailboxRow {
    const w = adv.window;
    const res = this.db
      .prepare(
        `UPDATE email_connector_mailboxes SET
           covered_sec = CASE WHEN ? IS NULL THEN covered_sec WHEN covered_sec IS NULL OR ? > covered_sec THEN ? ELSE covered_sec END,
           step = step + 1,
           win_kind = ?, win_query = ?, win_page_size = ?, win_end_sec = ?, win_lower_sec = ?, win_token = ?,
           win_pages_done = ?, win_restarts = ?, win_started_sec = ?,
           updated_at = ?
         WHERE account_id = ? AND step = ?`,
      )
      .run(
        adv.coveredSec,
        adv.coveredSec,
        adv.coveredSec,
        w?.kind ?? null,
        w?.query ?? null,
        w?.pageSize ?? null,
        w?.endSec ?? null,
        w?.lowerSec ?? null,
        w?.pageToken ?? null,
        w?.pagesDone ?? 0,
        w?.restarts ?? 0,
        w?.startedSec ?? null,
        this.now(),
        accountId,
        adv.expectedStep,
      );
    if (res.changes === 0) {
      throw new CareError('STALE_REVISION', 'Email mailbox state moved since this sync was read; commit refused', 409);
    }
    return this.getMailbox(accountId)!;
  }

  /** Returns true when the flag flipped (so the caller announces it once). */
  markExpired(accountId: string): boolean {
    this.ensureMailbox(accountId, null);
    const res = this.db
      .prepare(`UPDATE email_connector_mailboxes SET status = 'expired', status_rev = status_rev + 1, healthy_pending = 0, updated_at = ? WHERE account_id = ? AND status <> 'expired'`)
      .run(this.now(), accountId);
    return res.changes > 0;
  }

  clearExpired(accountId: string): boolean {
    const res = this.db
      .prepare(`UPDATE email_connector_mailboxes SET status = 'ok', status_rev = status_rev + 1, healthy_pending = 1, updated_at = ? WHERE account_id = ? AND status = 'expired'`)
      .run(this.now(), accountId);
    return res.changes > 0;
  }

  consumeHealthyAnnouncement(accountId: string): number | null {
    const row = this.getMailbox(accountId);
    if (!row || !row.healthyPending) return null;
    this.db.prepare('UPDATE email_connector_mailboxes SET healthy_pending = 0 WHERE account_id = ?').run(accountId);
    return row.statusRev;
  }

  // ── cooldowns ────────────────────────────────────────────────────────────────────────────
  setCooldown(accountId: string, scope: CooldownScope, untilMs: number, reason: string): void {
    this.db
      .prepare(
        `INSERT INTO email_connector_cooldowns (account_id, scope, until_ms, reason) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, scope) DO UPDATE SET
           until_ms = MAX(until_ms, excluded.until_ms),
           reason = CASE WHEN excluded.until_ms >= until_ms THEN excluded.reason ELSE reason END`,
      )
      .run(accountId, scope, untilMs, reason);
  }

  /** Active cooldown end (ms) or null. Expired rows are ignored (and dropped). */
  getCooldownUntil(accountId: string, scope: CooldownScope): number | null {
    const r = this.db.prepare('SELECT until_ms FROM email_connector_cooldowns WHERE account_id = ? AND scope = ?').get(accountId, scope) as
      | { until_ms: number }
      | undefined;
    if (!r) return null;
    if (r.until_ms <= this.now()) {
      this.db.prepare('DELETE FROM email_connector_cooldowns WHERE account_id = ? AND scope = ?').run(accountId, scope);
      return null;
    }
    return r.until_ms;
  }

  // ── attempts ─────────────────────────────────────────────────────────────────────────────
  getAttempt(accountId: string, token: string): EmailAttempt | null {
    const r = this.db.prepare('SELECT * FROM email_connector_attempts WHERE account_id = ? AND token = ?').get(accountId, token) as AttemptSql | undefined;
    return r ? attemptOf(r) : null;
  }

  getAttemptByRequest(accountId: string, clientRequestId: string): EmailAttempt | null {
    const r = this.db
      .prepare('SELECT * FROM email_connector_attempts WHERE account_id = ? AND client_request_id = ?')
      .get(accountId, clientRequestId) as AttemptSql | undefined;
    return r ? attemptOf(r) : null;
  }

  getAttemptByGmailId(accountId: string, gmailMessageId: string): EmailAttempt | null {
    const r = this.db
      .prepare('SELECT * FROM email_connector_attempts WHERE account_id = ? AND gmail_message_id = ?')
      .get(accountId, gmailMessageId) as AttemptSql | undefined;
    return r ? attemptOf(r) : null;
  }

  /** Attempts of one thread that may have put a message in Gmail without us knowing its id. */
  listUnresolvedForThread(accountId: string, threadKey: string): EmailAttempt[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM email_connector_attempts
          WHERE account_id = ? AND thread_key = ? AND gmail_message_id IS NULL
            AND (state = 'uncertain' OR (state = 'prepared' AND rpc_count > 0))
          ORDER BY first_rpc_at_ms`,
      )
      .all(accountId, threadKey) as AttemptSql[];
    return rows.map(attemptOf);
  }

  prepareAttempt(a: {
    accountId: string;
    token: string;
    clientRequestId: string;
    threadKey: string;
    payloadHash: string;
    textHash: string;
    actor: string;
  }): void {
    const t = this.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO email_connector_attempts
           (account_id, token, client_request_id, thread_key, payload_hash, text_hash, actor, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
      )
      .run(a.accountId, a.token, a.clientRequestId, a.threadKey, a.payloadHash, a.textHash, a.actor, t, t);
  }

  /** Called immediately before the RPC leaves the process. */
  markRpcStarted(accountId: string, token: string): void {
    const t = this.now();
    this.db
      .prepare(
        `UPDATE email_connector_attempts SET rpc_count = rpc_count + 1, first_rpc_at_ms = COALESCE(first_rpc_at_ms, ?), state = 'prepared', updated_at = ?
          WHERE account_id = ? AND token = ?`,
      )
      .run(t, t, accountId, token);
  }

  setState(accountId: string, token: string, state: AttemptState, accepted?: { messageId: string; threadId: string; atMs: number }): void {
    this.db
      .prepare(
        `UPDATE email_connector_attempts SET state = ?,
           gmail_message_id = COALESCE(?, gmail_message_id), gmail_thread_id = COALESCE(?, gmail_thread_id),
           accepted_at_ms = COALESCE(?, accepted_at_ms), updated_at = ?
          WHERE account_id = ? AND token = ?`,
      )
      .run(state, accepted?.messageId ?? null, accepted?.threadId ?? null, accepted?.atMs ?? null, this.now(), accountId, token);
  }

  /** An echo that looks like this attempt (thread + body hash). Evidence to show, never an acceptance. */
  noteCandidate(accountId: string, token: string, gmailMessageId: string): void {
    this.db
      .prepare('UPDATE email_connector_attempts SET candidate_message_id = ?, updated_at = ? WHERE account_id = ? AND token = ? AND gmail_message_id IS NULL')
      .run(gmailMessageId, this.now(), accountId, token);
  }

  /** Removes everything this connector holds for a deleted Care account. */
  purgeAccount(accountId: string): void {
    for (const table of ['email_connector_mailboxes', 'email_connector_attempts', 'email_connector_cooldowns']) {
      this.db.prepare(`DELETE FROM ${table} WHERE account_id = ?`).run(accountId);
    }
  }
}
