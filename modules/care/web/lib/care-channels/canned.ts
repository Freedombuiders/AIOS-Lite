// Câu trả lời nhanh (canned replies): validation the form runs before it calls POST/PUT /api/m/care/canned.
// The server owns the final say (UNIQUE shortcut); these checks only spare a round trip and word the reason.

import type { CareCannedReplyDto } from '@modules/care/server/api/dto-inbox';

/** Typed after `/` in the composer. */
export const SHORTCUT_RE = /^[a-z0-9_-]{1,32}$/;
export const TITLE_MAX = 120;
export const BODY_MAX = 4000;

export interface CannedDraft {
  shortcut: string;
  title: string;
  body: string;
  emailBody: string;
}

export type CannedErrorCode = 'shortcutRequired' | 'shortcutInvalid' | 'shortcutTaken' | 'titleRequired' | 'titleTooLong' | 'bodyRequired' | 'bodyTooLong' | 'emailBodyTooLong';
export type CannedErrors = Partial<Record<'shortcut' | 'title' | 'body' | 'emailBody', CannedErrorCode>>;

/** "/Nhantien " -> "nhantien": the owner may type the slash and capitals; the stored shortcut has neither. */
export function normalizeShortcut(raw: string): string {
  return raw.trim().replace(/^\/+/, '').toLowerCase();
}

export function isValidShortcut(shortcut: string): boolean {
  return SHORTCUT_RE.test(shortcut);
}

export function emptyCanned(): CannedDraft {
  return { shortcut: '', title: '', body: '', emailBody: '' };
}

export function draftFromCanned(c: Pick<CareCannedReplyDto, 'shortcut' | 'title' | 'body' | 'emailBody'>): CannedDraft {
  return { shortcut: c.shortcut, title: c.title, body: c.body, emailBody: c.emailBody ?? '' };
}

/** `editingId` is the reply being edited (it may keep its own shortcut). */
export function validateCanned(draft: CannedDraft, existing: ReadonlyArray<Pick<CareCannedReplyDto, 'id' | 'shortcut'>>, editingId: string | null = null): CannedErrors {
  const errors: CannedErrors = {};
  const shortcut = normalizeShortcut(draft.shortcut);
  if (!shortcut) errors.shortcut = 'shortcutRequired';
  else if (!isValidShortcut(shortcut)) errors.shortcut = 'shortcutInvalid';
  else if (existing.some((c) => c.shortcut === shortcut && c.id !== editingId)) errors.shortcut = 'shortcutTaken';
  const title = draft.title.trim();
  if (!title) errors.title = 'titleRequired';
  else if (title.length > TITLE_MAX) errors.title = 'titleTooLong';
  const body = draft.body.trim();
  if (!body) errors.body = 'bodyRequired';
  else if (body.length > BODY_MAX) errors.body = 'bodyTooLong';
  if (draft.emailBody.trim().length > BODY_MAX) errors.emailBody = 'emailBodyTooLong';
  return errors;
}

export function hasErrors(e: CannedErrors): boolean {
  return Object.keys(e).length > 0;
}

/** The request body of POST/PUT /api/m/care/canned. An empty email variant is sent as null (clears it). */
export function cannedBody(draft: CannedDraft, sort?: number): { shortcut: string; title: string; body: string; emailBody: string | null; sort?: number } {
  const emailBody = draft.emailBody.trim();
  return {
    shortcut: normalizeShortcut(draft.shortcut),
    title: draft.title.trim(),
    body: draft.body.trim(),
    emailBody: emailBody ? emailBody : null,
    ...(sort !== undefined ? { sort } : {}),
  };
}

/** Next `sort` for a new reply: after the last one. */
export function nextSort(existing: ReadonlyArray<Pick<CareCannedReplyDto, 'sort'>>): number {
  return existing.reduce((m, c) => Math.max(m, c.sort), 0) + 10;
}

/** The list order the composer menu uses: by `sort`, then shortcut. */
export function sortCanned<T extends Pick<CareCannedReplyDto, 'sort' | 'shortcut'>>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.sort - b.sort || a.shortcut.localeCompare(b.shortcut));
}
