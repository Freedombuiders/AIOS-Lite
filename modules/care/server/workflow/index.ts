/**
 * Inbox v2: care-only workflow state, notes and canned replies (see ./contract.ts).
 *
 * Status (done / snoozed / reopen), assignee, AI mode and take-over are stored in `care_conversation_state`.
 * Every write bumps `state_revision` and appends a `conversation.updated` event (no text) in the same transaction, which
 * is what makes the open inbox refresh over SSE.
 */

import type Database from 'better-sqlite3';
import type { CareKeyInput } from '../persistence/crypto.js';
import type { CareStores } from '../persistence/index.js';
import type { CareReadModel } from '../api/read-model.js';
import type { CareConversationDto } from '../api/dto.js';
import type { CareAiMode, CareCannedReplyDto, CareInboxView, CareNoteDto, CareWorkflowStatus } from '../api/dto-inbox.js';
import { ApiError, invalid, notFound } from '../api/errors.js';
import type { CareWorkflowService } from './contract.js';
import { CareWorkflowStore, storeKeyOf, type StatePatch } from './store.js';

export * from './contract.js';
export { ensureWorkflowSchema } from './schema.js';
export { noteConversationId } from './store.js';
export { effectiveStatus, effectiveStatusSql, viewMembership } from './view.js';

export interface CareWorkflowDeps {
  db: Database.Database;
  stores: CareStores;
  model: CareReadModel;
  now: () => number;
  canReadSource: (accountId: string) => boolean;
  /** Care key for note bodies. Default: the key the stores were built with. */
  key?: CareKeyInput;
}

const DAY_MS = 86_400_000;
/** A snooze further away than this is a mistake (or a unit error), not a plan. */
const MAX_SNOOZE_MS = 366 * DAY_MS;
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SHORTCUT_RE = /^[a-z0-9_-]{1,32}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const AI_MODES: readonly CareAiMode[] = ['off', 'draft', 'auto'];

interface ConvInfo {
  id: string;
  accountId: string;
}

export function createCareWorkflowService(deps: CareWorkflowDeps): CareWorkflowService {
  const { db, stores, model } = deps;
  const store = new CareWorkflowStore(db, storeKeyOf(stores, deps.key));
  // The read model computes the `workflow` DTOs; give it the same clock as this service.
  model.useWorkflowEnv({ now: deps.now });

  /** The conversation, readable by the caller; anything else reads as missing. */
  function requireConv(id: string): ConvInfo {
    const row = db
      .prepare('SELECT c.id AS id, c.account_id AS accountId FROM care_conversations c WHERE c.id = ?')
      .get(id) as ConvInfo | undefined;
    if (!row || !deps.canReadSource(row.accountId)) throw notFound();
    return row;
  }

  function dtoOf(id: string): CareConversationDto {
    const dto = model.getConversationDto(id);
    if (!dto) throw notFound();
    return dto;
  }

  function emit(conv: ConvInfo, eventId: string, kind: string): void {
    if (stores.events.hasEvent(conv.accountId, eventId)) return;
    stores.events.appendEvent({
      eventId,
      accountId: conv.accountId,
      conversationId: conv.id,
      eventType: 'conversation.updated',
      payload: { conversationId: conv.id, kind },
    });
  }

  /**
   * One immediate transaction: the stored-state write, then the revision bump and the SSE
   * event. A throw anywhere rolls the lot back.
   */
  function write(id: string, kind: string, patch: StatePatch, expected?: number): CareConversationDto {
    const conv = requireConv(id);
    db.transaction(() => {
      const cur = store.getState(id);
      const currentRevision = cur?.stateRevision ?? 0;
      if (expected !== undefined && expected !== currentRevision) {
        throw new ApiError('STALE_REVISION', 409, undefined, { currentRevision });
      }
      const row = store.writeState(id, patch, deps.now());
      emit(conv, `conv-state:${id}:${row.stateRevision}`, kind);
    }).immediate();
    return dtoOf(id);
  }

  function validAgent(agentId: string | undefined): string {
    if (!agentId || !AGENT_ID_RE.test(agentId)) throw invalid('agentId is required for an agent assignment.');
    return agentId;
  }

  const service: CareWorkflowService = {
    conversation(id) {
      try {
        requireConv(id);
      } catch {
        return null;
      }
      return model.getConversationDto(id);
    },

    setStatus(id, change) {
      const now = deps.now();
      let patch: StatePatch;
      if (change.action === 'done') {
        patch = { workflow: 'done', snoozedUntil: null, changedAt: now };
      } else if (change.action === 'reopen') {
        patch = { workflow: 'auto', snoozedUntil: null, changedAt: now };
      } else if (change.action === 'snooze') {
        const until = change.snoozeUntilMs;
        if (typeof until !== 'number' || !Number.isSafeInteger(until) || until <= now || until > now + MAX_SNOOZE_MS) {
          throw invalid('snoozeUntilMs must be a future time within a year.');
        }
        patch = { workflow: 'snoozed', snoozedUntil: until, changedAt: now };
      } else {
        throw invalid('Unknown workflow action.');
      }
      return write(id, 'workflow', patch, change.expectedStateRevision);
    },

    setAssignee(id, change) {
      const now = deps.now();
      switch (change.kind) {
        case 'owner':
          return write(id, 'assignee', { assigneeKind: 'owner', assigneeAgentId: null, takenOverAt: now });
        case 'agent':
          return write(id, 'assignee', { assigneeKind: 'agent', assigneeAgentId: validAgent(change.agentId), takenOverAt: null });
        case 'none':
        case 'default':
          return write(id, 'assignee', { assigneeKind: change.kind, assigneeAgentId: null, takenOverAt: null });
        default:
          throw invalid('Unknown assignee kind.');
      }
    },

    setAiMode(id, mode) {
      if (!AI_MODES.includes(mode)) throw invalid('Unknown AI mode.');
      return write(id, 'ai', { aiMode: mode });
    },

    setTakeover(id, on) {
      const now = deps.now();
      requireConv(id);
      const cur = store.getState(id);
      return write(
        id,
        'takeover',
        on
          ? { assigneeKind: 'owner', assigneeAgentId: null, takenOverAt: now }
          : { assigneeKind: cur?.assigneeKind === 'owner' ? 'default' : (cur?.assigneeKind ?? 'default'), takenOverAt: null },
      );
    },

    waiting(opts) {
      return model.waitingConversations(opts);
    },

    viewCounts() {
      const c = model.allInboxCounts();
      const views: Record<CareInboxView, number> = { ...c.byView };
      return { ...views, byStatus: { ...c.byStatus } as Record<CareWorkflowStatus, number> };
    },

    // ── notes ───────────────────────────────────────────────────────────────────────────────
    notes(conversationId) {
      requireConv(conversationId);
      return store.listNotes(conversationId);
    },

    addNote(conversationId, body, clientRequestId): CareNoteDto {
      const conv = requireConv(conversationId);
      const text = typeof body === 'string' ? body.trim() : '';
      if (text.length < 1 || text.length > 4000) throw invalid('A note needs 1 to 4000 characters.');
      if (typeof clientRequestId !== 'string' || !REQUEST_ID_RE.test(clientRequestId)) throw invalid('clientRequestId is invalid.');
      return db
        .transaction((): CareNoteDto => {
          const prior = store.findNoteByRequest(clientRequestId);
          if (prior) {
            if (prior.conversationId !== conversationId || prior.body !== text) {
              throw new ApiError('DUPLICATE_REQUEST_PAYLOAD_MISMATCH', 409);
            }
            return prior;
          }
          const note = store.insertNote(conversationId, text, clientRequestId, deps.now());
          emit(conv, `note:${note.id}`, 'note');
          return note;
        })
        .immediate();
    },

    deleteNote(noteId) {
      const row = db.prepare('SELECT conversation_id AS id FROM care_conversation_notes WHERE id = ? AND deleted_at IS NULL').get(noteId) as { id: string } | undefined;
      if (!row) throw notFound();
      const conv = requireConv(row.id);
      db.transaction(() => {
        if (!store.softDeleteNote(noteId, deps.now())) throw notFound();
        emit(conv, `note-del:${noteId}`, 'note');
      }).immediate();
    },

    // ── canned replies ──────────────────────────────────────────────────────────────────────
    canned(): CareCannedReplyDto[] {
      return store.listCanned();
    },

    saveCanned(input): CareCannedReplyDto {
      const shortcut = String(input.shortcut ?? '').trim().replace(/^\//, '').toLowerCase();
      const title = String(input.title ?? '').trim();
      const body = String(input.body ?? '').trim();
      const emailBody = input.emailBody === undefined || input.emailBody === null || String(input.emailBody).trim() === '' ? null : String(input.emailBody).trim();
      if (!SHORTCUT_RE.test(shortcut)) throw invalid('The shortcut must be 1 to 32 characters of a-z, 0-9, _ or -.');
      if (title.length < 1 || title.length > 80) throw invalid('The title needs 1 to 80 characters.');
      if (body.length < 1 || body.length > 4000) throw invalid('The reply needs 1 to 4000 characters.');
      if (emailBody !== null && emailBody.length > 20_000) throw invalid('The email reply is too long.');
      if (input.sort !== undefined && (!Number.isSafeInteger(input.sort) || input.sort < 0 || input.sort > 1_000_000)) throw invalid('sort is invalid.');
      const conflict = (): ApiError => new ApiError('CONFIGURATION_CONFLICT', 409, undefined, { details: { reason: 'SHORTCUT_TAKEN' } });
      try {
        return db
          .transaction((): CareCannedReplyDto => {
            const now = deps.now();
            if (input.id) {
              const cur = store.getCanned(input.id);
              if (!cur) throw notFound();
              if (store.shortcutTaken(shortcut, input.id)) throw conflict();
              return store.updateCanned(input.id, { shortcut, title, body, emailBody, sort: input.sort ?? cur.sort }, now) ?? cur;
            }
            if (store.shortcutTaken(shortcut)) throw conflict();
            return store.insertCanned({ shortcut, title, body, emailBody, sort: input.sort ?? store.nextCannedSort() }, now);
          })
          .immediate();
      } catch (err) {
        if ((err as { code?: string } | null)?.code === 'SQLITE_CONSTRAINT_UNIQUE') throw conflict();
        throw err;
      }
    },

    deleteCanned(id) {
      if (!store.deleteCanned(id)) throw notFound();
    },
  };
  return service;
}
