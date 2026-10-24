// Draft review logic: what the reviewer edited, and the exact-revision approve flow.
//
// Approval is bound to a payload revision. Editing creates a NEW revision (PATCH returns it) and drops
// any approval, so "approve" always sends the revision the reviewer is looking at: either the one
// that was loaded (nothing edited) or the one the save just produced. Never a guess.

import type { CareDraftDto } from '@modules/care/server/api/dto-ops';
import { extractAddress } from './addresses';

export interface DraftEdit {
  text: string;
  /** Comma / newline separated addresses (email only). */
  to: string;
  cc: string;
  subject: string;
}

export function editFromDraft(d: CareDraftDto): DraftEdit {
  return { text: d.text, to: d.email?.to.join(', ') ?? '', cc: d.email?.cc.join(', ') ?? '', subject: d.email?.subject ?? '' };
}

export function parseAddresses(s: string): { list: string[]; invalid: string[] } {
  const list: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of s.split(/[\n,;]/).map((x) => x.trim()).filter(Boolean)) {
    const a = extractAddress(raw);
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a) || a.length > 320) { invalid.push(raw); continue; }
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    list.push(a);
  }
  return { list, invalid };
}

export interface DraftPatchBody {
  expectedRevision: number;
  text?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  currentContextRevision?: number;
}

const same = (a: string[], b: string[]): boolean => JSON.stringify(a.map((x) => x.toLowerCase())) === JSON.stringify(b.map((x) => x.toLowerCase()));

/** Only the fields that changed. null = nothing to save. BCC is never touched (only its presence is visible). */
export function draftPatch(d: CareDraftDto, e: DraftEdit, contextRevision?: number): DraftPatchBody | null {
  const body: DraftPatchBody = { expectedRevision: d.payloadRevision };
  if (e.text !== d.text) body.text = e.text;
  if (d.email) {
    const to = parseAddresses(e.to).list;
    const cc = parseAddresses(e.cc).list;
    if (!same(to, d.email.to)) body.to = to;
    if (!same(cc, d.email.cc)) body.cc = cc;
    if (e.subject.trim() !== d.email.subject) body.subject = e.subject.trim();
  }
  const changed = Object.keys(body).length > 1;
  if (!changed) return null;
  if (contextRevision !== undefined) body.currentContextRevision = contextRevision;
  return body;
}

export type DraftEditError = 'textRequired' | 'toRequired' | 'toInvalid' | 'ccInvalid' | 'subjectRequired';

export function validateEdit(d: CareDraftDto, e: DraftEdit): DraftEditError[] {
  const errors: DraftEditError[] = [];
  if (!e.text.trim()) errors.push('textRequired');
  if (d.email) {
    const to = parseAddresses(e.to);
    if (to.invalid.length) errors.push('toInvalid');
    else if (to.list.length === 0) errors.push('toRequired');
    if (parseAddresses(e.cc).invalid.length) errors.push('ccInvalid');
    if (!e.subject.trim()) errors.push('subjectRequired');
  }
  return errors;
}

export function isReviewable(d: Pick<CareDraftDto, 'status'>): boolean {
  return d.status === 'draft';
}

export type ApprovePlan =
  | { kind: 'approve'; revision: number }
  | { kind: 'save_then_approve'; patch: DraftPatchBody };

/** Saving first when something was edited; the approve step then uses the revision that save returned. */
export function planApprove(d: CareDraftDto, e: DraftEdit, contextRevision?: number): ApprovePlan {
  const patch = draftPatch(d, e, contextRevision);
  return patch ? { kind: 'save_then_approve', patch } : { kind: 'approve', revision: d.payloadRevision };
}

export const REVIEW_GROUPS = {
  review: ['draft'],
  scheduled: ['pending', 'retry_wait', 'sending'],
  history: ['sent', 'uncertain', 'needs_review', 'failed', 'cancelled', 'discarded'],
} as const;
export type ReviewGroup = keyof typeof REVIEW_GROUPS;

/** A scheduled send can still be withdrawn until the sender claims it. */
export function canCancelScheduled(d: Pick<CareDraftDto, 'status'>): boolean {
  return d.status === 'pending' || d.status === 'retry_wait';
}

export function draftRecipients(d: CareDraftDto): string {
  return d.email ? d.email.to.join(', ') : '';
}
