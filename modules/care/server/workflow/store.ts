/**
 * Persistence of the workflow tables (see ./schema.ts): conversation state, internal notes, canned replies.
 * Plain SQL over the shared handle; note bodies are encrypted with the Care key exactly like the other `*_enc` columns.
 * No business rules here (status/assignee logic lives in ./index.ts); every method is safe to call inside the
 * caller's transaction.
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CareCannedReplyDto, CareNoteDto } from '../api/dto-inbox.js';
import { decryptCareFieldStrict, encryptCareField, type CareKeyInput } from '../persistence/crypto.js';

export interface StateRow {
  conversationId: string;
  workflow: 'auto' | 'snoozed' | 'done';
  snoozedUntil: number | null;
  changedAt: number | null;
  assigneeKind: 'default' | 'owner' | 'agent' | 'none';
  assigneeAgentId: string | null;
  aiMode: 'off' | 'draft' | 'auto' | null;
  takenOverAt: number | null;
  stateRevision: number;
  updatedAt: number;
}

/** Fields a write may change; the revision and `updated_at` are always handled by `writeState`. */
export type StatePatch = Partial<Pick<StateRow, 'workflow' | 'snoozedUntil' | 'changedAt' | 'assigneeKind' | 'assigneeAgentId' | 'aiMode' | 'takenOverAt'>>;

interface NoteRow {
  id: string;
  conversation_id: string;
  client_request_id: string;
  body_enc: string;
  author: string;
  created_at: number;
  deleted_at: number | null;
}

interface CannedRow {
  id: string;
  shortcut: string;
  title: string;
  body: string;
  email_body: string | null;
  sort: number;
  created_at: number;
  updated_at: number;
}

/**
 * The Care key as the stores were built with it. `CareStores` does not expose it and the host does not pass it
 * to the workflow service, so it is read back from an encrypted sibling store (same instance, same key). An
 * explicit `key` in the deps always wins.
 */
export function storeKeyOf(stores: object, explicit?: CareKeyInput): CareKeyInput | undefined {
  if (explicit !== undefined) return explicit;
  const tasks = (stores as { tasks?: { key?: CareKeyInput } }).tasks;
  return tasks?.key;
}

/** Conversation a (live) note belongs to, or null. For routes that must check the account before a delete. */
export function noteConversationId(db: Database.Database, noteId: string): string | null {
  const row = db.prepare('SELECT conversation_id AS id FROM care_conversation_notes WHERE id = ? AND deleted_at IS NULL').get(noteId) as { id: string } | undefined;
  return row?.id ?? null;
}

export class CareWorkflowStore {
  constructor(
    private readonly db: Database.Database,
    private readonly key?: CareKeyInput,
  ) {}

  // ── state ─────────────────────────────────────────────────────────────────────────────────
  getState(conversationId: string): StateRow | null {
    const r = this.db.prepare('SELECT * FROM care_conversation_state WHERE conversation_id = ?').get(conversationId) as any;
    if (!r) return null;
    return {
      conversationId: r.conversation_id,
      workflow: r.workflow,
      snoozedUntil: r.snoozed_until === null ? null : Number(r.snoozed_until),
      changedAt: r.changed_at === null ? null : Number(r.changed_at),
      assigneeKind: r.assignee_kind,
      assigneeAgentId: r.assignee_agent_id,
      aiMode: r.ai_mode,
      takenOverAt: r.taken_over_at === null ? null : Number(r.taken_over_at),
      stateRevision: Number(r.state_revision),
      updatedAt: Number(r.updated_at),
    };
  }

  /** Creates the row on first write; every call bumps `state_revision` by one. Returns the new row. */
  writeState(conversationId: string, patch: StatePatch, now: number): StateRow {
    const cur = this.getState(conversationId);
    const next: StateRow = {
      conversationId,
      workflow: cur?.workflow ?? 'auto',
      snoozedUntil: cur?.snoozedUntil ?? null,
      changedAt: cur?.changedAt ?? null,
      assigneeKind: cur?.assigneeKind ?? 'default',
      assigneeAgentId: cur?.assigneeAgentId ?? null,
      aiMode: cur?.aiMode ?? null,
      takenOverAt: cur?.takenOverAt ?? null,
      stateRevision: (cur?.stateRevision ?? 0) + 1,
      updatedAt: now,
      ...patch,
    };
    this.db
      .prepare(
        `INSERT INTO care_conversation_state
           (conversation_id, workflow, snoozed_until, changed_at, assignee_kind, assignee_agent_id, ai_mode, taken_over_at, state_revision, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           workflow = excluded.workflow, snoozed_until = excluded.snoozed_until, changed_at = excluded.changed_at,
           assignee_kind = excluded.assignee_kind, assignee_agent_id = excluded.assignee_agent_id, ai_mode = excluded.ai_mode,
           taken_over_at = excluded.taken_over_at, state_revision = excluded.state_revision, updated_at = excluded.updated_at`,
      )
      .run(
        next.conversationId,
        next.workflow,
        next.snoozedUntil,
        next.changedAt,
        next.assigneeKind,
        next.assigneeAgentId,
        next.aiMode,
        next.takenOverAt,
        next.stateRevision,
        next.updatedAt,
      );
    return next;
  }

  // ── notes ─────────────────────────────────────────────────────────────────────────────────
  private toNote(r: NoteRow): CareNoteDto {
    return {
      id: r.id,
      conversationId: r.conversation_id,
      body: decryptCareFieldStrict(r.body_enc, this.key),
      author: 'owner',
      createdAtMs: Number(r.created_at),
    };
  }

  getNote(id: string): CareNoteDto | null {
    const r = this.db.prepare('SELECT * FROM care_conversation_notes WHERE id = ? AND deleted_at IS NULL').get(id) as NoteRow | undefined;
    return r ? this.toNote(r) : null;
  }

  /** Any note (deleted or not) written with this request id: idempotency must outlive a delete. */
  findNoteByRequest(clientRequestId: string): CareNoteDto | null {
    const r = this.db.prepare('SELECT * FROM care_conversation_notes WHERE client_request_id = ?').get(clientRequestId) as NoteRow | undefined;
    return r ? this.toNote(r) : null;
  }

  insertNote(conversationId: string, body: string, clientRequestId: string, now: number): CareNoteDto {
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO care_conversation_notes (id, conversation_id, client_request_id, body_enc, author, created_at)
         VALUES (?, ?, ?, ?, 'owner', ?)`,
      )
      .run(id, conversationId, clientRequestId, encryptCareField(body, this.key), now);
    return this.getNote(id)!;
  }

  listNotes(conversationId: string): CareNoteDto[] {
    const rows = this.db
      .prepare('SELECT * FROM care_conversation_notes WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, rowid ASC')
      .all(conversationId) as NoteRow[];
    return rows.map((r) => this.toNote(r));
  }

  softDeleteNote(id: string, now: number): boolean {
    return this.db.prepare('UPDATE care_conversation_notes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, id).changes > 0;
  }

  // ── canned replies ────────────────────────────────────────────────────────────────────────
  private toCanned(r: CannedRow): CareCannedReplyDto {
    return { id: r.id, shortcut: r.shortcut, title: r.title, body: r.body, emailBody: r.email_body, sort: Number(r.sort), updatedAtMs: Number(r.updated_at) };
  }

  listCanned(): CareCannedReplyDto[] {
    const rows = this.db.prepare('SELECT * FROM care_canned_replies ORDER BY sort ASC, shortcut ASC').all() as CannedRow[];
    return rows.map((r) => this.toCanned(r));
  }

  getCanned(id: string): CareCannedReplyDto | null {
    const r = this.db.prepare('SELECT * FROM care_canned_replies WHERE id = ?').get(id) as CannedRow | undefined;
    return r ? this.toCanned(r) : null;
  }

  shortcutTaken(shortcut: string, exceptId?: string): boolean {
    const r = this.db.prepare('SELECT id FROM care_canned_replies WHERE shortcut = ?').get(shortcut) as { id: string } | undefined;
    return Boolean(r) && r!.id !== exceptId;
  }

  nextCannedSort(): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM care_canned_replies').get() as { m: number };
    return Number(r.m) + 1;
  }

  insertCanned(c: { shortcut: string; title: string; body: string; emailBody: string | null; sort: number }, now: number): CareCannedReplyDto {
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO care_canned_replies (id, shortcut, title, body, email_body, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, c.shortcut, c.title, c.body, c.emailBody, c.sort, now, now);
    return this.getCanned(id)!;
  }

  updateCanned(id: string, c: { shortcut: string; title: string; body: string; emailBody: string | null; sort: number }, now: number): CareCannedReplyDto | null {
    const info = this.db
      .prepare('UPDATE care_canned_replies SET shortcut = ?, title = ?, body = ?, email_body = ?, sort = ?, updated_at = ? WHERE id = ?')
      .run(c.shortcut, c.title, c.body, c.emailBody, c.sort, now, id);
    return info.changes > 0 ? this.getCanned(id) : null;
  }

  deleteCanned(id: string): boolean {
    return this.db.prepare('DELETE FROM care_canned_replies WHERE id = ?').run(id).changes > 0;
  }
}
