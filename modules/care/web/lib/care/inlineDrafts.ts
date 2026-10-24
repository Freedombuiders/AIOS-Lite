// Inline AI drafts of one conversation (legacy outbox drafts + core drafts), as the composer area shows them.

import type { CareInlineDraftDto, CareNoteDto } from './dto';

/** Only drafts still waiting for a person: sent/discarded/superseded ones are history. Newest first. */
export function pendingDrafts(items: CareInlineDraftDto[]): CareInlineDraftDto[] {
  return items.filter((d) => d.status === 'draft').sort((a, b) => b.createdAtMs - a.createdAtMs);
}

/** A malformed answer (older or proxied server) must never crash the pane: rows without the fields the UI renders are dropped. */
export function validNote(n: unknown): n is CareNoteDto {
  const r = n as Partial<CareNoteDto> | null;
  return !!r && typeof r.id === 'string' && typeof r.body === 'string' && typeof r.createdAtMs === 'number' && Number.isFinite(r.createdAtMs);
}
export function validDraft(d: unknown): d is CareInlineDraftDto {
  const r = d as Partial<CareInlineDraftDto> | null;
  return !!r && typeof r.id === 'string' && typeof r.text === 'string' && typeof r.createdAtMs === 'number' && Number.isFinite(r.createdAtMs);
}
