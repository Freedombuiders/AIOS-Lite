/**
 * Zalo (personal nick, zca-js) connector for Customer Care (CC-13, connector side).
 *
 * Implements `CareConnector` on top of the abstract `ZaloTransport`. It owns only transport
 * concerns: normalisation, the per-process attempt ledger, error classification, cooldown and honest
 * capabilities. Customers, assignments, drafts and the outbox stay in the shared Care core; the legacy
 * `zalo_*` tables are never written from here.
 *
 * Invariants (each has a test):
 *  - Honest capabilities: `sendDedupe` is FALSE (Zalo has no client-supplied retry token) and quote /
 *    seen-marker / media are advertised only if the transport really does them.
 *  - Send: the attempt is recorded in the ledger BEFORE the RPC. An ack without a message id, a lost
 *    ack, a timeout or any unknown failure is `uncertain`; the connector never resends by itself, and
 *    it refuses to dispatch a request whose previous attempt is unresolved until a reconcile released
 *    it (the Care outbox sends it to manual review). It never matches by body similarity unless
 *    `echoTextCorrelation` is explicitly switched on, and then only as evidence for a UNIQUE echo.
 *  - Only failures that guarantee nothing left the process are definite: not connected, session
 *    expired, send-locked, our rate limit / flood control (-> `RATE_LIMITED` + `details.retryAtMs`,
 *    a persisted cooldown in the outbox), permanent refusal (-> `TERMINAL_REJECTION`).
 *  - Echo of an own send is the same canonical message: same `msgId`, role `self`; a matching echo also
 *    emits `delivery.confirmed` for the request it belongs to.
 *  - Recovery: `sync` only READS (peek). `commit()` acknowledges the live feed AFTER the returned events
 *    were durably ingested; the checkpoint also rides on the last event so Care's ingest advances it
 *    atomically. Group history (`zalo_thread:<id>`) closes feed gaps; duplicates are folded by Care.
 */

import crypto from 'node:crypto';
import { CareError } from '../../../../_lib/care-kit/index.js';
import type { CareChannel, NormalizedEvent } from '../../../../_lib/care-kit/index.js';
import type { CareCheckpoint } from '../../../../_lib/care-kit/index.js';
import {
  validateAuthCommand,
  validateDeliveryCommand,
  validateReconcileCommand,
  type AuthCommand,
  type AuthResult,
  type CareConnector,
  type ChatDeliveryCommand,
  type ConnectorCapabilities,
  type DeliveryCommand,
  type DeliveryResult,
  type MediaCommand,
  type MediaResult,
  type ReadCommand,
  type ReadResult,
  type ReconcileCommand,
  type SyncCommand,
  type SyncResult,
} from '../../../../_lib/care-kit/index.js';
import { quoteTargetOf, seenTargetOf, type StoredZaloMessage } from './wire.js';
import { nativeIdOf, normalizeZaloMessage, normalizeZaloUndo, ZALO_NAMESPACE } from './normalize.js';
import {
  DEFINITE_NOT_SENT,
  ZaloTransportError,
  type ZaloFeatures,
  type ZaloQuoteTarget,
  type ZaloRawMessage,
  type ZaloSendLookup,
  type ZaloThreadKind,
  type ZaloTransport,
} from './transport.js';

const LIVE_BOX = 'zalo_chat';
const THREAD_BOX = /^zalo_thread:([A-Za-z0-9._@-]{1,128})$/;
/** Zalo's own text cap (legacy sender MAX_MESSAGE_CHARS); longer text is refused, never silently cut. */
const DEFAULT_MAX_TEXT = 2000;
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const MEDIA_HOST_SUFFIXES = ['.zdn.vn', '.zadn.vn', '.zalo.me', '.zaloapp.com', '.zalo.vn'];

export interface ZaloConnectorOptions {
  transport: ZaloTransport;
  /** Ownership epoch authority. Required: Care fails closed, there is no "epoch 1 by default". */
  getActiveEpoch: (accountId: string) => number;
  now?: () => number;
  /**
   * Reads one stored message (decrypted canonical text + metadata). With it, a quoted reply and a seen marker are built
   * from the message's own wire data; a message that lacks any required field is REFUSED (UNSUPPORTED_CAPABILITY /
   * `{ ok:false }`), never quoted or marked on a guess. Without it the connector passes only the native id to the
   * transport (what the in-process fakes need).
   */
  resolveMessage?: (accountId: string, conversationKey: string, nativeMessageId: string) => StoredZaloMessage | null;
  /** Conversation kind for a key not (yet) seen by `sync`; the runtime reads it from care_conversations. */
  resolveThreadKind?: (accountId: string, externalKey: string) => ZaloThreadKind | null;
  /**
   * Off by default. When on, `reconcile` may treat ONE identical-text own echo inside the attempt window
   * as evidence of acceptance. Ambiguity (two candidates, two open requests with the same text) stays uncertain.
   */
  echoTextCorrelation?: boolean;
  echoWindowMs?: number;
  maxTextChars?: number;
  /** Live items per sync slice. */
  syncLimit?: number;
  titleTtlMs?: number;
  /** Names and avatars of a thread and of the given sender uids, for Care's inbox. Without it Care shows initials. */
  profiles?: (accountId: string, externalKey: string, senderUids: string[]) => Promise<ZaloPeople | null>;
  /** Avatar the module already stored for a thread (no Zalo call), for Care's list rows. */
  storedAvatarUrl?: (accountId: string, externalKey: string) => string | null;
}

/** A person or group as Zalo shows it; empty strings when unknown. */
export interface ZaloPerson {
  name: string;
  avatarUrl: string;
}

export interface ZaloPeople {
  thread: ZaloPerson;
  /** By Zalo uid. */
  senders: Record<string, ZaloPerson>;
}

type AttemptState = 'started' | 'accepted' | 'failed_definite' | 'uncertain' | 'released';

interface LedgerEntry {
  clientRequestId: string;
  token: string | null;
  payloadHash: string;
  conversationKey: string;
  text: string;
  state: AttemptState;
  startedAtMs: number;
  nativeMessageId?: string;
  acceptedAtMs?: number;
}

interface OwnEcho {
  id: string;
  threadId: string;
  text: string;
  tsMs: number;
}

/** Applied via `commit()` after the events of a sync slice were durably ingested. */
export interface ZaloLiveCommit {
  accountId: string;
  feedId: string;
  upToSeq: number;
}

export interface ZaloSyncResult extends SyncResult {
  /** Present when the live feed moved; acknowledge it with `commit()` once the events are ingested. */
  commits: ZaloLiveCommit[];
  /** The feed dropped items: schedule group-history syncs (`zalo_thread:<id>`) for active groups. */
  gap: boolean;
  /** Payloads that could not be ingested (no message id / no thread). Counts only, never content. */
  skipped: number;
}

export interface ZaloAuthResult extends AuthResult {
  step: 'qr_pending' | 'authorized' | 'failed' | 'unsupported';
  qr?: string;
}

/** The cursor the runtime holds for the box; an empty cursor means "no checkpoint stored yet" (CAS on null). */
function storedCursor(command: SyncCommand): string | null {
  return command.checkpoint?.cursor ? command.checkpoint.cursor : null;
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const keyOf = (accountId: string, id: string) => JSON.stringify([accountId, id]);

/** An avatar link the browser may load: https on Zalo's own CDN only, else ''. */
function zaloImageUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return '';
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && MEDIA_HOST_SUFFIXES.some((s) => host.endsWith(s)) ? url.toString() : '';
  } catch {
    return '';
  }
}

const zaloPerson = (p: Partial<ZaloPerson> | undefined): ZaloPerson => ({
  name: typeof p?.name === 'string' ? p.name : '',
  avatarUrl: zaloImageUrl(p?.avatarUrl),
});

/** Longest a shutdown waits for provider operations that are still in flight. */
const CLOSE_WAIT_MS = 2_000;

export class ZaloCareConnector implements CareConnector {
  readonly kind = 'zalo-zca';
  /**
   * Care polls this connector itself (sync_poll jobs read the daemon's buffered live feed). Without this flag Care
   * never scheduled a poll, so Zalo messages stayed in zalo_* and never reached the Care inbox.
   */
  readonly careManagedSync = true;
  readonly channel: CareChannel = 'zalo';

  private readonly transport: ZaloTransport;
  private readonly nowFn: () => number;
  private readonly maxText: number;
  private readonly syncLimit: number;
  private readonly titleTtlMs: number;
  private readonly echoWindowMs: number;
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly tokenOwners = new Map<string, string>();
  private readonly threadKinds = new Map<string, ZaloThreadKind>();
  private readonly titleAt = new Map<string, number>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly echoes = new Map<string, OwnEcho[]>();
  private readonly lanes = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: ZaloConnectorOptions) {
    this.transport = opts.transport;
    this.nowFn = opts.now ?? (() => Date.now());
    this.maxText = opts.maxTextChars ?? DEFAULT_MAX_TEXT;
    this.syncLimit = opts.syncLimit ?? 50;
    this.titleTtlMs = opts.titleTtlMs ?? 10 * 60_000;
    this.echoWindowMs = opts.echoWindowMs ?? 120_000;
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
    this.ledger.clear();
    this.tokenOwners.clear();
    this.threadKinds.clear();
    this.titleAt.clear();
    this.cooldownUntil.clear();
    this.echoes.clear();
    try {
      await this.transport.close?.();
    } catch {
      /* shutdown must go on */
    }
  }

  // ── capabilities ─────────────────────────────────────────────────────────────────────────
  async capabilities(accountId: string, _conversationKey?: string): Promise<ConnectorCapabilities> {
    const f: ZaloFeatures = await this.transport.features(accountId);
    return {
      text: f.text,
      reply: f.text && f.quote,
      replyAll: false,
      // Neither edit nor recall is wired on the send side: advertising them would be a lie.
      edit: false,
      delete: false,
      reaction: false,
      typing: f.typing,
      remoteRead: f.markRead,
      backfill: f.history.group || f.history.directPush,
      // Zalo has no client-supplied dedupe token: a retry after an unknown outcome could double-send.
      sendDedupe: false,
      mediaKinds: [...f.sendMedia],
      bcc: false,
      newMail: false,
    };
  }

  // ── auth ─────────────────────────────────────────────────────────────────────────────────
  async connect(command: AuthCommand): Promise<ZaloAuthResult> {
    const valid = validateAuthCommand(command);
    if (valid.channel !== 'zalo') {
      throw new CareError('INVALID_TARGET', `Auth for '${valid.channel}' sent to the Zalo connector`, 400);
    }
    if (valid.method === 'session_restore') {
      return {
        ok: false,
        accountId: valid.accountId,
        step: 'unsupported',
        error: 'The legacy Zalo transport restores its own saved session; use qr_start',
      };
    }
    const res = await this.transport.startQrLogin(valid.accountId);
    return {
      ok: res.step === 'authorized',
      accountId: valid.accountId,
      step: res.step,
      ...(res.qr ? { qr: res.qr } : {}),
      ...(res.nativeAccountId ? { nativeAccountId: res.nativeAccountId } : {}),
      ...(res.label ? { label: res.label } : {}),
      ...(res.error ? { error: res.error } : {}),
    };
  }

  // ── sync ─────────────────────────────────────────────────────────────────────────────────
  async sync(command: SyncCommand): Promise<ZaloSyncResult> {
    const accountId = command.accountId;
    const epoch = this.opts.getActiveEpoch(accountId);
    const namespace = command.checkpoint?.namespace ?? LIVE_BOX;
    const limit = Math.max(1, Math.min(command.limit ?? this.syncLimit, 500));

    const thread = THREAD_BOX.exec(namespace);
    if (namespace !== LIVE_BOX && !thread) {
      throw new CareError('INVALID_CURSOR', `Unsupported Zalo checkpoint box '${namespace}'`, 400);
    }
    return thread
      ? this.syncGroupHistory(command, accountId, epoch, thread[1], limit)
      : this.syncLive(command, accountId, epoch, limit);
  }

  private async syncLive(command: SyncCommand, accountId: string, epoch: number, limit: number): Promise<ZaloSyncResult> {
    if (command.fullBackfill && (await this.transport.features(accountId)).history.directPush) {
      await this.transport.requestDirectHistory(accountId, null);
    }
    const page = await this.transport.peekLive(accountId, limit);
    const ownUid = await this.transport.ownUid(accountId);
    const now = this.nowFn();
    const events: NormalizedEvent[] = [];
    let skipped = 0;
    const seenInSlice = new Set<string>();

    for (const item of page.items) {
      if (item.kind === 'undo') {
        const recall = normalizeZaloUndo(item.undo, now);
        if (!recall) {
          skipped += 1;
          continue;
        }
        events.push({
          type: 'message.deleted',
          eventId: `zalo:${accountId}:undo:${recall.nativeMessageId}`,
          accountId,
          timestampMs: recall.tsMs,
          epoch,
          nativeMessageNamespace: ZALO_NAMESPACE,
          nativeMessageId: recall.nativeMessageId,
          ...(recall.externalConversationKey ? { externalConversationKey: recall.externalConversationKey } : {}),
          nativeVersion: null,
        });
        continue;
      }
      const emitted = await this.messageEvents(accountId, epoch, item.message, item.origin, ownUid, now, seenInSlice);
      if (emitted === null) skipped += 1;
      else events.push(...emitted);
    }

    const last = page.items[page.items.length - 1];
    let nextCheckpoint: CareCheckpoint | undefined;
    const commits: ZaloLiveCommit[] = [];
    if (last) {
      nextCheckpoint = {
        namespace: LIVE_BOX,
        cursor: `${page.feedId}:${last.seq}`,
        expectedCursor: storedCursor(command),
      };
      commits.push({ accountId, feedId: page.feedId, upToSeq: last.seq });
      if (events.length > 0) events[events.length - 1] = { ...events[events.length - 1], checkpoint: nextCheckpoint };
    }
    return { events, nextCheckpoint, hasMore: page.hasMore, commits, gap: page.gap, skipped };
  }

  private async syncGroupHistory(
    command: SyncCommand,
    accountId: string,
    epoch: number,
    groupId: string,
    limit: number,
  ): Promise<ZaloSyncResult> {
    if (!(await this.transport.features(accountId)).history.group) {
      throw new CareError('UNSUPPORTED_CAPABILITY', 'Group history is not available on this transport', 409);
    }
    let raws: ZaloRawMessage[];
    try {
      raws = await this.transport.readGroupHistory(accountId, groupId, limit);
    } catch (e) {
      throw this.mapReadError(accountId, e);
    }
    const origin = command.fullBackfill ? 'history' : 'recovery';
    const ownUid = await this.transport.ownUid(accountId);
    const now = this.nowFn();
    const ordered = [...raws].sort((a, b) => Number(a.data.ts ?? 0) - Number(b.data.ts ?? 0));
    const events: NormalizedEvent[] = [];
    let skipped = 0;
    let newest: string | null = null;
    const seenInSlice = new Set<string>();
    for (const raw of ordered) {
      const emitted = await this.messageEvents(accountId, epoch, { ...raw, threadId: raw.threadId || groupId, threadKind: 'group' }, origin, ownUid, now, seenInSlice);
      if (emitted === null) {
        skipped += 1;
        continue;
      }
      events.push(...emitted);
      newest = nativeIdOf(raw.data) ?? newest;
    }
    let nextCheckpoint: CareCheckpoint | undefined;
    if (newest) {
      nextCheckpoint = {
        namespace: `zalo_thread:${groupId}`,
        cursor: `h:${newest}`,
        ...(/^\d{1,40}$/.test(newest) ? { position: newest } : {}),
        expectedCursor: storedCursor(command),
      };
      if (events.length > 0) events[events.length - 1] = { ...events[events.length - 1], checkpoint: nextCheckpoint };
    }
    return { events, nextCheckpoint, hasMore: false, commits: [], gap: false, skipped };
  }

  /** Acknowledges a live slice. Call ONLY after its events were durably ingested. */
  async commit(commit: ZaloLiveCommit): Promise<void> {
    await this.transport.ackLive(commit.accountId, commit.feedId, commit.upToSeq);
  }

  /**
   * Care's hook after a sync slice was ingested. The feed is acknowledged only when EVERY event of the slice was
   * stored; otherwise the slice is read again next poll and Care folds the duplicates.
   */
  async commitSync(_accountId: string, result: SyncResult, outcome: { failedEventIds: string[] }): Promise<void> {
    if (outcome.failedEventIds.length > 0) return;
    for (const c of (result as Partial<ZaloSyncResult>).commits ?? []) await this.commit(c);
  }

  private async messageEvents(
    accountId: string,
    epoch: number,
    raw: ZaloRawMessage,
    origin: 'live' | 'history' | 'recovery',
    ownUid: string | null,
    now: number,
    seenInSlice: Set<string>,
  ): Promise<NormalizedEvent[] | null> {
    const norm = normalizeZaloMessage(raw, { accountId, ownUid, origin, nowMs: now });
    if (!norm) return null;
    const m = norm.message;
    const out: NormalizedEvent[] = [];
    this.threadKinds.set(keyOf(accountId, m.externalConversationKey), norm.threadKind);

    // First sight of a thread (or an expired title): give the conversation a real name before its first message.
    const titleKey = keyOf(accountId, m.externalConversationKey);
    const lastTitleAt = this.titleAt.get(titleKey);
    if (lastTitleAt === undefined || now - lastTitleAt >= this.titleTtlMs) {
      this.titleAt.set(titleKey, now);
      let title: string | null = null;
      try {
        title = await this.transport.resolveTitle(accountId, m.externalConversationKey, norm.threadKind);
      } catch {
        title = null; // best effort: a name lookup never blocks ingestion
      }
      if (title) {
        out.push({
          type: 'conversation.updated',
          eventId: `zalo:${accountId}:conv:${m.externalConversationKey}:${sha(title).slice(0, 16)}`,
          accountId,
          timestampMs: m.sentAtMs,
          epoch,
          externalConversationKey: m.externalConversationKey,
          title,
          kind: norm.threadKind === 'group' ? 'group' : 'direct',
        });
      }
    }

    // Origin is part of the event identity: a message first read as history and later seen live must
    // still reach Care as a live observation (Care promotes it), not be swallowed by the event ledger.
    const eventId = `zalo:${accountId}:${origin}:msg:${m.nativeMessageId}`;
    if (seenInSlice.has(eventId)) return out.length ? out : [];
    seenInSlice.add(eventId);
    out.push({ type: 'message.created', eventId, accountId, timestampMs: m.sentAtMs, epoch, message: m });

    if (m.direction === 'out') {
      this.rememberEcho(accountId, { id: m.nativeMessageId, threadId: m.externalConversationKey, text: m.text, tsMs: m.sentAtMs });
      const attempt = this.findAcceptedByNative(accountId, m.nativeMessageId);
      if (attempt) {
        out.push({
          type: 'delivery.confirmed',
          eventId: `zalo:${accountId}:echo:${m.nativeMessageId}`,
          accountId,
          timestampMs: m.sentAtMs,
          epoch,
          clientRequestId: attempt.clientRequestId,
          nativeMessageId: m.nativeMessageId,
          receiptLevel: 'accepted',
        });
      }
    }
    return out;
  }

  // ── delivery ─────────────────────────────────────────────────────────────────────────────
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

  async dispatch(command: DeliveryCommand): Promise<DeliveryResult> {
    validateDeliveryCommand(command);
    if (command.kind !== 'chat' || command.channel !== 'zalo') {
      throw new CareError('INVALID_TARGET', `Delivery for '${command.channel}' sent to the Zalo connector`, 400);
    }
    return this.lane(command.accountId, () => this.dispatchChat(command));
  }

  private async dispatchChat(command: ChatDeliveryCommand): Promise<DeliveryResult> {
    const accountId = command.accountId;
    const now = this.nowFn();

    // 1. strict epoch equality (stale AND desynced-future writers are fenced)
    const active = this.opts.getActiveEpoch(accountId);
    if (command.ownerEpoch !== active) {
      throw new CareError('FENCING_REJECTED', `Owner epoch mismatch: connector active epoch is ${active}, command has ${command.ownerEpoch}`, 409);
    }

    // 2. text and capability checks: nothing here has touched the provider
    if (command.text.trim() === '') throw new CareError('INVALID_COMMAND', 'Zalo message text is empty', 400);
    if (command.text.length > this.maxText) {
      throw new CareError('INVALID_COMMAND', `Zalo text is limited to ${this.maxText} characters`, 400);
    }
    const features = await this.transport.features(accountId);
    if (!features.text) throw new CareError('UNSUPPORTED_CAPABILITY', 'Sending is disabled or unsupported for this Zalo nick', 409);
    if (command.target.replyToMessageId && !features.quote) {
      throw new CareError('UNSUPPORTED_CAPABILITY', 'Quoted replies are not supported by the Zalo transport', 409);
    }
    const key = command.target.externalConversationKey;
    const threadKind = this.threadKinds.get(keyOf(accountId, key)) ?? this.opts.resolveThreadKind?.(accountId, key) ?? null;
    if (!threadKind) throw new CareError('INVALID_TARGET', 'Unknown Zalo conversation kind (not seen by sync, not resolvable)', 400);

    // A quoted reply is sent only with the quoted message's own wire data (see ZaloConnectorOptions.resolveMessage).
    let quote: ZaloQuoteTarget | undefined;
    if (command.target.replyToMessageId && this.opts.resolveMessage) {
      const stored = this.opts.resolveMessage(accountId, key, command.target.replyToMessageId);
      const target = quoteTargetOf(stored);
      if (!target) {
        throw new CareError(
          'UNSUPPORTED_CAPABILITY',
          'The quoted message has no stored Zalo wire data (older, bridged or non-text message): it cannot be quoted, send it without the quote or review it',
          409,
        );
      }
      quote = target;
    }

    // 3. request + token ledger (in-process safety belt; the durable record is the Care outbox attempt)
    const payloadHash = sha(JSON.stringify([key, command.text, command.target.replyToMessageId ?? '', command.adapterRetryToken ?? '']));
    const ledgerKey = keyOf(accountId, command.clientRequestId);
    const token = command.adapterRetryToken ?? null;
    if (token) {
      const owner = this.tokenOwners.get(keyOf(accountId, token));
      if (owner !== undefined && owner !== command.clientRequestId) {
        throw new CareError('DUPLICATE_REQUEST_PAYLOAD_MISMATCH', 'adapterRetryToken is already bound to a different request', 409);
      }
    }
    const existing = this.ledger.get(ledgerKey);
    if (existing) {
      if (existing.payloadHash !== '' && existing.payloadHash !== payloadHash) {
        throw new CareError('DUPLICATE_REQUEST_PAYLOAD_MISMATCH', `clientRequestId '${command.clientRequestId}' was previously used with a different payload`, 409);
      }
      if (existing.state === 'accepted') {
        return this.acceptedResult(existing);
      }
      if (existing.state === 'started' || existing.state === 'uncertain') {
        throw new CareError('UNRESOLVED_UNCERTAINTY', 'The previous attempt of this request is unresolved; reconcile it before sending again', 409);
      }
      // failed_definite / released: the previous attempt provably (or by explicit reconcile) did not deliver.
    }

    // 4. cooldown + budgets, surfaced as RATE_LIMITED with a retry time the outbox persists
    const cooling = this.cooldownUntil.get(accountId) ?? 0;
    if (cooling > now) throw this.rateLimited('Zalo cooldown is active for this nick', cooling);
    const rate = await this.transport.rateStatus(accountId);
    if (!rate.ok) {
      if (rate.reason === 'locked') throw new CareError('SEND_DISABLED', 'The Zalo nick is send-locked', 409);
      const until = now + (rate.retryAfterMs ?? 60 * 60_000);
      this.cooldownUntil.set(accountId, until);
      throw this.rateLimited(`Zalo send budget exhausted (${rate.reason ?? 'limit'})`, until);
    }

    // 5. persist-before-RPC, then send exactly once
    const entry: LedgerEntry = {
      clientRequestId: command.clientRequestId,
      token,
      payloadHash,
      conversationKey: key,
      text: command.text,
      state: 'started',
      startedAtMs: now,
    };
    this.ledger.set(ledgerKey, entry);
    if (token) this.tokenOwners.set(keyOf(accountId, token), command.clientRequestId);

    try {
      const ack = await this.transport.send(accountId, {
        threadId: key,
        threadKind,
        text: command.text,
        ...(command.target.replyToMessageId ? { replyToMessageId: command.target.replyToMessageId } : {}),
        ...(quote ? { quote } : {}),
        requestId: command.clientRequestId,
        ...(token ? { attemptToken: token } : {}),
        ownerEpoch: command.ownerEpoch,
        actor: command.actor,
      });
      if (!ack.msgId) {
        // The request went out and nothing names the message: it cannot be proven, linked to its echo, or retried.
        entry.state = 'uncertain';
        return { outcome: 'uncertain', adapterRetryToken: token ?? undefined, error: 'Zalo accepted the request but returned no message id; manual reconcile required' };
      }
      entry.state = 'accepted';
      entry.nativeMessageId = ack.msgId;
      entry.acceptedAtMs = ack.tsMs ?? this.nowFn();
      return this.acceptedResult(entry);
    } catch (e) {
      throw this.mapSendError(accountId, entry, e);
    }
  }

  private acceptedResult(e: LedgerEntry): DeliveryResult {
    return {
      outcome: 'accepted',
      nativeMessageId: e.nativeMessageId,
      adapterRetryToken: e.token ?? undefined,
      remoteTimestampMs: e.acceptedAtMs,
      receiptLevel: 'accepted',
    };
  }

  private rateLimited(message: string, untilMs: number): CareError {
    return new CareError('RATE_LIMITED', message, 429, { retryAtMs: untilMs, retryAfterMs: Math.max(0, untilMs - this.nowFn()), scope: 'zalo' });
  }

  private mapSendError(accountId: string, entry: LedgerEntry, e: unknown): CareError {
    if (e instanceof CareError) {
      entry.state = 'failed_definite';
      return e;
    }
    if (!(e instanceof ZaloTransportError)) {
      entry.state = 'uncertain';
      return new CareError('NETWORK_TIMEOUT', 'Unexpected Zalo transport failure; the message may have been delivered', 504);
    }
    entry.state = DEFINITE_NOT_SENT.has(e.kind) ? 'failed_definite' : 'uncertain';
    switch (e.kind) {
      case 'rate_limited': {
        const until = this.nowFn() + (e.retryAfterMs ?? 60_000);
        this.cooldownUntil.set(accountId, until);
        return this.rateLimited(e.message, until);
      }
      case 'not_connected':
      case 'session_expired':
      case 'send_locked':
        return new CareError('SEND_DISABLED', e.message, 409, { reason: e.kind });
      case 'fenced':
        return new CareError('FENCING_REJECTED', e.message, 409);
      case 'unresolved':
        return new CareError('UNRESOLVED_UNCERTAINTY', e.message, 409);
      case 'rejected':
        return new CareError('TERMINAL_REJECTION', e.message, 400);
      default:
        return new CareError('NETWORK_TIMEOUT', e.message, 504);
    }
  }

  private mapReadError(accountId: string, e: unknown): unknown {
    if (e instanceof ZaloTransportError && e.kind === 'rate_limited') {
      const until = this.nowFn() + (e.retryAfterMs ?? 60_000);
      this.cooldownUntil.set(`read:${accountId}`, until);
      return this.rateLimited(e.message, until);
    }
    if (e instanceof ZaloTransportError && (e.kind === 'not_connected' || e.kind === 'session_expired')) {
      return new CareError('SEND_DISABLED', e.message, 409, { reason: e.kind });
    }
    return e;
  }

  // ── reconcile ────────────────────────────────────────────────────────────────────────────
  async reconcile(command: ReconcileCommand): Promise<DeliveryResult> {
    validateReconcileCommand(command);
    const accountId = command.accountId;
    const entry = this.ledger.get(keyOf(accountId, command.clientRequestId));

    if (entry) {
      // The caller may only confirm the delivery it actually refers to.
      const mismatch =
        (command.adapterRetryToken !== undefined && command.adapterRetryToken !== entry.token) ||
        (command.nativeMessageId !== undefined && entry.nativeMessageId !== undefined && command.nativeMessageId !== entry.nativeMessageId) ||
        (command.externalConversationKey !== undefined && command.externalConversationKey !== entry.conversationKey);
      if (mismatch) return { outcome: 'uncertain', error: 'Reconcile reference does not match the recorded delivery; not confirming it' };

      if (entry.state === 'accepted') return this.acceptedResult(entry);
      if (entry.state === 'failed_definite') return { outcome: 'failed', error: 'The request never left the process' };

      // started / uncertain / released: look for hard evidence only. A transport with its own once-only
      // ledger (the daemon) is the strongest source: it saw the ack even if this process did not.
      const remote = await this.remoteLookup(accountId, command.clientRequestId);
      if (remote?.state === 'accepted' && remote.msgId) return this.confirm(entry, remote.msgId, remote.tsMs);
      if (remote?.state === 'failed_definite') {
        entry.state = 'failed_definite';
        return { outcome: 'failed', error: 'The sending side confirms the request never left' };
      }
      if (command.nativeMessageId && entry.nativeMessageId === undefined && this.hasSeenOwn(accountId, command.nativeMessageId)) {
        return this.confirm(entry, command.nativeMessageId);
      }
      const echo = this.opts.echoTextCorrelation ? this.uniqueEchoFor(accountId, entry) : null;
      if (echo) return this.confirm(entry, echo.id, echo.tsMs);
      entry.state = 'released'; // no evidence: a human may now decide to resend
      return { outcome: 'uncertain', error: 'No evidence of delivery found; the message may or may not have been sent' };
    }

    // No ledger entry (process restarted): ask the transport's own ledger first.
    const remote = await this.remoteLookup(accountId, command.clientRequestId);
    if (remote?.state === 'accepted' && remote.msgId) {
      const restoredRemote: LedgerEntry = {
        clientRequestId: command.clientRequestId,
        token: command.adapterRetryToken ?? null,
        payloadHash: '',
        conversationKey: command.externalConversationKey ?? '',
        text: '',
        state: 'accepted',
        startedAtMs: this.nowFn(),
        nativeMessageId: remote.msgId,
        acceptedAtMs: remote.tsMs ?? this.nowFn(),
      };
      this.ledger.set(keyOf(accountId, command.clientRequestId), restoredRemote);
      return this.acceptedResult(restoredRemote);
    }
    if (remote?.state === 'failed_definite') return { outcome: 'failed', error: 'The sending side confirms the request never left' };
    // Care only supplies native ids it received from this connector.
    if (command.nativeMessageId) {
      const key = command.externalConversationKey ?? '';
      const restored: LedgerEntry = {
        clientRequestId: command.clientRequestId,
        token: command.adapterRetryToken ?? null,
        payloadHash: '',
        conversationKey: key,
        text: '',
        state: 'accepted',
        startedAtMs: this.nowFn(),
        nativeMessageId: command.nativeMessageId,
        acceptedAtMs: this.nowFn(),
      };
      this.ledger.set(keyOf(accountId, command.clientRequestId), restored);
      return this.acceptedResult(restored);
    }
    return { outcome: 'uncertain', error: 'No record of this request in this process; delivery state remains uncertain' };
  }

  private async remoteLookup(accountId: string, requestId: string): Promise<ZaloSendLookup | null> {
    if (!this.transport.lookupSend) return null;
    try {
      return await this.transport.lookupSend(accountId, requestId);
    } catch {
      return null; // unreachable: no evidence, which is never a verdict
    }
  }

  private confirm(entry: LedgerEntry, nativeMessageId: string, tsMs?: number): DeliveryResult {
    entry.state = 'accepted';
    entry.nativeMessageId = nativeMessageId;
    entry.acceptedAtMs = tsMs ?? this.nowFn();
    return this.acceptedResult(entry);
  }

  // ── echoes ───────────────────────────────────────────────────────────────────────────────
  private rememberEcho(accountId: string, echo: OwnEcho): void {
    const list = this.echoes.get(accountId) ?? [];
    if (!list.some((e) => e.id === echo.id)) list.push(echo);
    // bounded: the newest 200 within ten minutes
    const horizon = this.nowFn() - 10 * 60_000;
    this.echoes.set(accountId, list.filter((e) => e.tsMs >= horizon).slice(-200));
  }

  private hasSeenOwn(accountId: string, nativeMessageId: string): boolean {
    return (this.echoes.get(accountId) ?? []).some((e) => e.id === nativeMessageId);
  }

  private findAcceptedByNative(accountId: string, nativeMessageId: string): LedgerEntry | undefined {
    for (const [k, v] of this.ledger) {
      if (v.state === 'accepted' && v.nativeMessageId === nativeMessageId && (JSON.parse(k) as string[])[0] === accountId) return v;
    }
    return undefined;
  }

  /** Exactly one unclaimed identical-text own echo in the attempt window, and no rival open request. */
  private uniqueEchoFor(accountId: string, entry: LedgerEntry): OwnEcho | null {
    const claimed = new Set<string>();
    let rivals = 0;
    for (const [k, v] of this.ledger) {
      if ((JSON.parse(k) as string[])[0] !== accountId) continue;
      if (v.nativeMessageId) claimed.add(v.nativeMessageId);
      if (v !== entry && (v.state === 'started' || v.state === 'uncertain' || v.state === 'released') && v.conversationKey === entry.conversationKey && v.text === entry.text) {
        rivals += 1;
      }
    }
    if (rivals > 0) return null;
    const candidates = (this.echoes.get(accountId) ?? []).filter(
      (e) =>
        e.threadId === entry.conversationKey &&
        e.text.trim() === entry.text.trim() &&
        !claimed.has(e.id) &&
        e.tsMs >= entry.startedAtMs - 5_000 &&
        e.tsMs <= entry.startedAtMs + this.echoWindowMs,
    );
    return candidates.length === 1 ? candidates[0] : null;
  }

  // ── read marker / media ──────────────────────────────────────────────────────────────────
  async markRead(command: ReadCommand): Promise<ReadResult> {
    if (!command?.accountId || !command.externalConversationKey || !command.nativeMessageId) {
      throw new CareError('INVALID_COMMAND', 'accountId, externalConversationKey and nativeMessageId are required', 400);
    }
    if (!(await this.transport.features(command.accountId)).markRead) {
      throw new CareError('UNSUPPORTED_CAPABILITY', 'Remote read receipt is unsupported by the Zalo transport', 409);
    }
    let seen;
    if (this.opts.resolveMessage) {
      const kind = this.threadKinds.get(keyOf(command.accountId, command.externalConversationKey)) ?? this.opts.resolveThreadKind?.(command.accountId, command.externalConversationKey) ?? null;
      seen = kind ? seenTargetOf(this.opts.resolveMessage(command.accountId, command.externalConversationKey, command.nativeMessageId), kind) : null;
      if (!seen) return { ok: false, error: 'The message has no stored Zalo wire data (or is not an inbound message): no seen marker is sent on a guess' };
    }
    try {
      await this.transport.markRead(command.accountId, command.externalConversationKey, command.nativeMessageId, seen ?? undefined);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : 'markRead failed' };
    }
  }

  async fetchAttachment(command: MediaCommand): Promise<MediaResult> {
    const features = await this.transport.features(command.accountId);
    if (!features.fetchMedia || !command.mediaUrl) {
      throw new CareError('UNSUPPORTED_CAPABILITY', 'Zalo media can only be fetched from a message-supplied CDN URL', 409);
    }
    let url: URL;
    try {
      url = new URL(command.mediaUrl);
    } catch {
      throw new CareError('INVALID_TARGET', 'mediaUrl is not a URL', 400);
    }
    const host = url.hostname.toLowerCase();
    // The URL comes from a customer-controlled message: only https to Zalo's own CDN domains.
    if (url.protocol !== 'https:' || !MEDIA_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
      throw new CareError('INVALID_TARGET', 'Media URL is not a Zalo CDN address', 400);
    }
    const media = await this.transport.fetchMedia(command.accountId, url.toString());
    if (media.buffer.length > MEDIA_MAX_BYTES) throw new CareError('INVALID_COMMAND', 'Media is larger than the 25 MB limit', 413);
    const safe = command.attachmentId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 96) || 'attachment';
    return { buffer: media.buffer, mimeType: media.mimeType, fileName: safe };
  }

  // ── display (Care inbox) ─────────────────────────────────────────────────────────────────
  /** Care hook: names and avatars of a thread and its senders. Best effort: null when unknown, never throws. */
  async profiles(accountId: string, conversationKey: string, senderKeys: string[]): Promise<ZaloPeople | null> {
    if (!this.opts.profiles) return null;
    let res: ZaloPeople | null;
    try {
      res = await this.opts.profiles(accountId, conversationKey, senderKeys);
    } catch {
      return null;
    }
    if (!res) return null;
    const senders: Record<string, ZaloPerson> = {};
    for (const uid of senderKeys) {
      if (Object.prototype.hasOwnProperty.call(res.senders ?? {}, uid)) senders[uid] = zaloPerson(res.senders[uid]);
    }
    return { thread: zaloPerson(res.thread), senders };
  }

  /** Care hook: the stored avatar of a thread (no Zalo call); null when there is none. */
  storedAvatarUrl(accountId: string, conversationKey: string): string | null {
    try {
      return zaloImageUrl(this.opts.storedAvatarUrl?.(accountId, conversationKey)) || null;
    } catch {
      return null;
    }
  }
}
