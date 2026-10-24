/**
 * Source journal, legacy links, credentials, assignments, profiles and tasks.
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { CareError } from '../../../_lib/care-kit/errors.js';
import type {
  AssignmentMode,
  AssignmentScope,
  CareAssignment,
  CareChannel,
  CareSourceJournalRecord,
} from '../../../_lib/care-kit/types.js';
import {
  CARE_ASSIGNMENT_MODES,
  CARE_ASSIGNMENT_SCOPES,
  CARE_CHANNELS,
  oneOf,
  requireNonEmptyString,
  requireSafeInteger,
} from '../../../_lib/care-kit/validation.js';
import {
  decryptCareJson,
  decryptNullable,
  encryptCareField,
  encryptCareJson,
  encryptNullable,
  type CareKeyInput,
} from './crypto.js';
import { requireAccountRow, requireConversationOfAccount, requireCustomerExists } from './shared.js';

export interface CareProfileRecord {
  id: string;
  customerId: string;
  accountId: string | null;
  provenance: string;
  need: Record<string, unknown> | null;
  note: string | null;
  revision: number;
  updatedAtMs: number;
  createdAtMs: number;
}

export interface CareTaskRecord {
  id: string;
  customerId: string;
  conversationId: string | null;
  title: string;
  dueAtMs: number;
  done: boolean;
  owner: string | null;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export class CareJournalStore {
  constructor(
    private readonly db: Database.Database,
    private readonly key?: CareKeyInput,
  ) {}

  appendSourceJournal(entry: {
    accountId: string;
    sourceKind: string;
    sourceTable: string;
    sourceId: string;
    operation: 'insert' | 'update' | 'delete';
    sourceVersion?: number;
    payload: Record<string, unknown>;
  }): number {
    requireAccountRow(this.db, entry.accountId);
    requireNonEmptyString(entry.sourceKind, 'sourceKind', 64);
    requireNonEmptyString(entry.sourceTable, 'sourceTable', 128);
    requireNonEmptyString(entry.sourceId, 'sourceId', 512);
    const version = requireSafeInteger(entry.sourceVersion ?? 1, 'sourceVersion', 1);

    const info = this.db
      .prepare(
        `INSERT INTO care_source_journal (
           account_id, source_kind, source_table, source_id, operation, source_version, payload_enc, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.accountId,
        entry.sourceKind,
        entry.sourceTable,
        entry.sourceId,
        entry.operation,
        version,
        encryptCareJson(entry.payload, this.key),
        Date.now(),
      );
    return Number(info.lastInsertRowid);
  }

  listUnappliedJournal(limit = 100): CareSourceJournalRecord[] {
    const capped = Math.min(Math.max(Math.trunc(limit) || 1, 1), 1000);
    const rows = this.db
      .prepare('SELECT * FROM care_source_journal WHERE applied_at IS NULL ORDER BY seq ASC LIMIT ?')
      .all(capped) as any[];
    return rows.map((r) => this.mapRow(r));
  }

  /** Highest journal sequence written so far (0 when empty): the watermark of "now". */
  maxSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM care_source_journal').get() as { m: number };
    return Number(row.m);
  }

  /** Entries of one (Care) account after `afterSeq`, in order. Payloads stay encrypted. */
  listForAccount(careAccountId: string, afterSeq: number, upToSeq: number, limit = 200): CareSourceJournalRecord[] {
    const capped = Math.min(Math.max(Math.trunc(limit) || 1, 1), 1000);
    const rows = this.db
      .prepare('SELECT * FROM care_source_journal WHERE account_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?')
      .all(careAccountId, afterSeq, upToSeq, capped) as any[];
    return rows.map((r) => this.mapRow(r));
  }

  /** Decrypts a captured image. Strict: a bad key/tag throws, never a fallback. */
  decryptImage(record: Pick<CareSourceJournalRecord, 'payloadEnc'>): Record<string, unknown> | null {
    return record.payloadEnc ? decryptCareJson<Record<string, unknown>>(record.payloadEnc, this.key) : null;
  }

  /** Decrypts a journal payload (empty after a TTL/delete purge). */
  readPayload(seq: number): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT payload_enc FROM care_source_journal WHERE seq = ?').get(seq) as
      | { payload_enc: string }
      | undefined;
    return row && row.payload_enc ? decryptCareJson<Record<string, unknown>>(row.payload_enc, this.key) : null;
  }

  markJournalApplied(seq: number): boolean {
    const res = this.db.prepare('UPDATE care_source_journal SET applied_at = ? WHERE seq = ?').run(Date.now(), seq);
    return res.changes > 0;
  }

  /**
   * TTL/delete purge: zeroes encrypted payloads while keeping the sequence so consumers can resume.
   * NEVER purges an entry that a migration/replayer may still need: anything at or after a
   * retention pin of its account, or not yet replayed by an active (non-disabled) bridge.
   */
  purgePayloadsBefore(beforeMs: number): number {
    const res = this.db
      .prepare(
        `UPDATE care_source_journal SET payload_enc = ''
         WHERE created_at < ? AND payload_enc != ''
           AND seq < COALESCE((SELECT MIN(p.min_seq) FROM care_journal_pins p WHERE p.care_account_id = care_source_journal.account_id), 9223372036854775807)
           AND seq <= COALESCE((SELECT s.applied_seq FROM care_bridge_state s
                                WHERE s.care_account_id = care_source_journal.account_id AND s.status <> 'disabled'), 9223372036854775807)`,
      )
      .run(beforeMs);
    return res.changes;
  }

  private mapRow(row: any): CareSourceJournalRecord {
    return {
      seq: Number(row.seq),
      accountId: row.account_id,
      sourceKind: row.source_kind,
      sourceTable: row.source_table,
      sourceId: row.source_id,
      operation: row.operation,
      sourceVersion: Number(row.source_version),
      payloadEnc: row.payload_enc,
      appliedAtMs: row.applied_at === null || row.applied_at === undefined ? null : Number(row.applied_at),
      createdAtMs: Number(row.created_at),
    };
  }
}

export class CareLegacyLinkStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Stable mapping: re-linking the same pair is a no-op, but a legacy row can never be silently
   * re-pointed at another canonical entity (or vice versa).
   */
  linkLegacy(
    canonicalId: string,
    canonicalEntity: string,
    sourceKind: string,
    legacyTable: string,
    legacyId: string,
  ): void {
    const run = this.db.transaction(() => {
      const byLegacy = this.db
        .prepare('SELECT canonical_id, canonical_entity FROM care_legacy_links WHERE source_kind = ? AND legacy_table = ? AND legacy_id = ?')
        .get(sourceKind, legacyTable, legacyId) as { canonical_id: string; canonical_entity: string } | undefined;
      if (byLegacy) {
        if (byLegacy.canonical_id === canonicalId && byLegacy.canonical_entity === canonicalEntity) return;
        throw new CareError('CONFIGURATION_CONFLICT', 'Legacy row is already mapped to a different canonical entity', 409);
      }
      const byCanonical = this.db
        .prepare('SELECT 1 FROM care_legacy_links WHERE canonical_entity = ? AND canonical_id = ?')
        .get(canonicalEntity, canonicalId);
      if (byCanonical) {
        throw new CareError('CONFIGURATION_CONFLICT', 'Canonical entity is already mapped to a different legacy row', 409);
      }
      this.db
        .prepare(
          `INSERT INTO care_legacy_links (canonical_id, canonical_entity, source_kind, legacy_table, legacy_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(canonicalId, canonicalEntity, sourceKind, legacyTable, legacyId, Date.now());
    });
    run();
  }

  resolveCanonicalId(sourceKind: string, legacyTable: string, legacyId: string): string | null {
    const row = this.db
      .prepare('SELECT canonical_id FROM care_legacy_links WHERE source_kind = ? AND legacy_table = ? AND legacy_id = ?')
      .get(sourceKind, legacyTable, legacyId) as any;
    return row ? row.canonical_id : null;
  }

  resolveLegacyId(canonicalEntity: string, canonicalId: string, sourceKind: string): string | null {
    const row = this.db
      .prepare('SELECT legacy_id FROM care_legacy_links WHERE canonical_entity = ? AND canonical_id = ? AND source_kind = ?')
      .get(canonicalEntity, canonicalId, sourceKind) as any;
    return row ? row.legacy_id : null;
  }
}

export class CareCredentialStore {
  constructor(
    private readonly db: Database.Database,
    private readonly key?: CareKeyInput,
  ) {}

  saveCredential(accountId: string, credentialType: string, payload: Record<string, unknown>): void {
    requireAccountRow(this.db, accountId);
    requireNonEmptyString(credentialType, 'credentialType', 64);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO care_credentials (id, account_id, credential_type, payload_enc, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(account_id, credential_type) DO UPDATE SET
           payload_enc = excluded.payload_enc,
           revision = care_credentials.revision + 1,
           updated_at = excluded.updated_at`,
      )
      .run(crypto.randomUUID(), accountId, credentialType, encryptCareJson(payload, this.key), now, now);
  }

  /** Strict decryption: throws CareError on bad tag, bad key or malformed ciphertext. */
  getCredential(accountId: string, credentialType: string): Record<string, unknown> | null {
    const row = this.db
      .prepare('SELECT payload_enc FROM care_credentials WHERE account_id = ? AND credential_type = ?')
      .get(accountId, credentialType) as any;
    return row ? decryptCareJson<Record<string, unknown>>(row.payload_enc, this.key) : null;
  }
}

export class CareAssignmentStore {
  constructor(
    private readonly db: Database.Database,
    private readonly key?: CareKeyInput,
  ) {}

  /**
   * Scope shape (also enforced by CHECK constraints):
   *  global       no account/channel/customer, no scopeTarget
   *  channel      channel only (scopeTarget, if given, must equal it)
   *  customer     existing customer (+ optional account); scopeTarget, if given, equals the customer
   *  account      existing account (channel, if given, must match the account)
   *  conversation existing account + scopeTarget = external conversation key
   *  identity     existing account + scopeTarget = identity key / email address
   *  domain       existing EMAIL account + scopeTarget = domain
   * `expectedConfigVersion` makes an update compare-and-set.
   */
  upsertAssignment(assignment: {
    id?: string;
    accountId?: string | null;
    customerId?: string | null;
    scope: AssignmentScope;
    scopeTarget?: string | null;
    channel?: CareChannel | null;
    priority?: number;
    enabled?: boolean;
    mode: AssignmentMode;
    agentId?: string;
    instructionsRef?: string | null;
    /** Native policy extensions (see CareAssignment.policyExt). Encrypted at rest. */
    policyExt?: Record<string, unknown> | null;
    expectedConfigVersion?: number;
  }): CareAssignment {
    const run = this.db.transaction(() => {
      const scope = oneOf(CARE_ASSIGNMENT_SCOPES, assignment.scope, 'assignment scope');
      const mode = oneOf(CARE_ASSIGNMENT_MODES, assignment.mode, 'assignment mode');
      const priority = requireSafeInteger(assignment.priority ?? 100, 'priority', -1_000_000);
      const accountId = assignment.accountId ?? null;
      const customerId = assignment.customerId ?? null;
      const channel = assignment.channel === undefined || assignment.channel === null ? null : oneOf(CARE_CHANNELS, assignment.channel, 'channel');
      let scopeTarget = assignment.scopeTarget ?? null;
      const agentId = assignment.agentId ?? '';
      if (mode !== 'observe') requireNonEmptyString(agentId, 'agentId', 128);

      const account = accountId ? requireAccountRow(this.db, accountId) : null;
      if (customerId) requireCustomerExists(this.db, customerId);
      const bad = (msg: string): never => {
        throw new CareError('INVALID_TARGET', `Invalid '${scope}' assignment: ${msg}`, 400);
      };

      switch (scope) {
        case 'global':
          if (accountId || channel || customerId) bad('global scope takes no account, channel or customer');
          if (scopeTarget !== null && scopeTarget !== 'global') bad('global scope takes no target');
          scopeTarget = null;
          break;
        case 'channel':
          if (!channel) bad('channel scope requires a channel');
          if (accountId || customerId) bad('channel scope takes no account or customer');
          if (scopeTarget !== null && scopeTarget !== channel) bad('scopeTarget must equal the channel');
          scopeTarget = null;
          break;
        case 'customer':
          if (!customerId) bad('customer scope requires a customerId');
          if (channel) bad('customer scope takes no channel');
          if (scopeTarget !== null && scopeTarget !== customerId) bad('scopeTarget must equal the customerId');
          scopeTarget = null;
          break;
        case 'account':
          if (!account) bad('account scope requires an account');
          if (customerId) bad('account scope takes no customer');
          if (channel && channel !== account!.channel) bad('channel does not match the account');
          if (scopeTarget !== null && scopeTarget !== accountId) bad('scopeTarget must equal the accountId');
          scopeTarget = null;
          break;
        case 'conversation':
        case 'identity':
        case 'domain':
          if (!account) bad(`${scope} scope requires an account`);
          if (customerId) bad(`${scope} scope takes no customer`);
          if (channel && channel !== account!.channel) bad('channel does not match the account');
          requireNonEmptyString(scopeTarget, 'scopeTarget', 1024);
          if (scope === 'domain' && account!.channel !== 'email') bad('domain scope is only valid for email accounts');
          break;
      }

      const id = assignment.id || crypto.randomUUID();
      const now = Date.now();
      const existing = this.db.prepare('SELECT config_version FROM care_assignments WHERE id = ?').get(id) as
        | { config_version: number }
        | undefined;
      if (assignment.expectedConfigVersion !== undefined) {
        if (!existing || Number(existing.config_version) !== assignment.expectedConfigVersion) {
          throw new CareError('STALE_REVISION', 'Assignment configVersion mismatch', 409);
        }
      }

      this.db
        .prepare(
          `INSERT INTO care_assignments (
             id, account_id, customer_id, scope, scope_target, channel, priority, enabled, mode,
             agent_id, instructions_ref_enc, policy_ext_enc, config_version, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             account_id = excluded.account_id,
             customer_id = excluded.customer_id,
             scope = excluded.scope,
             scope_target = excluded.scope_target,
             channel = excluded.channel,
             priority = excluded.priority,
             enabled = excluded.enabled,
             mode = excluded.mode,
             agent_id = excluded.agent_id,
             instructions_ref_enc = excluded.instructions_ref_enc,
             policy_ext_enc = excluded.policy_ext_enc,
             config_version = care_assignments.config_version + 1,
             updated_at = excluded.updated_at`,
        )
        .run(
          id,
          accountId,
          customerId,
          scope,
          scopeTarget,
          channel,
          priority,
          assignment.enabled !== false ? 1 : 0,
          mode,
          agentId || null,
          encryptNullable(assignment.instructionsRef, this.key),
          assignment.policyExt ? encryptCareJson(assignment.policyExt, this.key) : null,
          now,
          now,
        );

      return this.getAssignment(id)!;
    });
    return run();
  }

  getAssignment(id: string): CareAssignment | null {
    const row = this.db.prepare('SELECT * FROM care_assignments WHERE id = ?').get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  /** With an accountId: that account's rules plus the account-less (global/channel/customer) ones. */
  listAssignments(
    filterOrAccountId?:
      | string
      | {
          accountId?: string;
          channel?: CareChannel;
          customerId?: string;
          scope?: AssignmentScope;
        },
  ): CareAssignment[] {
    let sql = 'SELECT * FROM care_assignments WHERE 1=1';
    const params: any[] = [];
    const filter = typeof filterOrAccountId === 'string' ? { accountId: filterOrAccountId } : filterOrAccountId;
    if (filter?.accountId) {
      sql += ' AND (account_id = ? OR account_id IS NULL)';
      params.push(filter.accountId);
    }
    if (filter?.channel) {
      sql += ' AND channel = ?';
      params.push(filter.channel);
    }
    if (filter?.customerId) {
      sql += ' AND customer_id = ?';
      params.push(filter.customerId);
    }
    if (filter?.scope) {
      sql += ' AND scope = ?';
      params.push(filter.scope);
    }
    sql += ' ORDER BY priority DESC, id ASC';
    return (this.db.prepare(sql).all(...params) as any[]).map((r) => this.mapRow(r));
  }

  deleteAssignment(id: string): boolean {
    return this.db.prepare('DELETE FROM care_assignments WHERE id = ?').run(id).changes > 0;
  }

  private mapRow(row: any): CareAssignment {
    return {
      id: row.id,
      accountId: row.account_id ?? null,
      customerId: row.customer_id ?? null,
      scope: row.scope,
      scopeTarget: row.scope_target ?? null,
      channel: row.channel ?? null,
      priority: Number(row.priority),
      enabled: Boolean(row.enabled),
      mode: row.mode,
      agentId: row.agent_id ?? '',
      instructionsRef: decryptNullable(row.instructions_ref_enc, this.key),
      configVersion: Number(row.config_version),
      policyExt: row.policy_ext_enc ? decryptCareJson<Record<string, unknown>>(row.policy_ext_enc, this.key) : null,
    };
  }
}

export class CareProfileStore {
  constructor(
    private readonly db: Database.Database,
    private readonly key?: CareKeyInput,
  ) {}

  saveProfile(
    customerId: string,
    data: { need?: Record<string, unknown> | null; note?: string | null },
    accountId: string | null = null,
    provenance = 'canonical',
  ): CareProfileRecord {
    requireCustomerExists(this.db, customerId);
    if (accountId) requireAccountRow(this.db, accountId);
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO care_profiles (id, customer_id, account_id, provenance, need_enc, note_enc, revision, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        customerId,
        accountId,
        provenance,
        data.need ? encryptCareJson(data.need, this.key) : null,
        data.note ? encryptCareField(data.note, this.key) : null,
        now,
        now,
      );
    return this.getProfile(id)!;
  }

  /**
   * Bridge only: idempotent upsert of a legacy care profile by deterministic ID, PRESERVING the
   * legacy revision and timestamps (ordinary saves always start at revision 1).
   */
  upsertBridged(input: {
    id: string;
    customerId: string;
    accountId: string;
    provenance: string;
    need: Record<string, unknown> | null;
    note: string | null;
    revision: number;
    updatedAtMs: number;
  }): CareProfileRecord {
    requireCustomerExists(this.db, input.customerId);
    requireAccountRow(this.db, input.accountId);
    requireSafeInteger(input.revision, 'revision', 0);
    requireSafeInteger(input.updatedAtMs, 'updatedAtMs', 0);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO care_profiles (id, customer_id, account_id, provenance, need_enc, note_enc, revision, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           customer_id = excluded.customer_id, provenance = excluded.provenance, need_enc = excluded.need_enc,
           note_enc = excluded.note_enc, revision = excluded.revision, updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.customerId,
        input.accountId,
        input.provenance,
        input.need ? encryptCareJson(input.need, this.key) : null,
        input.note ? encryptCareField(input.note, this.key) : null,
        input.revision,
        input.updatedAtMs,
        now,
      );
    return this.getProfile(input.id)!;
  }

  /**
   * Operator edit with optimistic concurrency: one transaction, one revision bump. Only the fields present in `patch`
   * change (`need: null` / `note: null` clear them); a mismatch of `expectedRevision` is a 409 carrying the current one.
   * A no-op patch keeps the revision. `provenance` is rewritten only when given.
   */
  updateProfile(
    id: string,
    patch: { need?: Record<string, unknown> | null; note?: string | null; provenance?: string },
    expectedRevision: number,
    nowMs: number = Date.now(),
  ): CareProfileRecord {
    const run = this.db.transaction(() => {
      const existing = this.getProfile(id);
      if (!existing) throw new CareError('NOT_FOUND', `Profile not found: ${id}`, 404);
      if (existing.revision !== expectedRevision) {
        throw new CareError('STALE_REVISION', 'Profile was changed by someone else', 409, { currentRevision: existing.revision });
      }
      const need = patch.need === undefined ? existing.need : patch.need;
      const note = patch.note === undefined ? existing.note : patch.note;
      const provenance = patch.provenance === undefined ? existing.provenance : patch.provenance;
      if (JSON.stringify(need) === JSON.stringify(existing.need) && note === existing.note && provenance === existing.provenance) {
        return existing;
      }
      const res = this.db
        .prepare(
          `UPDATE care_profiles SET need_enc = ?, note_enc = ?, provenance = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(need ? encryptCareJson(need, this.key) : null, note ? encryptCareField(note, this.key) : null, provenance, nowMs, id, expectedRevision);
      if (res.changes !== 1) throw new CareError('STALE_REVISION', 'Profile was changed by someone else', 409);
      return this.getProfile(id)!;
    });
    return run.immediate();
  }

  getProfile(id: string): CareProfileRecord | null {
    const row = this.db.prepare('SELECT * FROM care_profiles WHERE id = ?').get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  getProfilesByCustomer(customerId: string): CareProfileRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM care_profiles WHERE customer_id = ? ORDER BY updated_at DESC, id DESC')
      .all(customerId) as any[];
    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(row: any): CareProfileRecord {
    return {
      id: row.id,
      customerId: row.customer_id,
      accountId: row.account_id,
      provenance: row.provenance,
      need: row.need_enc ? decryptCareJson<Record<string, unknown>>(row.need_enc, this.key) : null,
      note: decryptNullable(row.note_enc, this.key),
      revision: Number(row.revision),
      updatedAtMs: Number(row.updated_at),
      createdAtMs: Number(row.created_at),
    };
  }
}

export class CareTaskStore {
  constructor(
    private readonly db: Database.Database,
    private readonly key?: CareKeyInput,
  ) {}

  createTask(input: {
    customerId: string;
    conversationId?: string | null;
    title: string;
    dueAtMs: number;
    owner?: string | null;
  }): CareTaskRecord {
    const run = this.db.transaction(() => {
      requireCustomerExists(this.db, input.customerId);
      if (input.conversationId) {
        const conv = this.db.prepare('SELECT account_id FROM care_conversations WHERE id = ?').get(input.conversationId) as
          | { account_id: string }
          | undefined;
        if (!conv) throw new CareError('INVALID_TARGET', `Conversation not found: ${input.conversationId}`, 404);
        void requireConversationOfAccount(this.db, input.conversationId, conv.account_id);
      }
      const title = requireNonEmptyString(input.title, 'title', 2000);
      const due = requireSafeInteger(input.dueAtMs, 'dueAtMs', 0);
      const id = crypto.randomUUID();
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO care_tasks (id, customer_id, conversation_id, title_enc, due_at, done, owner, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?, ?)`,
        )
        .run(id, input.customerId, input.conversationId ?? null, encryptCareField(title, this.key), due, input.owner ?? null, now, now);
      return this.getTask(id)!;
    });
    return run();
  }

  /**
   * Bridge only: idempotent upsert of a legacy task by deterministic ID. Compares the PLAINTEXT
   * fields (ciphertext differs on every encrypt), so a replay writes nothing and keeps the
   * revision; a real change bumps it once.
   */
  upsertBridged(input: {
    id: string;
    customerId: string;
    title: string;
    dueAtMs: number;
    done: boolean;
    owner?: string | null;
    createdAtMs?: number;
  }): CareTaskRecord {
    const run = this.db.transaction(() => {
      requireCustomerExists(this.db, input.customerId);
      const title = requireNonEmptyString(input.title, 'title', 2000);
      const due = requireSafeInteger(input.dueAtMs, 'dueAtMs', 0);
      const owner = input.owner ?? null;
      const existing = this.getTask(input.id);
      const now = Date.now();
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO care_tasks (id, customer_id, conversation_id, title_enc, due_at, done, owner, revision, created_at, updated_at)
             VALUES (?, ?, NULL, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(input.id, input.customerId, encryptCareField(title, this.key), due, input.done ? 1 : 0, owner, input.createdAtMs ?? now, now);
      } else if (
        existing.customerId !== input.customerId || existing.title !== title || existing.dueAtMs !== due ||
        existing.done !== input.done || existing.owner !== owner
      ) {
        this.db
          .prepare(
            `UPDATE care_tasks SET customer_id = ?, title_enc = ?, due_at = ?, done = ?, owner = ?, revision = revision + 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(input.customerId, encryptCareField(title, this.key), due, input.done ? 1 : 0, owner, now, input.id);
      }
      return this.getTask(input.id)!;
    });
    return run();
  }

  /**
   * Operator edit with optimistic concurrency: one transaction, one revision bump. Only the fields
   * present in `patch` change; a mismatch of `expectedRevision` is a 409 carrying the current one.
   */
  updateTask(
    id: string,
    patch: { title?: string; dueAtMs?: number; owner?: string | null; done?: boolean },
    expectedRevision: number,
  ): CareTaskRecord {
    const run = this.db.transaction(() => {
      const existing = this.getTask(id);
      if (!existing) throw new CareError('NOT_FOUND', `Task not found: ${id}`, 404);
      if (existing.revision !== expectedRevision) {
        throw new CareError('STALE_REVISION', 'Task was changed by someone else', 409, { currentRevision: existing.revision });
      }
      const title = patch.title === undefined ? existing.title : requireNonEmptyString(patch.title, 'title', 2000);
      const due = patch.dueAtMs === undefined ? existing.dueAtMs : requireSafeInteger(patch.dueAtMs, 'dueAtMs', 0);
      const owner = patch.owner === undefined ? existing.owner : patch.owner;
      const done = patch.done === undefined ? existing.done : patch.done;
      if (title === existing.title && due === existing.dueAtMs && owner === existing.owner && done === existing.done) {
        return existing; // no-op edit keeps the revision
      }
      this.db
        .prepare(
          `UPDATE care_tasks SET title_enc = ?, due_at = ?, done = ?, owner = ?, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(encryptCareField(title, this.key), due, done ? 1 : 0, owner ?? null, Date.now(), id);
      return this.getTask(id)!;
    });
    return run.immediate();
  }

  /** Bridge only: the legacy profile no longer lists this task. */
  deleteTask(id: string): boolean {
    return this.db.prepare('DELETE FROM care_tasks WHERE id = ?').run(id).changes > 0;
  }

  getTask(id: string): CareTaskRecord | null {
    const row = this.db.prepare('SELECT * FROM care_tasks WHERE id = ?').get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  listTasksByCustomer(customerId: string): CareTaskRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM care_tasks WHERE customer_id = ? ORDER BY due_at ASC, id ASC')
      .all(customerId) as any[];
    return rows.map((r) => this.mapRow(r));
  }

  setTaskDone(id: string, done: boolean): boolean {
    const res = this.db
      .prepare('UPDATE care_tasks SET done = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
      .run(done ? 1 : 0, Date.now(), id);
    return res.changes > 0;
  }

  private mapRow(row: any): CareTaskRecord {
    return {
      id: row.id,
      customerId: row.customer_id,
      conversationId: row.conversation_id,
      title: decryptNullable(row.title_enc, this.key) ?? '',
      dueAtMs: Number(row.due_at),
      done: Boolean(row.done),
      owner: row.owner,
      revision: Number(row.revision),
      createdAtMs: Number(row.created_at),
      updatedAtMs: Number(row.updated_at),
    };
  }
}
