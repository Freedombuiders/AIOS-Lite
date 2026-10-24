/**
 * Inbox v2 contract: care-only workflow state per conversation (status open/pending/snoozed/done, assignee,
 * AI mode, take-over), internal notes and canned replies. Implemented in workflow/index.ts
 * (createCareWorkflowService). Used by the /api/m/care routes.
 * Types only.
 */

import type { CareConversationDto } from '../api/dto.js';
import type { CareAiMode, CareCannedReplyDto, CareInboxView, CareNoteDto, CareWorkflowStatus } from '../api/dto-inbox.js';

export interface CareWorkflowService {
  /** Single conversation DTO including `workflow`; null when unknown or not readable. */
  conversation(id: string): CareConversationDto | null;

  setStatus(id: string, change: { action: 'done' | 'reopen' | 'snooze'; snoozeUntilMs?: number; expectedStateRevision?: number }): CareConversationDto;
  /** owner = take over; agent = this agent for this conversation; none = nobody (AI disabled here); default = follow the rules. */
  setAssignee(id: string, change: { kind: 'owner' | 'agent' | 'none' | 'default'; agentId?: string }): CareConversationDto;
  setAiMode(id: string, mode: CareAiMode): CareConversationDto;
  setTakeover(id: string, on: boolean): CareConversationDto;

  /** Effective-status `open` conversations whose customer waited at least `minWaitMs`, oldest wait first. */
  waiting(opts: { minWaitMs: number; now: number; limit: number }): Array<{ conversation: CareConversationDto; waitingSinceMs: number }>;
  /** Tab counters over every readable conversation (no channel/account filter). */
  viewCounts(): Record<CareInboxView, number> & { byStatus: Record<CareWorkflowStatus, number> };

  notes(conversationId: string): CareNoteDto[];
  addNote(conversationId: string, body: string, clientRequestId: string): CareNoteDto;
  deleteNote(noteId: string): void;

  canned(): CareCannedReplyDto[];
  saveCanned(input: { id?: string; shortcut: string; title: string; body: string; emailBody?: string | null; sort?: number }): CareCannedReplyDto;
  deleteCanned(id: string): void;
}
