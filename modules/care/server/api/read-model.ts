/**
 * Read model behind the GET routes (CC-07).
 *
 * Plaintext columns (channel, account, waiting, unread, status, timestamps) are filtered and
 * paged in SQL BEFORE the page is cut; encrypted text (titles, bodies, customer attributes) is
 * decrypted only for a bounded candidate set through the stores, and no plaintext index exists.
 *
 * `db` MUST be the handle the stores are bound to, so one deferred transaction (`read`) gives a
 * consistent view across SQL filters and store hydration.
 */

import type Database from 'better-sqlite3';
import type { CareConversationRecord, CareCustomerRecord, CareMessageRecord } from '../../../_lib/care-kit/types.js';
import type { CareStores } from '../persistence/index.js';
import { CONVERSATION_STATUSES } from '../persistence/conversation-store.js';
import type {
  CareAccountDto,
  CareApiChannel,
  CareConversationCounts,
  CareConversationDto,
  CareConversationListDto,
  CareCustomerDetailDto,
  CareCustomerDto,
  CareIdentityDto,
  CareMessageDto,
  CareMessagePageDto,
  CareMessagePreviewDto,
  CareSearchHitDto,
  CareSearchResultDto,
  CareStreamSnapshot,
  CareTaskDto,
} from './dto.js';
import type { CareConversationWorkflowDto, CareInboxCountsDto, CareInboxView, CareWorkflowStatus } from './dto-inbox.js';
import { invalid, notFound } from './errors.js';
import { decodeCursor, encodeCursor, foldText } from './util.js';
import { WF_COLUMNS, buildWorkflows, effectiveStatusSql, inView, viewMembership, type WfRawRow, type WorkflowEnv } from '../workflow/view.js';

/** Upper bounds. Callers may ask for less, never more. */
export const LIMITS = {
  conversationScan: 2000,
  conversationScanBatch: 200,
  searchCandidatesDefault: 500,
  searchCandidatesMax: 1000,
  customerScan: 1000,
  pageMax: 200,
  snapshotRows: 200,
} as const;

export interface ConversationFilter {
  channel?: CareApiChannel;
  accountId?: string;
  kind?: string;
  waiting?: boolean;
  unread?: boolean;
  careStatus?: string;
  stage?: string;
  customerId?: string;
  q?: string;
  /** Restricts to these accounts (the readable ones). Empty = nothing. */
  accountIds?: string[];
  /** Inbox v2: effective workflow status (SQL filter; see workflow/view.ts). */
  wf?: CareWorkflowStatus;
  /** Inbox v2: tab. Classified in JS over a capped scan (needs the AI state and draft counts). */
  view?: CareInboxView;
}

export interface SearchQuery {
  q: string;
  field: 'body' | 'metadata' | 'all';
  accountId?: string;
  conversationId?: string;
  fromMs: number | null;
  toMs: number | null;
  limit: number;
  budget: number;
  cursor?: { ms: number; id: string };
}

const UNREAD_EXPR = `(c.remote_unread_count > 0 OR (lm.id IS NOT NULL AND lm.direction = 'in' AND lm.sender_role = 'customer'
                     AND c.local_seen_message_id IS NOT c.last_message_id))`;

const CONV_FROM = `FROM care_conversations c
  JOIN care_accounts a ON a.id = c.account_id
  LEFT JOIN care_messages lm ON lm.id = c.last_message_id
  LEFT JOIN care_customers cu ON cu.id = c.primary_customer_id
  LEFT JOIN care_conversation_state cs ON cs.conversation_id = c.id`;

function stripRaw(metadata: Record<string, unknown>): Record<string, unknown> {
  // The provider's raw envelope is adapter debug data, not part of the stable API shape.
  const { rawEnvelope: _raw, ...rest } = metadata;
  return rest;
}

export function toMessageDto(m: CareMessageRecord, senderName: string | null = null): CareMessageDto {
  // A tombstone is shown as such: no text, no metadata, whatever the row still carries.
  const deleted = m.isDeleted || m.tombstone;
  return {
    id: m.id,
    conversationId: m.conversationId,
    accountId: m.accountId,
    nativeMessageId: m.nativeMessageId,
    direction: m.direction,
    senderRole: m.senderRole,
    senderIdentityId: m.senderIdentityId,
    senderName: deleted ? null : senderName,
    text: deleted ? '' : m.text,
    metadata: deleted ? {} : stripRaw(m.metadata as unknown as Record<string, unknown>),
    origin: m.origin,
    sentAtMs: m.sentAtMs,
    nativeVersion: m.nativeVersion,
    deleted,
    deletedAtMs: deleted ? m.deletedAtMs : null,
  };
}

const PREVIEW_CHARS = 160;

/** One-line, bounded preview of a (live) message; null for a missing or deleted one. */
export function toPreview(m: CareMessageRecord | null): CareMessagePreviewDto | null {
  if (!m || m.isDeleted || m.tombstone) return null;
  const meta = m.metadata as unknown as Record<string, unknown>;
  const raw = m.text.trim() || (meta.type === 'email' && typeof meta.subject === 'string' ? meta.subject : '');
  const flat = raw.replace(/\s+/g, ' ').trim();
  return {
    messageId: m.id,
    text: flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS).trimEnd()}…` : flat,
    truncated: flat.length > PREVIEW_CHARS,
    direction: m.direction,
    senderRole: m.senderRole,
    sentAtMs: m.sentAtMs,
  };
}

function toCustomerDto(c: CareCustomerRecord): CareCustomerDto {
  return {
    id: c.id,
    displayName: c.displayName,
    company: c.company,
    phone: c.phone,
    email: c.email,
    stage: c.stage,
    tags: c.tags,
    owner: c.owner,
    revision: c.revision,
    updatedAtMs: c.updatedAtMs,
  };
}

export function toTaskDto(t: {
  id: string;
  customerId: string;
  conversationId: string | null;
  title: string;
  dueAtMs: number;
  done: boolean;
  owner: string | null;
  revision: number;
  updatedAtMs: number;
}): CareTaskDto {
  return {
    id: t.id,
    customerId: t.customerId,
    conversationId: t.conversationId,
    title: t.title,
    dueAtMs: t.dueAtMs,
    done: t.done,
    owner: t.owner,
    revision: t.revision,
    updatedAtMs: t.updatedAtMs,
  };
}

interface ConvRow extends WfRawRow {
  channel: CareApiChannel;
  lm_dir: string | null;
  lm_role: string | null;
}

/** Columns of every conversation row the model hydrates: list/preview fields plus what the workflow view needs. */
const ROW_COLUMNS = `c.id AS id, c.last_message_at AS last_message_at, lm.direction AS lm_dir, lm.sender_role AS lm_role, ${WF_COLUMNS}`;

const WF_STATUSES: readonly CareWorkflowStatus[] = ['open', 'pending', 'snoozed', 'done'];
const emptyStatusCounts = (): Record<CareWorkflowStatus, number> => ({ open: 0, pending: 0, snoozed: 0, done: 0 });
const emptyViewCounts = (): Record<CareInboxView, number> => ({ me: 0, ai: 0, none: 0, all: 0 });

export class CareReadModel {
  constructor(
    readonly db: Database.Database,
    readonly stores: CareStores,
    /** Per-account read gate. A closed source contributes no rows, counts, previews or IDs (fail-closed in the caller). */
    private readonly canReadSource: (accountId: string) => boolean = () => true,
  ) {}

  /** Inbox v2: clock behind `workflow` DTOs. Late-bound. */
  private wfEnv: WorkflowEnv = { now: () => Date.now() };

  /** Idempotent. Without it rows still carry a workflow, computed with the wall clock. */
  useWorkflowEnv(env: WorkflowEnv): void {
    this.wfEnv = env;
  }

  /** Accounts whose read gate is open. */
  readableAccountIds(): string[] {
    return (this.db.prepare('SELECT id FROM care_accounts ORDER BY created_at ASC, id ASC').all() as Array<{ id: string }>)
      .map((r) => r.id)
      .filter((id) => this.canReadSource(id));
  }

  /** Exists AND is readable: a closed source reads exactly like a missing one. */
  accountReadable(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM care_accounts WHERE id = ?').get(id)) && this.canReadSource(id);
  }

  /** One deferred read transaction: every statement inside sees the same committed snapshot. */
  read<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ── event journal bookkeeping ───────────────────────────────────────────────────────────────
  /** Highest `care_events.seq` ever issued (survives pruning, via AUTOINCREMENT's sequence row). */
  latestEventSeq(): number {
    const seqRow = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'care_events'").get() as { seq: number } | undefined;
    const maxRow = this.db.prepare('SELECT MAX(seq) AS m FROM care_events').get() as { m: number | null };
    return Math.max(Number(seqRow?.seq ?? 0), Number(maxRow.m ?? 0));
  }

  oldestEventSeq(): number | null {
    const row = this.db.prepare('SELECT MIN(seq) AS m FROM care_events').get() as { m: number | null };
    return row.m === null || row.m === undefined ? null : Number(row.m);
  }

  conversationRevision(id: string | null): number | null {
    if (!id) return null;
    const row = this.db.prepare('SELECT revision FROM care_conversations WHERE id = ?').get(id) as { revision: number } | undefined;
    return row ? Number(row.revision) : null;
  }

  // ── accounts ────────────────────────────────────────────────────────────────────────────────
  listAccounts(): CareAccountDto[] {
    return this.stores.accounts.listAccounts().filter((a) => this.canReadSource(a.id)).map((a) => ({
      id: a.id,
      channel: a.channel,
      connectorKind: a.connectorKind,
      nativeAccountId: a.nativeAccountId,
      label: a.label,
      desiredState: a.desiredState,
      healthStatus: a.healthStatus,
      syncEnabled: a.syncEnabled,
      sendEnabled: a.sendEnabled,
      aiEnabled: a.aiEnabled,
      writeOwner: a.writeOwner,
      ownerEpoch: a.ownerEpoch,
      updatedAtMs: a.updatedAtMs,
      signature: null, // filled by the route from the one signature source (see signature.ts)
    }));
  }

  accountExists(id: string): boolean {
    return this.accountReadable(id);
  }

  // ── conversations ───────────────────────────────────────────────────────────────────────────
  private convWhere(f: ConversationFilter): { sql: string; params: unknown[] } {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (f.channel) {
      conds.push('a.channel = ?');
      params.push(f.channel);
    }
    if (f.accountId) {
      conds.push('c.account_id = ?');
      params.push(f.accountId);
    }
    // Always scoped to the readable accounts: a closed source has no rows, counts or cursors.
    const scope = f.accountIds ?? this.readableAccountIds();
    conds.push(scope.length ? `c.account_id IN (${scope.map(() => '?').join(',')})` : '0 = 1');
    params.push(...scope);
    if (f.kind) {
      conds.push('c.kind = ?');
      params.push(f.kind);
    }
    if (f.careStatus) {
      conds.push('c.status = ?');
      params.push(f.careStatus);
    }
    if (f.wf) {
      conds.push(`${effectiveStatusSql(this.wfEnv.now())} = ?`);
      params.push(f.wf);
    }
    if (f.stage) {
      conds.push('cu.stage = ?');
      params.push(f.stage);
    }
    if (f.customerId) {
      conds.push('c.primary_customer_id = ?');
      params.push(f.customerId);
    }
    if (f.waiting === true) conds.push('c.waiting_since IS NOT NULL');
    if (f.waiting === false) conds.push('c.waiting_since IS NULL');
    if (f.unread === true) conds.push(UNREAD_EXPR);
    if (f.unread === false) conds.push(`NOT ${UNREAD_EXPR}`);
    return { sql: conds.length ? conds.join(' AND ') : '1 = 1', params };
  }

  /** Lifecycle labels the projector writes (`CareConversationStore.setStatus`), plus any other value in use. */
  conversationStatuses(): string[] {
    const inUse = (this.db.prepare('SELECT DISTINCT status FROM care_conversations').all() as Array<{ status: string }>).map((r) => r.status);
    return [...new Set([...CONVERSATION_STATUSES, ...inUse])];
  }

  conversationCounts(f: ConversationFilter): CareConversationCounts {
    const { sql, params } = this.convWhere(f);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN c.waiting_since IS NOT NULL THEN 1 ELSE 0 END), 0) AS waiting,
                COALESCE(SUM(CASE WHEN ${UNREAD_EXPR} THEN 1 ELSE 0 END), 0) AS unread
         ${CONV_FROM} WHERE ${sql}`,
      )
      .get(...params) as { total: number; waiting: number; unread: number };
    return { total: Number(row.total), waiting: Number(row.waiting), unread: Number(row.unread) };
  }

  private convRows(f: ConversationFilter, cursor: { ms: number; id: string } | undefined, limit: number): ConvRow[] {
    const { sql, params } = this.convWhere(f);
    const all = [...params];
    let where = sql;
    if (cursor) {
      where += ' AND (c.last_message_at < ? OR (c.last_message_at = ? AND c.id < ?))';
      all.push(cursor.ms, cursor.ms, cursor.id);
    }
    return this.db
      .prepare(
        `SELECT ${ROW_COLUMNS}
         ${CONV_FROM} WHERE ${where}
         ORDER BY c.last_message_at DESC, c.id DESC LIMIT ?`,
      )
      .all(...all, limit) as ConvRow[];
  }

  private toConversationDto(
    rec: CareConversationRecord,
    channel: CareApiChannel,
    lmDir: string | null,
    lmRole: string | null,
    workflow?: CareConversationWorkflowDto,
  ): CareConversationDto {
    return {
      id: rec.id,
      accountId: rec.accountId,
      channel,
      kind: rec.kind,
      title: rec.title,
      status: rec.status,
      primaryCustomerId: rec.primaryCustomerId,
      isPaused: rec.isPaused,
      pausedUntilMs: rec.pausedUntilMs,
      isOptedOut: rec.isOptedOut,
      waitingSinceMs: rec.waitingSinceMs,
      remoteUnreadCount: rec.remoteUnreadCount,
      localSeenMessageId: rec.localSeenMessageId,
      localUnread: lmDir === 'in' && lmRole === 'customer' && rec.localSeenMessageId !== rec.lastMessageId,
      lastMessageId: rec.lastMessageId,
      // Decrypted for the rows of THIS page only, one message each; a closed source has no row here at all.
      lastMessagePreview: rec.lastMessageId && this.canReadSource(rec.accountId) ? toPreview(this.stores.messages.getMessage(rec.lastMessageId)) : null,
      lastActivityMs: rec.lastMessageAtMs,
      revision: rec.revision,
      ...(workflow ? { workflow } : {}),
    };
  }

  /** Hydrates a page of rows with ONE batched workflow computation. */
  private hydrateRows(rows: readonly ConvRow[]): CareConversationDto[] {
    const wfs = buildWorkflows(this.db, this.wfEnv, rows);
    const out: CareConversationDto[] = [];
    for (const row of rows) {
      const rec = this.stores.conversations.getConversation(row.id);
      if (rec) out.push(this.toConversationDto(rec, row.channel, row.lm_dir, row.lm_role, wfs.get(row.id)));
    }
    return out;
  }

  getConversationDto(id: string): CareConversationDto | null {
    const row = this.db
      .prepare(
        `SELECT ${ROW_COLUMNS}
         ${CONV_FROM} WHERE c.id = ?`,
      )
      .get(id) as ConvRow | undefined;
    if (!row) return null;
    const rec = this.stores.conversations.getConversation(id);
    if (rec && !this.canReadSource(rec.accountId)) return null;
    return rec ? this.hydrateRows([row])[0] ?? null : null;
  }

  /** Whether `q` (folded) occurs in the conversation's decrypted metadata or its customer's attributes. */
  private matchesConversation(rec: CareConversationRecord, needle: string, customerCache: Map<string, CareCustomerRecord | null>): boolean {
    if (foldText(rec.title).includes(needle) || foldText(rec.externalKey).includes(needle)) return true;
    if (rec.primaryCustomerId) {
      let cust = customerCache.get(rec.primaryCustomerId);
      if (cust === undefined) {
        cust = this.stores.customers.getCustomer(rec.primaryCustomerId);
        customerCache.set(rec.primaryCustomerId, cust);
      }
      if (cust) {
        const hay = [cust.displayName, cust.company, cust.phone, cust.email, cust.tags].filter(Boolean).join('\n');
        if (foldText(hay).includes(needle)) return true;
      }
    }
    return false;
  }

  listConversations(f: ConversationFilter, cursorRaw: string | undefined, limit: number): CareConversationListDto {
    const cursor = decodeCursor(cursorRaw);
    const cap = Math.min(Math.max(limit, 1), LIMITS.pageMax);
    const view = f.view && f.view !== 'all' ? f.view : undefined;

    return this.read(() => {
      if (f.q) return this.listByText(f, view, cursor, cap);
      if (view) return this.listByScan(f, view, cursor, cap);

      // Plain SQL page (status/view=all). Only the page is hydrated; the tab counters come from a capped scan.
      const rows = this.convRows(f, cursor, cap + 1);
      const page = rows.slice(0, cap);
      const last = page[page.length - 1];
      const counts = this.conversationCounts(f);
      return {
        items: this.hydrateRows(page),
        nextCursor: rows.length > cap && last ? encodeCursor(Number(last.last_message_at), last.id) : null,
        counts,
        truncated: false,
        inboxCounts: this.sqlPathInboxCounts(f, counts.total),
      };
    });
  }

  /** Text filter: scans the newest rows (decrypting titles/customers for a bounded set), then filters by tab in JS. */
  private listByText(f: ConversationFilter, view: Exclude<CareInboxView, 'all'> | undefined, cursor: { ms: number; id: string } | undefined, cap: number): CareConversationListDto {
    const needle = foldText(f.q!);
    const matched: ConvRow[] = [];
    const customerCache = new Map<string, CareCustomerRecord | null>();
    let scanned = 0;
    let cur = cursor;
    let lastRow: ConvRow | undefined;
    let exhausted = false;
    let full = false;
    while (!full && scanned < LIMITS.conversationScan) {
      const batchSize = Math.min(LIMITS.conversationScanBatch, LIMITS.conversationScan - scanned);
      const rows = this.convRows({ ...f, q: undefined }, cur, batchSize);
      if (rows.length === 0) {
        exhausted = true;
        break;
      }
      const batchWf = view ? buildWorkflows(this.db, this.wfEnv, rows) : null;
      for (const row of rows) {
        scanned += 1;
        lastRow = row;
        if (batchWf && !inView(batchWf.get(row.id)!, view)) continue;
        const rec = this.stores.conversations.getConversation(row.id);
        if (rec && this.matchesConversation(rec, needle, customerCache)) {
          matched.push(row);
          if (matched.length >= cap) {
            full = true;
            break;
          }
        }
      }
      cur = lastRow ? { ms: Number(lastRow.last_message_at), id: lastRow.id } : cur;
      if (rows.length < batchSize) exhausted = true;
      if (exhausted) break;
    }
    // More rows may follow whenever we stopped early (page full or budget hit) and rows remain after `lastRow`.
    const moreAfter = lastRow ? this.convRows({ ...f, q: undefined }, { ms: Number(lastRow.last_message_at), id: lastRow.id }, 1).length > 0 : false;
    return {
      items: this.hydrateRows(matched),
      nextCursor: moreAfter && lastRow ? encodeCursor(Number(lastRow.last_message_at), lastRow.id) : null,
      counts: null,
      truncated: !full && moreAfter && scanned >= LIMITS.conversationScan,
      inboxCounts: null,
    };
  }

  /**
   * Tab (`view`) listing: the tab needs the AI state and draft counts, so classification is JS over the newest
   * `LIMITS.conversationScan` rows of the filter (status filter NOT applied in SQL, so one scan feeds the items AND
   * both counter sets). Paging is in memory over that window with the usual cursor; `truncated` says older rows exist.
   */
  private listByScan(f: ConversationFilter, view: Exclude<CareInboxView, 'all'>, cursor: { ms: number; id: string } | undefined, cap: number): CareConversationListDto {
    const scan = this.scanRows({ ...f, wf: undefined });
    const wfs = buildWorkflows(this.db, this.wfEnv, scan.rows);
    const byStatus = emptyStatusCounts();
    const byView = emptyViewCounts();
    const candidates: ConvRow[] = [];
    const counts = { total: 0, waiting: 0, unread: 0 };
    for (const row of scan.rows) {
      const wf = wfs.get(row.id)!;
      const member = viewMembership(wf);
      if (member[view]) byStatus[wf.status] += 1;
      if (f.wf && wf.status !== f.wf) continue;
      byView.all += 1;
      for (const v of ['me', 'ai', 'none'] as const) if (member[v]) byView[v] += 1;
      if (!member[view]) continue;
      candidates.push(row);
      counts.total += 1;
      if (row.waiting_since !== null) counts.waiting += 1;
      if (row.unread === 1) counts.unread += 1;
    }
    const after = cursor
      ? candidates.filter((r) => Number(r.last_message_at) < cursor.ms || (Number(r.last_message_at) === cursor.ms && r.id < cursor.id))
      : candidates;
    const page = after.slice(0, cap);
    const last = page[page.length - 1];
    return {
      items: this.hydrateRows(page),
      nextCursor: after.length > cap && last ? encodeCursor(Number(last.last_message_at), last.id) : null,
      counts,
      truncated: scan.truncated,
      inboxCounts: { byStatus, byView },
    };
  }

  /** Newest rows of the filter with the per-row workflow columns plus `unread`, capped at the scan budget. */
  private scanRows(f: ConversationFilter): { rows: Array<ConvRow & { unread: number }>; truncated: boolean } {
    const { sql, params } = this.convWhere(f);
    const rows = this.db
      .prepare(
        `SELECT ${ROW_COLUMNS}, CASE WHEN ${UNREAD_EXPR} THEN 1 ELSE 0 END AS unread
         ${CONV_FROM} WHERE ${sql}
         ORDER BY c.last_message_at DESC, c.id DESC LIMIT ?`,
      )
      .all(...params, LIMITS.conversationScan + 1) as Array<ConvRow & { unread: number }>;
    return { rows: rows.slice(0, LIMITS.conversationScan), truncated: rows.length > LIMITS.conversationScan };
  }

  /** `byStatus` counts exactly in SQL (view = all); `byView` classifies the capped scan of the CURRENT status filter. */
  private sqlPathInboxCounts(f: ConversationFilter, total: number): CareInboxCountsDto {
    const { sql, params } = this.convWhere({ ...f, wf: undefined });
    const byStatus = emptyStatusCounts();
    const grouped = this.db
      .prepare(`SELECT ${effectiveStatusSql(this.wfEnv.now())} AS st, COUNT(*) AS n ${CONV_FROM} WHERE ${sql} GROUP BY st`)
      .all(...params) as Array<{ st: CareWorkflowStatus; n: number }>;
    for (const g of grouped) if (WF_STATUSES.includes(g.st)) byStatus[g.st] = Number(g.n);

    const byView = emptyViewCounts();
    byView.all = total;
    const scan = this.scanRows(f);
    const wfs = buildWorkflows(this.db, this.wfEnv, scan.rows);
    for (const row of scan.rows) {
      const member = viewMembership(wfs.get(row.id)!);
      for (const v of ['me', 'ai', 'none'] as const) if (member[v]) byView[v] += 1;
    }
    return { byStatus, byView };
  }

  /** Effective-`open` conversations whose customer waited at least `minWaitMs` (oldest wait first). */
  waitingConversations(opts: { minWaitMs: number; now: number; limit: number }): Array<{ conversation: CareConversationDto; waitingSinceMs: number }> {
    const cutoff = Math.trunc(opts.now - Math.max(opts.minWaitMs, 0));
    const limit = Math.min(Math.max(Math.trunc(opts.limit) || 1, 1), LIMITS.pageMax);
    return this.read(() => {
      const { sql, params } = this.convWhere({ wf: 'open' });
      const rows = this.db
        .prepare(
          `SELECT ${ROW_COLUMNS} ${CONV_FROM}
           WHERE ${sql} AND c.waiting_since <= ?
           ORDER BY c.waiting_since ASC, c.id ASC LIMIT ?`,
        )
        .all(...params, cutoff, limit) as ConvRow[];
      return this.hydrateRows(rows).map((conversation) => ({ conversation, waitingSinceMs: conversation.waitingSinceMs as number }));
    });
  }

  /** Tab counters over every readable conversation (no channel/account/status filter): the capped scan, like the list. */
  allInboxCounts(): CareInboxCountsDto {
    return this.read(() => {
      const total = this.conversationCounts({}).total;
      return this.sqlPathInboxCounts({}, total);
    });
  }

  // ── messages ────────────────────────────────────────────────────────────────────────────────
  /** Newer rows INCLUDING tombstones: a deleted message keeps its place in the timeline. */
  private newerMessageIds(conversationId: string, from: { ms: number; id: string }, limit: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM care_messages
         WHERE conversation_id = ? AND (sent_at > ? OR (sent_at = ? AND id > ?))
         ORDER BY sent_at ASC, id ASC LIMIT ?`,
      )
      .all(conversationId, from.ms, from.ms, from.id, limit) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  private olderMessageIds(conversationId: string, before: { ms: number; id: string } | undefined, limit: number): string[] {
    const rows = (
      before
        ? this.db
            .prepare(
              `SELECT id FROM care_messages WHERE conversation_id = ? AND (sent_at < ? OR (sent_at = ? AND id < ?))
               ORDER BY sent_at DESC, id DESC LIMIT ?`,
            )
            .all(conversationId, before.ms, before.ms, before.id, limit)
        : this.db.prepare(`SELECT id FROM care_messages WHERE conversation_id = ? ORDER BY sent_at DESC, id DESC LIMIT ?`).all(conversationId, limit)
    ) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  private hydrateMessages(ids: string[]): CareMessageRecord[] {
    const out: CareMessageRecord[] = [];
    for (const id of ids) {
      const m = this.stores.messages.getMessage(id);
      if (m) out.push(m);
    }
    return out;
  }

  messagePage(
    conversationId: string,
    opts: { limit: number; before?: string; after?: string; around?: string },
  ): CareMessagePageDto {
    const limit = Math.min(Math.max(opts.limit, 1), LIMITS.pageMax);
    const given = [opts.before, opts.after, opts.around].filter((x) => x !== undefined && x !== '').length;
    if (given > 1) throw invalid("Use only one of 'before', 'after' or 'around'.");
    const cursorOf = (m: CareMessageRecord): string => encodeCursor(m.sentAtMs, m.id);
    // Display names only in groups / topics; looked up once per distinct sender of the page.
    const kind = this.stores.conversations.getConversation(conversationId)?.kind;
    const names = new Map<string, string | null>();
    const dto = (m: CareMessageRecord): CareMessageDto => {
      let name: string | null = null;
      if ((kind === 'group' || kind === 'topic') && m.senderIdentityId && m.senderRole === 'customer') {
        if (!names.has(m.senderIdentityId)) {
          const identity = this.stores.identities.getIdentity(m.senderIdentityId);
          // Ingest names an unknown sender after its native ID; that is an ID, not a name, so it is not shown.
          const display = identity?.displayName?.trim() || null;
          names.set(m.senderIdentityId, display && display.toLowerCase() !== identity?.externalIdentityId.trim().toLowerCase() ? display : null);
        }
        name = names.get(m.senderIdentityId) ?? null;
      }
      return toMessageDto(m, name);
    };

    return this.read(() => {
      if (opts.around) {
        const target = this.stores.messages.getMessage(opts.around);
        // A message of another conversation reads exactly like a missing one.
        if (!target || target.conversationId !== conversationId) throw notFound();
        const half = Math.max(Math.floor(limit / 2), 1);
        const older = this.hydrateMessages(this.olderMessageIds(conversationId, { ms: target.sentAtMs, id: target.id }, half + 1));
        const newerAsc = this.hydrateMessages(this.newerMessageIds(conversationId, { ms: target.sentAtMs, id: target.id }, half + 1));
        const olderKept = older.slice(0, half);
        const newerKept = newerAsc.slice(0, half).reverse();
        const items = [...newerKept, target, ...olderKept];
        return {
          items: items.map(dto),
          olderCursor: older.length > half ? cursorOf(olderKept[olderKept.length - 1]) : null,
          newerCursor: newerAsc.length > half ? cursorOf(newerKept[0]) : null,
          aroundId: target.id,
        };
      }

      if (opts.after) {
        const c = decodeCursor(opts.after)!;
        const asc = this.hydrateMessages(this.newerMessageIds(conversationId, c, limit + 1));
        const kept = asc.slice(0, limit).reverse();
        return {
          items: kept.map(dto),
          olderCursor: kept.length ? cursorOf(kept[kept.length - 1]) : null,
          newerCursor: asc.length > limit && kept.length ? cursorOf(kept[0]) : null,
          aroundId: null,
        };
      }

      const c = opts.before ? decodeCursor(opts.before) : undefined;
      const rows = this.hydrateMessages(this.olderMessageIds(conversationId, c ? { ms: c.ms, id: c.id } : undefined, limit + 1));
      const kept = rows.slice(0, limit);
      return {
        items: kept.map(dto),
        olderCursor: rows.length > limit && kept.length ? cursorOf(kept[kept.length - 1]) : null,
        // Paging backwards from a cursor means newer messages exist; the first page is the newest.
        newerCursor: c && kept.length ? cursorOf(kept[0]) : null,
        aroundId: null,
      };
    });
  }

  /** Throws 404 unless the message belongs to the conversation; used by deep links and read markers. */
  messageInConversation(conversationId: string, messageId: string): CareMessageRecord {
    const m = this.stores.messages.getMessage(messageId);
    if (!m || m.conversationId !== conversationId || !this.canReadSource(m.accountId)) throw notFound();
    return m;
  }

  // ── search ──────────────────────────────────────────────────────────────────────────────────
  private metadataHaystack(m: CareMessageRecord): string {
    const meta = m.metadata as unknown as Record<string, unknown>;
    const parts: string[] = [];
    const push = (v: unknown): void => {
      if (typeof v === 'string') parts.push(v);
      else if (Array.isArray(v)) v.forEach(push);
    };
    if (meta.type === 'email') {
      for (const k of ['subject', 'from', 'fromName', 'to', 'cc', 'replyTo', 'category']) push(meta[k]);
    }
    const atts = meta.attachments;
    if (Array.isArray(atts)) for (const a of atts) if (a && typeof a === 'object') push((a as Record<string, unknown>).fileName);
    return parts.join('\n');
  }

  private snippet(text: string, needle: string): string {
    const folded = foldText(text);
    const at = folded.indexOf(needle);
    // Folding can change string length (rare combining sequences); clamp so slicing stays in range.
    const idx = at < 0 ? 0 : Math.min(at, Math.max(text.length - 1, 0));
    const start = Math.max(idx - 60, 0);
    const end = Math.min(idx + needle.length + 60, text.length);
    return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
  }

  search(q: SearchQuery): CareSearchResultDto {
    const needle = foldText(q.q);
    return this.read(() => {
      if (q.accountId && !this.accountExists(q.accountId)) throw notFound();
      if (q.conversationId) {
        const conv = this.stores.conversations.getConversation(q.conversationId);
        if (!conv || !this.canReadSource(conv.accountId) || (q.accountId && conv.accountId !== q.accountId)) throw notFound();
      }

      const conds = ['m.is_deleted = 0'];
      const params: unknown[] = [];
      const readable = this.readableAccountIds();
      conds.push(readable.length ? `m.account_id IN (${readable.map(() => '?').join(',')})` : '0 = 1');
      params.push(...readable);
      if (q.accountId) {
        conds.push('m.account_id = ?');
        params.push(q.accountId);
      }
      if (q.conversationId) {
        conds.push('m.conversation_id = ?');
        params.push(q.conversationId);
      }
      if (q.fromMs !== null) {
        conds.push('m.sent_at >= ?');
        params.push(q.fromMs);
      }
      if (q.toMs !== null) {
        conds.push('m.sent_at <= ?');
        params.push(q.toMs);
      }
      if (q.cursor) {
        conds.push('(m.sent_at < ? OR (m.sent_at = ? AND m.id < ?))');
        params.push(q.cursor.ms, q.cursor.ms, q.cursor.id);
      }
      const rows = this.db
        .prepare(`SELECT m.id AS id, m.sent_at AS sent_at FROM care_messages m WHERE ${conds.join(' AND ')} ORDER BY m.sent_at DESC, m.id DESC LIMIT ?`)
        .all(...params, q.budget + 1) as Array<{ id: string; sent_at: number }>;

      const hits: CareSearchHitDto[] = [];
      const scanLimit = Math.min(rows.length, q.budget);
      let scanned = 0;
      let lastScanned: { id: string; sent_at: number } | undefined;
      for (; scanned < scanLimit; ) {
        const row = rows[scanned];
        scanned += 1;
        lastScanned = row;
        let msg: CareMessageRecord | null = null;
        try {
          msg = this.stores.messages.getMessage(row.id);
        } catch {
          msg = null; // an undecryptable row is skipped, never surfaced
        }
        if (!msg || msg.isDeleted) continue;
        let matchedIn: 'body' | 'metadata' | null = null;
        let hay = '';
        if (q.field !== 'metadata' && foldText(msg.text).includes(needle)) {
          matchedIn = 'body';
          hay = msg.text;
        } else if (q.field !== 'body') {
          const meta = this.metadataHaystack(msg);
          if (meta && foldText(meta).includes(needle)) {
            matchedIn = 'metadata';
            hay = meta;
          }
        }
        if (matchedIn) {
          hits.push({
            messageId: msg.id,
            conversationId: msg.conversationId,
            accountId: msg.accountId,
            sentAtMs: msg.sentAtMs,
            matchedIn,
            snippet: this.snippet(hay, needle),
            around: msg.id,
          });
          if (hits.length >= q.limit) break;
        }
      }

      const stoppedByLimit = hits.length >= q.limit;
      const unscanned = rows.length > scanned;
      let nextCursor: string | null = null;
      let truncated = false;
      if (unscanned && lastScanned) {
        nextCursor = encodeCursor(Number(lastScanned.sent_at), lastScanned.id);
        truncated = !stoppedByLimit;
      }
      return {
        items: hits,
        scope: {
          query: q.q,
          field: q.field,
          accountId: q.accountId ?? null,
          conversationId: q.conversationId ?? null,
          fromMs: q.fromMs,
          toMs: q.toMs,
          candidateBudget: q.budget,
          scannedCandidates: scanned,
        },
        truncated,
        nextCursor,
      };
    });
  }

  // ── customers ───────────────────────────────────────────────────────────────────────────────
  listCustomers(f: { stage?: string; q?: string }, cursorRaw: string | undefined, limit: number): { items: CareCustomerDto[]; nextCursor: string | null; truncated: boolean } {
    const cursor = decodeCursor(cursorRaw);
    const cap = Math.min(Math.max(limit, 1), LIMITS.pageMax);
    const rowsFor = (cur: { ms: number; id: string } | undefined, n: number): Array<{ id: string; updated_at: number }> => {
      const conds = ['1 = 1'];
      const params: unknown[] = [];
      if (f.stage) {
        conds.push('stage = ?');
        params.push(f.stage);
      }
      if (cur) {
        conds.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
        params.push(cur.ms, cur.ms, cur.id);
      }
      return this.db
        .prepare(`SELECT id, updated_at FROM care_customers WHERE ${conds.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`)
        .all(...params, n) as Array<{ id: string; updated_at: number }>;
    };

    return this.read(() => {
      if (!f.q) {
        const rows = rowsFor(cursor, cap + 1);
        const page = rows.slice(0, cap);
        const items = page
          .map((r) => this.stores.customers.getCustomer(r.id))
          .filter((c): c is CareCustomerRecord => c !== null)
          .map(toCustomerDto);
        const last = page[page.length - 1];
        return { items, nextCursor: rows.length > cap && last ? encodeCursor(Number(last.updated_at), last.id) : null, truncated: false };
      }

      const needle = foldText(f.q);
      const items: CareCustomerDto[] = [];
      let scanned = 0;
      let cur = cursor;
      let last: { id: string; updated_at: number } | undefined;
      let full = false;
      while (!full && scanned < LIMITS.customerScan) {
        const batch = Math.min(LIMITS.conversationScanBatch, LIMITS.customerScan - scanned);
        const rows = rowsFor(cur, batch);
        if (rows.length === 0) break;
        for (const row of rows) {
          scanned += 1;
          last = row;
          const c = this.stores.customers.getCustomer(row.id);
          if (!c) continue;
          const hay = [c.displayName, c.company, c.phone, c.email, c.tags, c.owner].filter(Boolean).join('\n');
          if (foldText(hay).includes(needle)) {
            items.push(toCustomerDto(c));
            if (items.length >= cap) {
              full = true;
              break;
            }
          }
        }
        cur = last ? { ms: Number(last.updated_at), id: last.id } : cur;
        if (rows.length < batch) break;
      }
      const more = last ? rowsFor({ ms: Number(last.updated_at), id: last.id }, 1).length > 0 : false;
      return {
        items,
        nextCursor: more && last ? encodeCursor(Number(last.updated_at), last.id) : null,
        truncated: !full && more && scanned >= LIMITS.customerScan,
      };
    });
  }

  getCustomerDetail(id: string): CareCustomerDetailDto | null {
    return this.read(() => {
      const c = this.stores.customers.getCustomer(id);
      if (!c) return null;
      const identities: CareIdentityDto[] = this.stores.identities.listIdentitiesByCustomer(id).map((i) => ({
        id: i.id,
        accountId: i.accountId,
        namespace: i.namespace,
        displayName: i.displayName,
        username: i.username,
        verified: i.verified,
      }));
      const convRows = this.convRows({ customerId: id }, undefined, 100);
      const conversations = convRows
        .map((r) => {
          const rec = this.stores.conversations.getConversation(r.id);
          return rec ? this.toConversationDto(rec, r.channel, r.lm_dir, r.lm_role) : null;
        })
        .filter((x): x is CareConversationDto => x !== null);
      const tasks = this.stores.tasks.listTasksByCustomer(id).map(toTaskDto);
      return { ...toCustomerDto(c), identities, conversations, tasks };
    });
  }

  // ── stream snapshot ─────────────────────────────────────────────────────────────────────────
  /**
   * Rows + `eventSeq` in ONE read transaction: the caller replays from `eventSeq` and cannot miss
   * or double-apply an invalidation. IDs and versions only.
   */
  streamSnapshot(): CareStreamSnapshot {
    return this.read(() => {
      const eventSeq = this.latestEventSeq();
      const counts = this.conversationCounts({});
      const readable = new Set(this.readableAccountIds());
      const accounts = (
        this.db
          .prepare('SELECT id, channel, health_status, updated_at FROM care_accounts ORDER BY created_at ASC, id ASC')
          .all() as Array<{ id: string; channel: CareApiChannel; health_status: string; updated_at: number }>
      ).filter((a) => readable.has(a.id));
      const ids = [...readable];
      const convs = this.db
        .prepare(
          `SELECT id, account_id, revision, last_message_at, waiting_since, remote_unread_count
           FROM care_conversations WHERE ${ids.length ? `account_id IN (${ids.map(() => '?').join(',')})` : '0 = 1'}
           ORDER BY last_message_at DESC, id DESC LIMIT ?`,
        )
        .all(...ids, LIMITS.snapshotRows) as Array<{
        id: string;
        account_id: string;
        revision: number;
        last_message_at: number;
        waiting_since: number | null;
        remote_unread_count: number;
      }>;
      return {
        eventSeq,
        counts,
        accounts: accounts.map((a) => ({ id: a.id, channel: a.channel, healthStatus: a.health_status, updatedAtMs: Number(a.updated_at) })),
        conversations: convs.map((r) => ({
          id: r.id,
          accountId: r.account_id,
          revision: Number(r.revision),
          lastActivityMs: Number(r.last_message_at),
          waiting: r.waiting_since !== null && r.waiting_since !== undefined,
          remoteUnreadCount: Number(r.remote_unread_count),
        })),
      };
    });
  }

  accountCounts(): { total: number; byChannel: Partial<Record<CareApiChannel, number>> } {
    const byChannel: Partial<Record<CareApiChannel, number>> = {};
    let total = 0;
    for (const a of this.stores.accounts.listAccounts()) {
      if (!this.canReadSource(a.id)) continue;
      byChannel[a.channel] = (byChannel[a.channel] ?? 0) + 1;
      total += 1;
    }
    return { total, byChannel };
  }
}
