/**
 * Retention, redaction and pruning for Care (CC-21).
 *
 * Two kinds of work with a hard order between them (guide section 3):
 *  1. REDACTION (`redactErasedContent`) comes first and outranks every retention pin. A message that is
 *     deleted or past its TTL has its body gone from the canonical row, from every source-journal payload
 *     that describes it and from every event replay payload, even when a migration/replayer pin or an
 *     unapplied bridge still "needs" them. What stays is the minimal tombstone: the native key, the
 *     sequence numbers and the scrubbed event metadata, so a consumer can still resume.
 *  2. PRUNING (`pruneCareData`) removes whole old rows. It honours pins and the bridge's applied position,
 *     and it always deletes from the OLDEST sequence upward and stops at the first row it may not delete,
 *     so the retained range never has a hole in the middle. The SSE stream detects pruning by a hole at the
 *     START of the retained range (`oldest > cursor + 1`), which this order keeps valid.
 *
 * Everything is a plain SQL pass over an injected handle and an injected clock: no store state, no key
 * material (redaction blanks ciphertext, it never needs to decrypt), no network. Run it from a single
 * scheduler (`runRetentionLoop`) per installation; every pass is idempotent and batched.
 */
import type Database from 'better-sqlite3';
import type { RuntimeClock } from '../runtime/clock.js';
import { decryptCareJson, encryptCareJson, type CareKeyInput } from '../persistence/crypto.js';
import { columnExists, metaGet, metaSet, scalar, tableExists } from './db-util.js';
import { scrubCareLog } from './log-scrub.js';

const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;
const NEVER = Number.MAX_SAFE_INTEGER;

export interface CareRetentionPolicy {
  /** care_events rows (the SSE journal). */
  eventsMs: number;
  /** Event replay payloads (encrypted detail attached to an event). */
  replayPayloadMs: number;
  /** Applied source-journal rows (bridge/migration replay log). */
  sourceJournalMs: number;
  /** Completed/failed jobs. */
  jobsMs: number;
  /** Finished agent runs. */
  agentRunsMs: number;
  /** Terminal delivery intents and their attempts. */
  attemptsMs: number;
  /** Released/discarded backlog holds. */
  resolvedHoldsMs: number;
  /** Message bodies older than this are purged everywhere; null = keep until deleted. */
  messageTtlMs: number | null;
}

/** Conservative: nothing about customer content expires unless an operator sets `messageTtlMs`. */
export const DEFAULT_RETENTION_POLICY: CareRetentionPolicy = {
  eventsMs: 30 * DAY,
  replayPayloadMs: 14 * DAY,
  sourceJournalMs: 30 * DAY,
  jobsMs: 14 * DAY,
  agentRunsMs: 90 * DAY,
  attemptsMs: 180 * DAY,
  resolvedHoldsMs: 90 * DAY,
  messageTtlMs: null,
};

/** A window shorter than this is refused: it would eat data an in-flight consumer still needs. */
const MIN_WINDOW_MS = HOUR;
const POLICY_META_KEY = 'retention_policy';

/** Merges a partial policy over the defaults; non-finite or too-small windows fall back to the default. */
export function normalizeRetentionPolicy(input: Partial<CareRetentionPolicy> | null | undefined = {}): CareRetentionPolicy {
  const out: CareRetentionPolicy = { ...DEFAULT_RETENTION_POLICY };
  const src = (input ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_RETENTION_POLICY) as Array<keyof CareRetentionPolicy>) {
    const v = src[key];
    if (key === 'messageTtlMs') {
      out.messageTtlMs = typeof v === 'number' && Number.isFinite(v) && v >= MIN_WINDOW_MS ? Math.floor(v) : null;
    } else if (typeof v === 'number' && Number.isFinite(v) && v >= MIN_WINDOW_MS) {
      out[key] = Math.floor(v);
    }
  }
  return out;
}

/** The stricter (shorter) window per field. A message TTL of null means "none", so any number is stricter. */
export function strictestPolicy(a: CareRetentionPolicy, b: CareRetentionPolicy): CareRetentionPolicy {
  const out = { ...a };
  for (const key of Object.keys(DEFAULT_RETENTION_POLICY) as Array<keyof CareRetentionPolicy>) {
    if (key === 'messageTtlMs') {
      out.messageTtlMs = a.messageTtlMs === null ? b.messageTtlMs : b.messageTtlMs === null ? a.messageTtlMs : Math.min(a.messageTtlMs, b.messageTtlMs);
    } else {
      out[key] = Math.min(a[key], b[key]);
    }
  }
  return out;
}

/** The persisted policy (a care_schema_meta row; no schema change). Unreadable or absent = defaults. */
export function readRetentionPolicy(db: Database.Database): CareRetentionPolicy {
  const raw = metaGet(db, POLICY_META_KEY);
  if (!raw) return { ...DEFAULT_RETENTION_POLICY };
  try {
    return normalizeRetentionPolicy(JSON.parse(raw) as Partial<CareRetentionPolicy>);
  } catch {
    return { ...DEFAULT_RETENTION_POLICY };
  }
}

export function writeRetentionPolicy(db: Database.Database, policy: Partial<CareRetentionPolicy>): CareRetentionPolicy {
  const normalized = normalizeRetentionPolicy(policy);
  metaSet(db, POLICY_META_KEY, JSON.stringify(normalized));
  return normalized;
}

// ── redaction (priority over pins) ──────────────────────────────────────────────────────────────

export interface RedactionReport {
  /** Messages purged because they passed the TTL. */
  ttlMessages: number;
  /** Source-journal payloads blanked (deleted/expired source row, or older than the TTL), pins ignored. */
  journalPayloads: number;
  /** Event replay payloads dropped (deleted/expired message, TTL, or older than the replay window). */
  replayPayloads: number;
  /** Terminal delivery intents of a deleted message removed together with their attempts. */
  deletedMessageIntents: number;
  /** Bridge artifact payloads (row images, deletedBeforeImage) of erased sources replaced by a minimal marker. */
  artifactPayloads: number;
  /** Erased-source artifacts that still hold content because no usable key was given. Should be 0. */
  artifactsUnredacted: number;
}

export interface RedactOptions {
  /** Care encryption key. Needed to write the minimal artifact payload; without it artifacts are counted, not rewritten. */
  key?: CareKeyInput;
}

/** What an erased artifact keeps: still valid for every reader (`payload.image` is optional everywhere), no content. */
export const REDACTED_ARTIFACT_PAYLOAD = Object.freeze({ image: null, redacted: true });
/** Ciphertext length (iv:tag:data hex) of REDACTED_ARTIFACT_PAYLOAD, used to skip rows already rewritten. */
const REDACTED_ARTIFACT_LEN = 24 + 1 + 32 + 1 + JSON.stringify(REDACTED_ARTIFACT_PAYLOAD).length * 2;
/** Mirrors of legacy rows that carry message/outbox/campaign/run text. Config mirrors (accounts, assignments, threads, profiles) are not TTL'd. */
const CONTENT_ARTIFACT_TABLE = /(outbox|message|broadcast|birthday|agent_runs|draft|attempt)/i;

/** Same effect as CareMessageStore.softDeleteMessage: body/metadata gone, native key kept to block resurrection. */
const BLANK_MESSAGE_SET = `is_deleted = 1, tombstone = 1, deleted_at = COALESCE(deleted_at, @now), body_enc = '', metadata_enc = '',
  directed_at_account = 0, ref_id = NULL, reply_to_ref = NULL`;

const TERMINAL_INTENTS = `'sent','failed','cancelled','discarded'`;

export function redactErasedContent(db: Database.Database, nowMs: number, policy: CareRetentionPolicy, opts: RedactOptions = {}): RedactionReport {
  const report: RedactionReport = { ttlMessages: 0, journalPayloads: 0, replayPayloads: 0, deletedMessageIntents: 0, artifactPayloads: 0, artifactsUnredacted: 0 };
  const ttlCutoff = policy.messageTtlMs === null ? null : nowMs - policy.messageTtlMs;
  const run = db.transaction(() => {
    if (tableExists(db, 'care_messages')) {
      if (ttlCutoff !== null) {
        report.ttlMessages = db.prepare(`UPDATE care_messages SET ${BLANK_MESSAGE_SET} WHERE is_deleted = 0 AND sent_at < @cutoff`).run({ now: nowMs, cutoff: ttlCutoff }).changes;
      }

      if (tableExists(db, 'care_source_journal')) {
        if (tableExists(db, 'care_legacy_links')) {
          report.journalPayloads += db
            .prepare(
              `UPDATE care_source_journal SET payload_enc = ''
               WHERE payload_enc <> '' AND EXISTS (
                 SELECT 1 FROM care_legacy_links l JOIN care_messages m ON m.id = l.canonical_id
                 WHERE l.canonical_entity = 'message' AND m.is_deleted = 1 AND m.account_id = care_source_journal.account_id
                   AND l.source_kind = care_source_journal.source_kind AND l.legacy_table = care_source_journal.source_table
                   AND l.legacy_id = care_source_journal.source_id)`,
            )
            .run().changes;
        }
        if (ttlCutoff !== null) {
          report.journalPayloads += db.prepare(`UPDATE care_source_journal SET payload_enc = '' WHERE payload_enc <> '' AND created_at < ?`).run(ttlCutoff).changes;
        }
      }

      if (tableExists(db, 'care_events') && columnExists(db, 'care_events', 'replay_enc')) {
        const replayCutoff = nowMs - policy.replayPayloadMs;
        report.replayPayloads = db
          .prepare(
            `UPDATE care_events SET replay_enc = NULL
             WHERE replay_enc IS NOT NULL AND (
               created_at < @replayCutoff
               OR (@ttlCutoff IS NOT NULL AND created_at < @ttlCutoff)
               OR CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.messageId') END
                    IN (SELECT id FROM care_messages WHERE is_deleted = 1))`,
          )
          .run({ replayCutoff, ttlCutoff }).changes;
      }

      if (tableExists(db, 'care_delivery_intents')) {
        const ids = (
          db
            .prepare(
              `SELECT i.id FROM care_delivery_intents i
               WHERE i.status IN (${TERMINAL_INTENTS}) AND i.canonical_message_id IS NOT NULL
                 AND EXISTS (SELECT 1 FROM care_messages m WHERE m.id = i.canonical_message_id AND m.is_deleted = 1)`,
            )
            .all() as Array<{ id: string }>
        ).map((r) => r.id);
        report.deletedMessageIntents = deleteIntents(db, ids);
      }
    }
    if (tableExists(db, 'care_bridge_artifacts')) redactArtifacts(db, ttlCutoff, opts, report);
  });
  run.immediate();
  return report;
}

/** Rewrites the payload of every artifact whose source row was deleted (or whose content table row passed the TTL). */
function redactArtifacts(db: Database.Database, ttlCutoff: number | null, opts: RedactOptions, report: RedactionReport): void {
  const rows = db
    .prepare('SELECT id, source_table, source_deleted, updated_at, payload_enc FROM care_bridge_artifacts WHERE source_deleted = 1 OR (@cutoff IS NOT NULL AND updated_at < @cutoff)')
    .all({ cutoff: ttlCutoff }) as Array<{ id: string; source_table: string; source_deleted: number; updated_at: number; payload_enc: string }>;
  const update = db.prepare('UPDATE care_bridge_artifacts SET payload_enc = ? WHERE id = ?');
  for (const r of rows) {
    if (!(r.source_deleted === 1 || CONTENT_ARTIFACT_TABLE.test(r.source_table))) continue;
    if (r.payload_enc.length === REDACTED_ARTIFACT_LEN) {
      try {
        if ((decryptCareJson<{ redacted?: boolean }>(r.payload_enc, opts.key)).redacted === true) continue;
      } catch {
        // not decryptable here: fall through and treat as unredacted
      }
    }
    if (opts.key === undefined) {
      report.artifactsUnredacted += 1;
      continue;
    }
    update.run(encryptCareJson(REDACTED_ARTIFACT_PAYLOAD, opts.key), r.id);
    report.artifactPayloads += 1;
  }
}

function deleteIntents(db: Database.Database, ids: string[]): number {
  if (ids.length === 0) return 0;
  const delAttempts = tableExists(db, 'care_delivery_attempts') ? db.prepare('DELETE FROM care_delivery_attempts WHERE intent_id = ?') : null;
  const delIntent = db.prepare('DELETE FROM care_delivery_intents WHERE id = ?');
  let n = 0;
  for (const id of ids) {
    delAttempts?.run(id);
    n += delIntent.run(id).changes;
  }
  return n;
}

// ── pruning (honours pins, oldest first) ────────────────────────────────────────────────────────

export interface PruneReport {
  events: number;
  sourceJournal: number;
  jobs: number;
  agentRuns: number;
  terminalIntents: number;
  resolvedHolds: number;
}

export interface PruneOptions {
  /** Max rows removed per table per pass (keeps write locks short). Default 5000. */
  batch?: number;
}

/**
 * Deletes the oldest `care_events` rows older than `cutoffMs`, as one contiguous prefix by seq. The newest
 * row is never removed. Returns the number of rows deleted.
 */
export function pruneEventJournal(db: Database.Database, cutoffMs: number, batch = 5000): number {
  if (!tableExists(db, 'care_events')) return 0;
  const newest = scalar(db, 'SELECT MAX(seq) FROM care_events');
  if (newest === null) return 0;
  // Every row below the first row that is still young is old enough: that is the contiguous prefix.
  const firstYoung = scalar(db, 'SELECT MIN(seq) FROM care_events WHERE created_at >= ?', cutoffMs);
  let boundary = Math.min(firstYoung ?? newest, newest);
  const nth = scalar(db, 'SELECT seq FROM care_events WHERE seq < ? ORDER BY seq LIMIT 1 OFFSET ?', boundary, Math.max(0, batch - 1));
  if (nth !== null) boundary = nth + 1;
  return db.prepare('DELETE FROM care_events WHERE seq < ?').run(boundary).changes;
}

/**
 * Prunes the bridge/migration source journal per account, oldest sequence first, stopping at the first row
 * that is too young, at/after a consumer pin, beyond what an active bridge has applied, or the globally
 * newest row (the watermark of "now" is MAX(seq), so it must survive). Payload TTL redaction is NOT this
 * function: it ignores pins (see redactErasedContent).
 */
export function pruneSourceJournal(db: Database.Database, cutoffMs: number, batch = 5000, opts: { accountIds?: readonly string[] } = {}): number {
  if (!tableExists(db, 'care_source_journal')) return 0;
  const globalMax = scalar(db, 'SELECT MAX(seq) FROM care_source_journal');
  if (globalMax === null) return 0;
  const hasPins = tableExists(db, 'care_journal_pins');
  const hasBridge = tableExists(db, 'care_bridge_state');
  let deleted = 0;
  let accounts = (db.prepare('SELECT DISTINCT account_id FROM care_source_journal').all() as Array<{ account_id: string }>).map((r) => r.account_id);
  // The bridge tick prunes only the accounts it replays; the full retention loop passes no filter (every account).
  if (opts.accountIds) {
    const only = new Set(opts.accountIds);
    accounts = accounts.filter((id) => only.has(id));
  }
  for (const accountId of accounts) {
    const pin = hasPins ? scalar(db, 'SELECT MIN(min_seq) FROM care_journal_pins WHERE care_account_id = ?', accountId) : null;
    let appliedBound = NEVER;
    if (hasBridge) {
      const b = db.prepare('SELECT applied_seq, status FROM care_bridge_state WHERE care_account_id = ?').get(accountId) as { applied_seq: number; status: string } | undefined;
      if (b && b.status !== 'disabled') appliedBound = Number(b.applied_seq);
    }
    const block = scalar(
      db,
      `SELECT MIN(seq) FROM care_source_journal
       WHERE account_id = @a AND (created_at >= @cutoff OR seq >= @pin OR seq > @applied OR seq = @max)`,
      { a: accountId, cutoff: cutoffMs, pin: pin ?? NEVER, applied: appliedBound, max: globalMax } as never,
    );
    let boundary = block ?? globalMax + 1;
    const nth = scalar(db, 'SELECT seq FROM care_source_journal WHERE account_id = ? AND seq < ? ORDER BY seq LIMIT 1 OFFSET ?', accountId, boundary, Math.max(0, batch - 1));
    if (nth !== null) boundary = nth + 1;
    deleted += db.prepare('DELETE FROM care_source_journal WHERE account_id = ? AND seq < ?').run(accountId, boundary).changes;
  }
  return deleted;
}

export function pruneCareData(db: Database.Database, nowMs: number, policy: CareRetentionPolicy, opts: PruneOptions = {}): PruneReport {
  const batch = Math.max(1, Math.floor(opts.batch ?? 5000));
  const report: PruneReport = { events: 0, sourceJournal: 0, jobs: 0, agentRuns: 0, terminalIntents: 0, resolvedHolds: 0 };
  const run = db.transaction(() => {
    report.events = pruneEventJournal(db, nowMs - policy.eventsMs, batch);
    report.sourceJournal = pruneSourceJournal(db, nowMs - policy.sourceJournalMs, batch);
    if (tableExists(db, 'care_jobs')) {
      report.jobs = db
        .prepare(`DELETE FROM care_jobs WHERE id IN (SELECT id FROM care_jobs WHERE status IN ('completed','failed') AND updated_at < ? ORDER BY updated_at LIMIT ?)`)
        .run(nowMs - policy.jobsMs, batch).changes;
    }
    if (tableExists(db, 'care_agent_runs')) {
      report.agentRuns = db
        .prepare(`DELETE FROM care_agent_runs WHERE id IN (SELECT id FROM care_agent_runs WHERE status <> 'running' AND updated_at < ? ORDER BY updated_at LIMIT ?)`)
        .run(nowMs - policy.agentRunsMs, batch).changes;
    }
    if (tableExists(db, 'care_delivery_intents')) {
      // A TTL is also a delivery-text TTL: the intent payload holds the outbound body.
      const window = Math.min(policy.attemptsMs, policy.messageTtlMs ?? NEVER);
      const ids = (
        db
          .prepare(`SELECT id FROM care_delivery_intents WHERE status IN (${TERMINAL_INTENTS}) AND updated_at < ? ORDER BY updated_at LIMIT ?`)
          .all(nowMs - window, batch) as Array<{ id: string }>
      ).map((r) => r.id);
      report.terminalIntents = deleteIntents(db, ids);
    }
    if (tableExists(db, 'care_backlog_holds')) {
      report.resolvedHolds = db
        .prepare(`DELETE FROM care_backlog_holds WHERE status <> 'held' AND resolved_at IS NOT NULL AND resolved_at < ?`)
        .run(nowMs - policy.resolvedHoldsMs).changes;
    }
  });
  run.immediate();
  return report;
}

// ── orchestration ───────────────────────────────────────────────────────────────────────────────

export interface RetentionResult {
  atMs: number;
  dryRun: boolean;
  redaction: RedactionReport;
  pruned: PruneReport;
}

export interface RunRetentionOptions {
  nowMs?: number;
  /** Defaults to the persisted policy. */
  policy?: CareRetentionPolicy;
  batch?: number;
  /** Computes the counts and rolls everything back. */
  dryRun?: boolean;
  /** Care encryption key (needed to redact bridge artifact payloads). */
  key?: CareKeyInput;
}

class DryRunRollback extends Error {}

/** One pass: redact first (priority over pins), then prune. */
export function runCareRetention(db: Database.Database, opts: RunRetentionOptions = {}): RetentionResult {
  const nowMs = opts.nowMs ?? Date.now();
  const policy = opts.policy ?? readRetentionPolicy(db);
  const pass = (): RetentionResult => ({
    atMs: nowMs,
    dryRun: Boolean(opts.dryRun),
    redaction: redactErasedContent(db, nowMs, policy, { key: opts.key }),
    pruned: pruneCareData(db, nowMs, policy, { batch: opts.batch }),
  });
  if (!opts.dryRun) return pass();
  let result!: RetentionResult;
  try {
    db.transaction(() => {
      result = pass();
      throw new DryRunRollback();
    }).immediate();
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e;
  }
  return result;
}

export interface RetentionLoopOptions {
  db: Database.Database;
  clock: RuntimeClock;
  /** Time between passes. Default 1 hour. */
  intervalMs?: number;
  policy?: () => CareRetentionPolicy;
  batch?: number;
  key?: CareKeyInput;
  onResult?: (result: RetentionResult) => void;
  /** Receives a scrubbed description only: never the raw error. */
  onError?: (info: { error: unknown }) => void;
}

/** Scheduled purge job: runs until `signal` aborts. A failing pass is reported and retried next interval. */
export async function runRetentionLoop(opts: RetentionLoopOptions, signal: AbortSignal): Promise<void> {
  const interval = Math.max(MIN_WINDOW_MS / 60, opts.intervalMs ?? HOUR);
  while (!signal.aborted) {
    try {
      opts.onResult?.(runCareRetention(opts.db, { nowMs: opts.clock.now(), policy: opts.policy?.(), batch: opts.batch, key: opts.key }));
    } catch (e) {
      opts.onError?.({ error: scrubCareLog(e) });
    }
    await opts.clock.sleep(interval, signal);
  }
}
