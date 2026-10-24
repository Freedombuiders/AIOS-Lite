/**
 * Gmail (Composio) connector for Customer Care (CC-14, connector side).
 *
 * Implements `CareConnector` on top of the `EmailTransport` port. It owns only transport
 * concerns: mailbox coverage (covered cursor + the open query window), the send-attempt ledger,
 * cooldowns and connection health. Customers, rules, drafts, the outbox and quotas stay in the
 * shared Care core; the production transport is a thin shell over `src/email/gmail.ts` (budget
 * and connection accounting), so no second provider path exists.
 *
 * Invariants (each has a test):
 *  - Sync reads only. The covered cursor and the open window advance in `commit()`, which the
 *    runtime calls AFTER the returned events were durably ingested (`commitPartial` semantics via
 *    `failedEventIds` resume at the first page holding an unstored event). A failed fetch, a failed
 *    store, an exhausted page budget or an echo we must wait for NEVER moves the cursor past
 *    unread/unsaved mail. Window bounds are absolute epoch seconds; overlap 600 s; an invalid page
 *    token restarts the SAME window from page one (event ids make the replay idempotent).
 *  - Send: the caller's attempt token is persisted BEFORE the RPC. Gmail (through Composio) has no
 *    idempotency key, so `sendDedupe` is false and a token is put on the wire at most once: a lost
 *    ack is `uncertain`, a repeat with the same token never RPCs again, and RFC Message-ID, thread
 *    or body matching is evidence to show a human, never a licence to resend. `delivered`/`read`
 *    are never inferred from `accepted`.
 *  - Quota, rate limit and the hourly Composio budget become a persisted cooldown
 *    (`details.retryAtMs`); nothing sleeps. An expired connection flips the account health to
 *    `error` once and short-circuits every later call until `connect()` succeeds again.
 *  - Echo: our own sent mail seen in `SENT` is matched to its attempt (id, else thread + body
 *    hash) and filed with the attempt's role, so an agent reply is not mistaken for the owner's.
 *  - Capabilities reported FALSE until supported: bcc, new mail, remote read, attachment download.
 */

import type Database from 'better-sqlite3';
import { CareError } from '../../../../_lib/care-kit/errors.js';
import type { CareCheckpoint } from '../../../../_lib/care-kit/checkpoint.js';
import type { CareChannel, NormalizedEvent } from '../../../../_lib/care-kit/types.js';
import {
  validateAuthCommand,
  validateDeliveryCommand,
  validateReconcileCommand,
  type AuthCommand,
  type AuthResult,
  type CareConnector,
  type ConnectorCapabilities,
  type DeliveryCommand,
  type DeliveryResult,
  type EmailDeliveryCommand,
  type MediaCommand,
  type MediaResult,
  type ReadCommand,
  type ReadResult,
  type ReconcileCommand,
  type SyncCommand,
  type SyncResult,
} from '../../../../_lib/care-kit/contract.js';
import { EMAIL_ENTITY_ID } from '../../gmail.js';
import { isDraft, isOutbound, classifyOrigin, toNormalizedMessage } from './normalize.js';
import { EmailConnectorStore, maybeSent, type EmailAttempt } from './store.js';
import {
  EmailTransportError,
  type EmailTarget,
  type EmailTransport,
  type GmailMessage,
} from './transport.js';
import {
  DEFAULT_MAX_PAGES,
  GMAIL_BOX,
  buildWindowQuery,
  cursorPosition,
  decodeCursor,
  encodeCursor,
  nextHourMs,
  openWindowState,
  sha256,
  textHash,
  type MailboxCursor,
  type WindowState,
} from './window.js';

/** Per-mailbox facts the runtime knows (legacy `email_accounts` row today, Care account config after cutover). */
export interface EmailAccountConfig {
  target: EmailTarget;
  /** Mailbox address (lower-case). */
  address: string;
  /** Live-care boundary in ms (legacy `care_since * 1000`); null = nothing is live yet. */
  careSinceMs: number | null;
  /** First-sync history horizon in days; <= 0 means "start from now, read nothing". */
  backfillDays: number;
  extraAutomatedPatterns?: string[];
  /** Seeds the covered cursor (seconds) from the legacy `sync_cursor` at cutover. */
  seedCoveredSec?: number | null;
}

export interface EmailConnectorOptions {
  db: Database.Database;
  transport: EmailTransport;
  resolveAccount: (accountId: string) => EmailAccountConfig | null;
  /** Ownership epoch authority. Required: Care fails closed, there is no "epoch 1 by default". */
  getActiveEpoch: (accountId: string) => number;
  now?: () => number;
  /** Composio entity used when `connect()` runs before the account has a config (default: gmail.ts EMAIL_ENTITY_ID). */
  defaultEntityId?: string;
  /** Pages one `sync` may read (default 4, as the legacy poller). */
  maxPagesPerSync?: number;
  /** An unresolved send younger than this makes an unmatched SENT mail of its thread wait (default 5 min). */
  echoGraceMs?: number;
  /** How long a blocked connection / key is left alone before it is looked at again (default 30 min). */
  recheckMs?: number;
  /** Cooldown for a rate limit that did not say when to come back (default 60 s). */
  defaultCooldownMs?: number;
}

/** One page of a poll: the token it was fetched with and the event ids it produced. */
interface PagePlan {
  tokenBefore: string | null;
  eventIds: string[];
}

export interface WindowPlan {
  /** Mailbox step this plan was read at; the commit is a compare-and-set on it. */
  expectedStep: number;
  coveredBefore: number | null;
  /** Window as it stood when this poll began (or as it was opened by it). */
  window: WindowState;
  pages: PagePlan[];
  /** Token of the page AFTER the last one read (null = the provider has no more pages). */
  tokenAfter: string | null;
  exhausted: boolean;
  /** Set when a fetch failed: the token that page was requested with. */
  failedToken?: string | null;
  fetchFailed: boolean;
  /** Pages whose events cannot be stored yet (echo of a send that is still being resolved). */
  deferredPages: number[];
  restarts: number;
  /** Backfill disabled and nothing covered yet: cover "now" and read nothing. */
  coverNowSec?: number;
}

export type EmailCommit =
  | { kind: 'window'; plan: WindowPlan }
  | { kind: 'candidate'; token: string; gmailMessageId: string }
  | { kind: 'healthy'; statusRev: number };

export interface EmailSyncResult extends SyncResult {
  checkpoints: CareCheckpoint[];
  /** Applied via `commit()` once the events were durably ingested. */
  commits: EmailCommit[];
  /** Window still open after this poll: coverage is partial and the next poll resumes it. */
  partial: boolean;
  pagesRead: number;
  fetched: number;
  /** Messages held back this poll (echo of a send that is still being resolved). */
  deferred: number;
  /** A failure that ended the poll early; the events of the pages read before it are still returned. */
  error?: { code: string; retryAtMs?: number };
}

export interface EmailDeliveryResult extends DeliveryResult {
  /** Thread Gmail reported for the accepted message (normally the conversation key). */
  nativeThreadId?: string;
}

const NO_CAPS: Omit<ConnectorCapabilities, 'mediaKinds'> = {
  text: false,
  reply: false,
  replyAll: false,
  edit: false,
  delete: false,
  reaction: false,
  typing: false,
  remoteRead: false,
  backfill: false,
  sendDedupe: false,
  bcc: false,
  newMail: false,
};

const CHANNEL: CareChannel = 'email';

/** Longest a shutdown waits for provider operations that are still in flight. */
const CLOSE_WAIT_MS = 2_000;

export class EmailCareConnector implements CareConnector {
  readonly kind = 'gmail-composio';
  readonly channel: CareChannel = CHANNEL;
  readonly store: EmailConnectorStore;

  private readonly nowFn: () => number;
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly maxPages: number;
  private readonly echoGraceMs: number;
  private readonly recheckMs: number;
  private readonly defaultCooldownMs: number;

  constructor(private readonly opts: EmailConnectorOptions) {
    this.nowFn = opts.now ?? (() => Date.now());
    this.store = new EmailConnectorStore(opts.db, this.nowFn);
    this.maxPages = Math.max(1, opts.maxPagesPerSync ?? DEFAULT_MAX_PAGES);
    this.echoGraceMs = opts.echoGraceMs ?? 5 * 60_000;
    this.recheckMs = opts.recheckMs ?? 30 * 60_000;
    this.defaultCooldownMs = opts.defaultCooldownMs ?? 60_000;
  }


  /**
   * Process shutdown: lets provider operations that are still in a lane settle (bounded), forgets the in-memory state and
   * closes the transport. Idempotent and never throws; persisted state is untouched. Nothing is sent by closing.
   */
  async close(): Promise<void> {
    const pending = [...this.lanes.values()];
    if (pending.length > 0) {
      await Promise.race([Promise.allSettled(pending), new Promise<void>((resolve) => setTimeout(resolve, CLOSE_WAIT_MS).unref())]);
    }
    this.lanes.clear();
    try {
      await this.opts.transport.close?.();
    } catch {
      /* shutdown must go on */
    }
  }

  /** Serialises every provider-touching operation of one account: one lane, no duplicate sender. */
  private lane<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.lanes.get(accountId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.lanes.set(accountId, tail);
    void tail.then(() => {
      if (this.lanes.get(accountId) === tail) this.lanes.delete(accountId);
    });
    return run;
  }

  private epoch(accountId: string): number {
    return this.opts.getActiveEpoch(accountId);
  }

  // ── capabilities ─────────────────────────────────────────────────────────────────────────
  async capabilities(accountId: string, _conversationKey?: string): Promise<ConnectorCapabilities> {
    const cfg = this.opts.resolveAccount(accountId);
    const mailbox = this.store.getMailbox(accountId);
    if (!cfg || mailbox?.status === 'expired') return { ...NO_CAPS, mediaKinds: [] };
    return {
      text: true,
      reply: true,
      // The reply tool takes one recipient plus CC: "reply all" here means CC only.
      replyAll: true,
      edit: false,
      delete: false,
      reaction: false,
      typing: false,
      // No label-modify tool is wired to the single provider exit yet.
      remoteRead: false,
      backfill: true,
      // Composio has no idempotency key: a token is never re-sent, see the class comment.
      sendDedupe: false,
      // Attachment metadata is read; nothing can be downloaded, so no media kind is advertised.
      mediaKinds: [],
      bcc: false,
      newMail: false,
    };
  }

  // ── auth ─────────────────────────────────────────────────────────────────────────────────
  async connect(command: AuthCommand): Promise<AuthResult> {
    const valid = validateAuthCommand(command);
    if (valid.channel !== 'email') {
      throw new CareError('INVALID_TARGET', `Auth for '${valid.channel}' sent to an 'email' connector`, 400);
    }
    if (valid.method !== 'composio_connection') throw new CareError('INVALID_COMMAND', 'Unsupported email auth method', 400);
    const accountId = valid.accountId;
    return this.lane(accountId, async () => {
      const entityId = this.opts.resolveAccount(accountId)?.target.entityId ?? this.opts.defaultEntityId ?? EMAIL_ENTITY_ID;
      const target: EmailTarget = { connectionId: valid.composioConnectionId, entityId };
      try {
        const profile = await this.opts.transport.getProfile(target);
        const address = (profile.emailAddress ?? '').trim().toLowerCase();
        if (!address || address !== valid.accountAddress.trim().toLowerCase()) {
          return { ok: false, accountId, error: 'ADDRESS_MISMATCH' };
        }
        this.store.ensureMailbox(accountId, this.opts.resolveAccount(accountId)?.seedCoveredSec ?? null);
        this.store.clearExpired(accountId);
        return { ok: true, accountId, nativeAccountId: address, label: address };
      } catch (err) {
        // Never echoes provider text (it can carry addresses or tokens).
        if (err instanceof EmailTransportError) {
          if (err.kind === 'connection_expired') {
            this.store.markExpired(accountId);
            return { ok: false, accountId, error: 'CONNECTION_EXPIRED' };
          }
          if (err.kind === 'auth') return { ok: false, accountId, error: 'COMPOSIO_AUTH' };
          if (err.kind === 'rate_limited' || err.kind === 'budget_exhausted') return { ok: false, accountId, error: 'RATE_LIMITED' };
        }
        return { ok: false, accountId, error: 'AUTH_ERROR' };
      }
    });
  }

  // ── sync ─────────────────────────────────────────────────────────────────────────────────
  async sync(command: SyncCommand): Promise<EmailSyncResult> {
    if (command.checkpoint && command.checkpoint.namespace !== GMAIL_BOX) {
      throw new CareError('INVALID_CURSOR', 'Checkpoint box is not the Gmail mailbox', 400);
    }
    return this.lane(command.accountId, () => this.syncLocked(command));
  }

  private cooldownError(untilMs: number, scope: string): CareError {
    return new CareError('RATE_LIMITED', `Gmail ${scope} is cooling down`, 429, {
      nextAttemptAtMs: untilMs,
      retryAtMs: untilMs,
      retryAfterSeconds: Math.max(1, Math.ceil((untilMs - this.nowFn()) / 1000)),
    });
  }

  private statusEvent(
    accountId: string,
    eventId: string,
    health: 'healthy' | 'error',
    errorCode?: string,
    errorNote?: string,
  ): NormalizedEvent {
    return {
      type: 'account.status',
      eventId,
      accountId,
      timestampMs: this.nowFn(),
      epoch: this.epoch(accountId),
      healthStatus: health,
      ...(errorCode ? { errorCode } : {}),
      ...(errorNote ? { errorNote } : {}),
    };
  }

  private expiredResult(accountId: string, statusRev: number): EmailSyncResult {
    return {
      events: [
        this.statusEvent(
          accountId,
          `gm:status:${accountId}:expired:${statusRev}`,
          'error',
          'CONNECTION_EXPIRED',
          'Gmail connection expired; reconnect the mailbox',
        ),
      ],
      hasMore: false,
      checkpoints: [],
      commits: [],
      partial: false,
      pagesRead: 0,
      fetched: 0,
      deferred: 0,
      error: { code: 'CONNECTION_EXPIRED' },
    };
  }

  private async syncLocked(command: SyncCommand): Promise<EmailSyncResult> {
    const accountId = command.accountId;
    const cfg = this.opts.resolveAccount(accountId);
    if (!cfg) throw new CareError('ACCOUNT_FROZEN', 'No Gmail mailbox is configured for this account', 409);
    const mailbox = this.store.ensureMailbox(accountId, cfg.seedCoveredSec ?? null);

    // An expired connection is not retried by the clock: one health event, no provider call.
    if (mailbox.status === 'expired') return this.expiredResult(accountId, mailbox.statusRev);
    const cooldown = this.store.getCooldownUntil(accountId, 'sync');
    if (cooldown !== null) throw this.cooldownError(cooldown, 'sync');

    const startSec = Math.floor(this.nowFn() / 1000);
    const epoch = this.epoch(accountId);

    // The connector store is the source of truth. Core's checkpoint only rebuilds a store that is
    // empty (lost): covered cursor + window bounds come back, the page token does not (restart at 1).
    let coveredSec = mailbox.coveredSec;
    let window = mailbox.window;
    const cp = decodeCursor(command.checkpoint?.cursor);
    if (mailbox.step === 0 && coveredSec == null && !window && cp) {
      coveredSec = cp.coveredSec;
      if (cp.windowEndSec > 0) {
        window = {
          kind: cp.coveredSec == null ? 'backfill' : 'poll',
          query: buildWindowQuery(cp.windowLowerSec, cp.windowEndSec),
          pageSize: 25,
          endSec: cp.windowEndSec,
          lowerSec: cp.windowLowerSec,
          pageToken: null,
          pagesDone: 0,
          restarts: 0,
          startedSec: cp.windowEndSec,
        };
      }
    }

    const commits: EmailCommit[] = [];
    const events: NormalizedEvent[] = [];
    if (mailbox.healthyPending) {
      events.push(this.statusEvent(accountId, `gm:status:${accountId}:healthy:${mailbox.statusRev}`, 'healthy'));
      commits.push({ kind: 'healthy', statusRev: mailbox.statusRev });
    }

    if (!window) {
      if (coveredSec == null && cfg.backfillDays <= 0 && !command.fullBackfill) {
        // Backfill disabled: start from now, nothing to read.
        const plan: WindowPlan = {
          expectedStep: mailbox.step,
          coveredBefore: null,
          window: openWindowState({ coveredSec: null, backfillDays: 0, startSec }),
          pages: [],
          tokenAfter: null,
          exhausted: true,
          fetchFailed: false,
          deferredPages: [],
          restarts: 0,
          coverNowSec: startSec,
        };
        commits.push({ kind: 'window', plan });
        return this.assemble(events, commits, plan, command.checkpoint?.cursor, { pagesRead: 0, fetched: 0, deferred: 0 }, undefined);
      }
      window = openWindowState({
        coveredSec,
        backfillDays: cfg.backfillDays,
        startSec,
        fullBackfill: command.fullBackfill === true,
      });
    }

    // ── read up to maxPages pages of the window ──
    const budget =
      command.limit && command.limit > 0 ? Math.min(this.maxPages, Math.max(1, Math.ceil(command.limit / window.pageSize))) : this.maxPages;
    const fetched: Array<{ tokenBefore: string | null; messages: GmailMessage[]; next: string | null }> = [];
    let token: string | null = window.pageToken;
    let exhausted = false;
    let fetchError: unknown = null;
    let failedToken: string | null = null;
    let restarts = window.restarts;
    while (fetched.length < budget) {
      try {
        const page = await this.opts.transport.listPage(cfg.target, {
          query: window.query,
          maxResults: window.pageSize,
          ...(token ? { pageToken: token } : {}),
        });
        fetched.push({ tokenBefore: token, messages: page.messages, next: page.nextPageToken });
        if (!page.nextPageToken) {
          exhausted = true;
          break;
        }
        token = page.nextPageToken;
      } catch (err) {
        if (token !== null && fetched.length === 0 && err instanceof EmailTransportError && err.kind === 'invalid_page_token') {
          // The stored token went stale: re-read the same window from its first page.
          restarts += 1;
          token = null;
          continue;
        }
        fetchError = err;
        failedToken = token;
        break;
      }
    }

    // ── a failed fetch: classify, persist what is provider-side, decide throw vs partial ──
    let errorInfo: EmailSyncResult['error'];
    if (fetchError) {
      errorInfo = this.handleFetchError(accountId, fetchError, events);
      if (fetched.length === 0 && !(errorInfo.code === 'CONNECTION_EXPIRED' || errorInfo.code === 'COMPOSIO_AUTH')) {
        throw errorInfo.code === 'RATE_LIMITED' || errorInfo.code === 'BUDGET_EXHAUSTED'
          ? this.cooldownError(errorInfo.retryAtMs ?? this.nowFn() + this.defaultCooldownMs, 'sync')
          : new CareError('NETWORK_TIMEOUT', 'Gmail read failed before any page was fetched', 504);
      }
    }

    // ── normalise: oldest first so thread columns end on the newest message ──
    const plan: WindowPlan = {
      expectedStep: mailbox.step,
      coveredBefore: coveredSec,
      window: { ...window, restarts },
      pages: fetched.map((p) => ({ tokenBefore: p.tokenBefore, eventIds: [] })),
      tokenAfter: fetchError ? null : token,
      exhausted: !fetchError && exhausted,
      fetchFailed: fetchError != null,
      ...(fetchError != null ? { failedToken } : {}),
      deferredPages: [],
      restarts,
    };
    const seen = new Set<string>();
    const tagged: Array<{ msg: GmailMessage; page: number }> = [];
    fetched.forEach((p, idx) => {
      for (const m of p.messages) {
        if (seen.has(m.gmailMessageId)) continue;
        seen.add(m.gmailMessageId);
        tagged.push({ msg: m, page: idx });
      }
    });
    tagged.sort((a, b) => a.msg.sentAtMs - b.msg.sentAtMs || (a.msg.gmailMessageId < b.msg.gmailMessageId ? -1 : 1));

    let deferred = 0;
    for (const { msg, page } of tagged) {
      if (isDraft(msg)) continue;
      const produced = this.eventsFor(accountId, cfg, window, msg, epoch, commits);
      if (produced === 'defer') {
        deferred += 1;
        if (!plan.deferredPages.includes(page)) plan.deferredPages.push(page);
        continue;
      }
      for (const e of produced) {
        plan.pages[page].eventIds.push(e.eventId);
        events.push(e);
      }
    }
    commits.push({ kind: 'window', plan });
    return this.assemble(
      events,
      commits,
      plan,
      command.checkpoint?.cursor,
      { pagesRead: fetched.length, fetched: tagged.length, deferred },
      errorInfo,
    );
  }

  /** Persists the provider-side consequence of a failed read (cooldown / expired flag) and names it. */
  private handleFetchError(accountId: string, err: unknown, events: NormalizedEvent[]): NonNullable<EmailSyncResult['error']> {
    const now = this.nowFn();
    if (err instanceof EmailTransportError) {
      switch (err.kind) {
        case 'connection_expired': {
          this.store.markExpired(accountId);
          const rev = this.store.getMailbox(accountId)!.statusRev;
          events.push(
            this.statusEvent(accountId, `gm:status:${accountId}:expired:${rev}`, 'error', 'CONNECTION_EXPIRED', 'Gmail connection expired; reconnect the mailbox'),
          );
          return { code: 'CONNECTION_EXPIRED' };
        }
        case 'auth': {
          const until = now + this.recheckMs;
          this.store.setCooldown(accountId, 'sync', until, 'COMPOSIO_AUTH');
          events.push(
            this.statusEvent(
              accountId,
              `gm:status:${accountId}:auth:${Math.floor(until / this.recheckMs)}`,
              'error',
              'COMPOSIO_AUTH',
              'Composio key is missing or rejected',
            ),
          );
          return { code: 'COMPOSIO_AUTH', retryAtMs: until };
        }
        case 'rate_limited': {
          const until = err.retryAtMs ?? now + this.defaultCooldownMs;
          this.store.setCooldown(accountId, 'sync', until, 'RATE_LIMITED');
          return { code: 'RATE_LIMITED', retryAtMs: until };
        }
        case 'budget_exhausted': {
          // The hourly budget is shared by sync and send.
          const until = err.retryAtMs ?? nextHourMs(now);
          this.store.setCooldown(accountId, 'sync', until, 'BUDGET_EXHAUSTED');
          this.store.setCooldown(accountId, 'send', until, 'BUDGET_EXHAUSTED');
          return { code: 'BUDGET_EXHAUSTED', retryAtMs: until };
        }
        default:
          return { code: 'FETCH_FAILED' };
      }
    }
    return { code: 'FETCH_FAILED' };
  }

  private assemble(
    events: NormalizedEvent[],
    commits: EmailCommit[],
    plan: WindowPlan,
    expectedCursor: string | undefined,
    stats: { pagesRead: number; fetched: number; deferred: number },
    error: EmailSyncResult['error'],
  ): EmailSyncResult {
    const outcome = planOutcome(plan, new Set());
    const cursor: MailboxCursor = {
      coveredSec: outcome.coveredSec,
      windowEndSec: outcome.window?.endSec ?? 0,
      windowLowerSec: outcome.window?.lowerSec ?? 0,
      step: plan.expectedStep + 1,
    };
    const checkpoint: CareCheckpoint = {
      namespace: GMAIL_BOX,
      cursor: encodeCursor(cursor),
      position: cursorPosition(cursor),
      // Compare-and-set only against a cursor core itself handed us (the connector store is the mirror).
      ...(expectedCursor !== undefined ? { expectedCursor } : {}),
    };
    // Same rule as the Telegram connector: the checkpoint rides on the LAST message event so Care's own
    // ingest transaction advances it atomically with the effects. The window itself advances in commit().
    let last = events.length - 1;
    while (last >= 0 && events[last].type === 'account.status') last -= 1;
    if (last >= 0) events[last] = { ...events[last], checkpoint };
    return {
      events,
      nextCheckpoint: checkpoint,
      hasMore: !error && outcome.window != null,
      checkpoints: [checkpoint],
      commits,
      partial: outcome.window != null,
      pagesRead: stats.pagesRead,
      fetched: stats.fetched,
      deferred: stats.deferred,
      ...(error ? { error } : {}),
    };
  }

  /**
   * Events of one message, or 'defer' when it must wait. `commits` collects connector-local facts
   * (echo candidates) that are applied together with the window.
   */
  private eventsFor(
    accountId: string,
    cfg: EmailAccountConfig,
    window: WindowState,
    msg: GmailMessage,
    epoch: number,
    commits: EmailCommit[],
  ): NormalizedEvent[] | 'defer' {
    if (cfg.careSinceMs == null || msg.sentAtMs <= cfg.careSinceMs) return [];
    const origin = classifyOrigin(msg.sentAtMs, cfg.careSinceMs, window.kind);
    const patterns = cfg.extraAutomatedPatterns ?? [];
    const messageEvent = (role?: 'self' | 'operator' | 'agent'): NormalizedEvent => ({
      type: 'message.created',
      eventId: `gm:msg:${accountId}:${msg.gmailMessageId}`,
      accountId,
      timestampMs: msg.sentAtMs,
      epoch,
      message: toNormalizedMessage({ accountId, msg, origin, outboundRole: role, extraAutomatedPatterns: patterns }),
    });

    if (!isOutbound(msg)) {
      const event = messageEvent();
      if (event.type === 'message.created' && event.message.metadata.type === 'email' && event.message.metadata.isAutomated) return [];
      return [event];
    }

    const byId = this.store.getAttemptByGmailId(accountId, msg.gmailMessageId);
    if (byId) {
      const out: NormalizedEvent[] = [messageEvent(roleOf(byId))];
      if (byId.state === 'accepted') {
        out.push({
          type: 'delivery.confirmed',
          eventId: `gm:dc:${accountId}:${byId.token}`,
          accountId,
          timestampMs: msg.sentAtMs,
          epoch,
          clientRequestId: byId.clientRequestId,
          nativeMessageId: msg.gmailMessageId,
          // The mail is in the mailbox's SENT: accepted. Never delivered/read from this evidence.
          receiptLevel: 'accepted',
        });
      }
      return out;
    }

    const unresolved = this.store.listUnresolvedForThread(accountId, msg.gmailThreadId);
    if (unresolved.length === 0) return [messageEvent('self')];

    const hash = textHash(msg.bodyText);
    const match = unresolved.find((a) => a.textHash === hash && (a.firstRpcAtMs == null || msg.sentAtMs >= a.firstRpcAtMs - 120_000));
    if (match) {
      // Looks like our own mail: file it with the attempt's role so the agent is not paused by its own
      // reply. This is EVIDENCE for a human, not a confirmation of the delivery.
      commits.push({ kind: 'candidate', token: match.token, gmailMessageId: msg.gmailMessageId });
      return [messageEvent(roleOf(match))];
    }
    const now = this.nowFn();
    if (unresolved.some((a) => a.firstRpcAtMs != null && now - a.firstRpcAtMs <= this.echoGraceMs)) return 'defer';
    return [messageEvent('self')];
  }

  /**
   * Applies connector-local commits. The runtime calls this ONLY after the events of the same
   * `sync` result were durably ingested (or when it had none). `failedEventIds` are events that
   * could NOT be stored: the window then resumes at the first page holding one, and the covered
   * cursor does not move. A stale commit (the mailbox moved) throws and changes nothing.
   */
  commit(accountId: string, commits: readonly EmailCommit[], opts: { failedEventIds?: Iterable<string> } = {}): void {
    const failed = new Set(opts.failedEventIds ?? []);
    const run = this.opts.db.transaction(() => {
      for (const c of commits) {
        if (c.kind === 'candidate') this.store.noteCandidate(accountId, c.token, c.gmailMessageId);
        else if (c.kind === 'healthy') this.store.consumeHealthyAnnouncement(accountId);
      }
      for (const c of commits) {
        if (c.kind !== 'window') continue;
        const next = planOutcome(c.plan, failed);
        this.store.advanceMailbox(accountId, { expectedStep: c.plan.expectedStep, coveredSec: next.coveredSec, window: next.window });
      }
    });
    run.immediate();
  }

  // ── dispatch ─────────────────────────────────────────────────────────────────────────────
  async dispatch(command: DeliveryCommand): Promise<EmailDeliveryResult> {
    validateDeliveryCommand(command);
    if (command.kind !== 'email' || command.channel !== 'email') {
      throw new CareError('INVALID_TARGET', `Delivery for '${command.channel}' sent to an 'email' connector`, 400);
    }
    const cmd = command;
    const accountId = cmd.accountId;

    if (this.epoch(accountId) !== cmd.ownerEpoch) {
      throw new CareError(
        'FENCING_REJECTED',
        `Owner epoch mismatch: connector active epoch is ${this.epoch(accountId)}, command has ${cmd.ownerEpoch}`,
        409,
      );
    }
    const token = cmd.adapterRetryToken;
    if (!token) {
      throw new CareError('INVALID_COMMAND', 'adapterRetryToken is mandatory: persist it before the first attempt', 400);
    }
    // Capabilities reported false are enforced here, not only advertised.
    if (cmd.bcc && cmd.bcc.length > 0) throw new CareError('UNSUPPORTED_CAPABILITY', 'BCC is not supported by the Gmail connector', 422);
    const threadKey = cmd.target.externalConversationKey;
    if (!threadKey) throw new CareError('UNSUPPORTED_CAPABILITY', 'New mail (no existing thread) is not supported by the Gmail connector', 422);
    if (cmd.target.to.length !== 1) {
      throw new CareError('UNSUPPORTED_CAPABILITY', 'The Gmail reply tool takes exactly one primary recipient (use CC for the rest)', 422);
    }
    const payloadHash = emailPayloadHash(cmd);

    return this.lane(accountId, async () => {
      // Idempotent ledger first: an attempt that may already be at Gmail is answered without any RPC.
      const existing = this.store.getAttempt(accountId, token);
      if (existing) {
        if (existing.clientRequestId !== cmd.clientRequestId || existing.payloadHash !== payloadHash) {
          throw new CareError('DUPLICATE_REQUEST_PAYLOAD_MISMATCH', 'adapterRetryToken is already bound to a different request', 409);
        }
        if (existing.state === 'accepted') return this.acceptedResult(existing);
        if (existing.state === 'rejected') throw new CareError('TERMINAL_REJECTION', 'Gmail permanently rejected this request', 400);
        if (maybeSent(existing)) return this.resendBlocked(existing);
      } else {
        const byRequest = this.store.getAttemptByRequest(accountId, cmd.clientRequestId);
        if (byRequest) {
          throw new CareError('DUPLICATE_REQUEST_PAYLOAD_MISMATCH', 'clientRequestId is already bound to a different attempt token', 409);
        }
      }

      const cfg = this.opts.resolveAccount(accountId);
      if (!cfg) throw new CareError('ACCOUNT_FROZEN', 'No Gmail mailbox is configured for this account', 409);
      const mailbox = this.store.getMailbox(accountId);
      if (mailbox?.status === 'expired') {
        throw new CareError('ACCOUNT_FROZEN', 'Gmail connection expired; reconnect the mailbox', 409, {
          retryAtMs: this.nowFn() + this.recheckMs,
        });
      }
      const cooldown = this.store.getCooldownUntil(accountId, 'send');
      if (cooldown !== null) throw this.cooldownError(cooldown, 'send');

      // Persist BEFORE the RPC. One row per token; the RPC counter proves whether a call may have left.
      this.store.prepareAttempt({
        accountId,
        token,
        clientRequestId: cmd.clientRequestId,
        threadKey,
        payloadHash,
        textHash: textHash(cmd.text),
        actor: cmd.actor,
      });
      this.store.markRpcStarted(accountId, token);

      const features = this.opts.transport.features;
      try {
        const receipt = await this.opts.transport.send(cfg.target, {
          threadId: threadKey,
          to: [...cmd.target.to],
          cc: [...(cmd.target.cc ?? [])],
          subject: cmd.target.subject,
          body: cmd.text,
          ...(cmd.target.inReplyToHeader && features.explicitThreadingHeaders ? { inReplyTo: cmd.target.inReplyToHeader } : {}),
          attemptToken: token,
        });
        if (!receipt.messageId) {
          // "Successful" without a message id: the mail may well be out. Never claim a definite outcome.
          this.store.setState(accountId, token, 'uncertain');
          return { outcome: 'uncertain', adapterRetryToken: token, error: 'ACK_WITHOUT_MESSAGE_ID' };
        }
        this.store.setState(accountId, token, 'accepted', {
          messageId: receipt.messageId,
          threadId: receipt.threadId || threadKey,
          atMs: this.nowFn(),
        });
        return this.acceptedResult(this.store.getAttempt(accountId, token)!);
      } catch (err) {
        return this.handleSendError(accountId, token, err);
      }
    });
  }

  private handleSendError(accountId: string, token: string, err: unknown): EmailDeliveryResult {
    const now = this.nowFn();
    if (err instanceof EmailTransportError) {
      switch (err.kind) {
        case 'rate_limited': {
          const until = err.retryAtMs ?? now + this.defaultCooldownMs;
          this.store.setState(accountId, token, 'refused');
          this.store.setCooldown(accountId, 'send', until, 'RATE_LIMITED');
          throw this.cooldownError(until, 'send');
        }
        case 'budget_exhausted': {
          const until = err.retryAtMs ?? nextHourMs(now);
          this.store.setState(accountId, token, 'refused');
          this.store.setCooldown(accountId, 'send', until, 'BUDGET_EXHAUSTED');
          this.store.setCooldown(accountId, 'sync', until, 'BUDGET_EXHAUSTED');
          throw this.cooldownError(until, 'send');
        }
        case 'connection_expired':
          this.store.setState(accountId, token, 'refused');
          this.store.markExpired(accountId);
          throw new CareError('ACCOUNT_FROZEN', 'Gmail connection expired; reconnect the mailbox', 409, { retryAtMs: now + this.recheckMs });
        case 'auth':
          this.store.setState(accountId, token, 'refused');
          this.store.setCooldown(accountId, 'send', now + this.recheckMs, 'COMPOSIO_AUTH');
          throw new CareError('ACCOUNT_FROZEN', 'Composio key is missing or rejected', 409, { retryAtMs: now + this.recheckMs });
        case 'rejected':
          this.store.setState(accountId, token, 'rejected');
          throw new CareError('TERMINAL_REJECTION', 'Gmail rejected the message', 400);
        default:
          break;
      }
    }
    // Timeout, dropped connection, unknown error: the request may have reached Gmail.
    this.store.setState(accountId, token, 'uncertain');
    const code = err instanceof EmailTransportError ? err.kind : 'unknown';
    return { outcome: 'uncertain', adapterRetryToken: token, error: `NETWORK_UNCERTAIN: ${code}` };
  }

  private acceptedResult(a: EmailAttempt): EmailDeliveryResult {
    return {
      outcome: 'accepted',
      nativeMessageId: a.gmailMessageId ?? undefined,
      ...(a.gmailThreadId ? { nativeThreadId: a.gmailThreadId } : {}),
      adapterRetryToken: a.token,
      remoteTimestampMs: a.acceptedAtMs ?? undefined,
      receiptLevel: 'accepted',
    };
  }

  private resendBlocked(a: EmailAttempt): EmailDeliveryResult {
    return {
      outcome: 'uncertain',
      adapterRetryToken: a.token,
      ...(a.candidateMessageId ? { nativeMessageId: a.candidateMessageId } : {}),
      error: 'RESEND_BLOCKED: Gmail has no idempotency key, a request that may have been sent is never sent again; reconcile or review',
    };
  }

  async reconcile(command: ReconcileCommand): Promise<EmailDeliveryResult> {
    validateReconcileCommand(command);
    const accountId = command.accountId;
    return this.lane(accountId, async () => {
      const attempt = command.adapterRetryToken
        ? this.store.getAttempt(accountId, command.adapterRetryToken)
        : this.store.getAttemptByRequest(accountId, command.clientRequestId);
      if (!attempt || attempt.clientRequestId !== command.clientRequestId) {
        return { outcome: 'uncertain', error: 'No Gmail attempt recorded for this request; state remains uncertain' };
      }
      const mismatch =
        (command.nativeMessageId !== undefined && attempt.gmailMessageId !== null && command.nativeMessageId !== attempt.gmailMessageId) ||
        (command.externalConversationKey !== undefined && command.externalConversationKey !== attempt.threadKey);
      if (mismatch) {
        return { outcome: 'uncertain', error: 'Reconcile reference does not match the recorded attempt; not confirming it' };
      }
      if (attempt.state === 'accepted') return this.acceptedResult(attempt);
      if (attempt.state === 'rejected') {
        return { outcome: 'failed', adapterRetryToken: attempt.token, error: 'Gmail rejected the request' };
      }

      // Provider evidence, when the transport can really look a message up by our token.
      const cfg = this.opts.resolveAccount(accountId);
      const transport = this.opts.transport;
      if (cfg && transport.features.sentLookup && transport.findSent && maybeSent(attempt)) {
        try {
          const found = await transport.findSent(cfg.target, { attemptToken: attempt.token, threadId: attempt.threadKey });
          if (found) {
            this.store.setState(accountId, attempt.token, 'accepted', {
              messageId: found.messageId,
              threadId: found.threadId,
              atMs: found.sentAtMs ?? this.nowFn(),
            });
            return this.acceptedResult(this.store.getAttempt(accountId, attempt.token)!);
          }
        } catch {
          /* no evidence is not evidence of absence */
        }
      }
      // Thread / body / Message-ID matching is NOT a guarantee: show the candidate, decide nothing.
      return {
        outcome: 'uncertain',
        adapterRetryToken: attempt.token,
        ...(attempt.candidateMessageId ? { nativeMessageId: attempt.candidateMessageId } : {}),
        error: attempt.candidateMessageId
          ? 'A SENT mail in the thread looks like this request but is not proof; manual review required'
          : 'No Gmail evidence for this attempt; manual review required',
      };
    });
  }

  // ── read / media ─────────────────────────────────────────────────────────────────────────
  async markRead(_command: ReadCommand): Promise<ReadResult> {
    throw new CareError('UNSUPPORTED_CAPABILITY', 'Remote read receipts are not supported by the Gmail connector', 422);
  }

  async fetchAttachment(_command: MediaCommand): Promise<MediaResult> {
    throw new CareError('UNSUPPORTED_CAPABILITY', 'Attachment download is not supported: only metadata is read', 422);
  }
}

function roleOf(a: Pick<EmailAttempt, 'actor'>): 'operator' | 'agent' {
  return a.actor === 'auto' ? 'agent' : 'operator';
}

/** Hash of everything immutable about a send request (bound to its token in the ledger). */
export function emailPayloadHash(cmd: EmailDeliveryCommand): string {
  const lower = (list: string[] | undefined) => [...(list ?? [])].map((a) => a.toLowerCase()).sort();
  return sha256([
    cmd.target.externalConversationKey ?? '',
    lower(cmd.target.to),
    lower(cmd.target.cc),
    cmd.target.subject,
    cmd.target.replyToMessageId ?? '',
    cmd.target.inReplyToHeader ?? '',
    cmd.text,
  ]);
}

/**
 * Where the mailbox ends up after a plan, given the event ids that could not be stored.
 * The covered cursor moves ONLY when the provider reported no further page AND every page was
 * stored; otherwise the window stays open at the first page that was not fully saved.
 */
export function planOutcome(plan: WindowPlan, failedEventIds: ReadonlySet<string>): { coveredSec: number | null; window: WindowState | null } {
  if (plan.coverNowSec != null) return { coveredSec: plan.coverNowSec, window: null };
  const base = plan.window;
  let failedPage: number | undefined;
  plan.pages.forEach((p, idx) => {
    if (failedPage !== undefined) return;
    if (plan.deferredPages.includes(idx) || p.eventIds.some((id) => failedEventIds.has(id))) failedPage = idx;
  });
  if (failedPage !== undefined) {
    return {
      coveredSec: plan.coveredBefore,
      window: { ...base, pageToken: plan.pages[failedPage].tokenBefore, pagesDone: base.pagesDone + failedPage, restarts: plan.restarts },
    };
  }
  if (plan.fetchFailed) {
    return {
      coveredSec: plan.coveredBefore,
      window: { ...base, pageToken: plan.failedToken ?? null, pagesDone: base.pagesDone + plan.pages.length, restarts: plan.restarts },
    };
  }
  if (!plan.exhausted) {
    return {
      coveredSec: plan.coveredBefore,
      window: { ...base, pageToken: plan.tokenAfter, pagesDone: base.pagesDone + plan.pages.length, restarts: plan.restarts },
    };
  }
  // A deliberate full re-read that does not touch the covered range proves nothing about the gap.
  if (base.kind === 'full_backfill' && plan.coveredBefore != null && base.lowerSec > plan.coveredBefore) {
    return { coveredSec: plan.coveredBefore, window: null };
  }
  return { coveredSec: base.endSec, window: null };
}

