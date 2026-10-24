// Channel-neutral Customer 360 form model. The shared form edits a `CustomerFormValue`; an adapter
// (adapters.ts) maps it to and from one backend (the Care core API, or the legacy Zalo route), so
// the form itself knows no URL and no channel-specific type.

export const STAGES = ['new', 'consulting', 'quoted', 'deposit', 'won', 'lost'] as const;
export type Stage = (typeof STAGES)[number];

/** Free-text need fields shared by the legacy Zalo profile and the canonical Care profile. */
export const NEED_FIELDS = ['service', 'dates', 'people', 'budget', 'details'] as const;
export type NeedField = (typeof NEED_FIELDS)[number];

export interface CustomerFormValue {
  displayName: string;
  company: string;
  phone: string;
  email: string;
  stage: Stage;
  tags: string;
  owner: string;
  need: Record<NeedField, string>;
  note: string;
}

export interface CustomerTask {
  id: string;
  title: string;
  dueAtMs: number;
  done: boolean;
  owner: string | null;
  revision: number;
  conversationId: string | null;
}

export interface OtherProfile {
  id: string;
  /** Where the profile came from, e.g. `care:customer_care` or a bridged legacy source. */
  provenance: string;
  accountId: string | null;
  note: string | null;
  need: Record<string, unknown> | null;
  revision: number;
}

export interface CustomerSnapshot {
  customerId: string;
  value: CustomerFormValue;
  /** `profile` is null when no editable profile exists yet (the first save creates it at revision 0). */
  revisions: { customer: number; profile: number | null };
  profileProvenance: string | null;
  otherProfiles: OtherProfile[];
  tasks: CustomerTask[];
  writeOwner: 'legacy' | 'draining' | 'core';
  /** False while the account is still owned by the legacy module (or draining): read-only here. */
  writable: boolean;
  /** Extra read-only history lines an adapter can provide (legacy care events). */
  history: Array<{ id: string; text: string; atMs: number }>;
  /** Need keys the form does not edit (e.g. a source message id): carried through untouched on save. */
  needExtra: Record<string, unknown>;
}

export function emptyValue(): CustomerFormValue {
  return { displayName: '', company: '', phone: '', email: '', stage: 'new', tags: '', owner: '', need: { service: '', dates: '', people: '', budget: '', details: '' }, note: '' };
}

const CUSTOMER_KEYS = ['displayName', 'company', 'phone', 'email', 'stage', 'tags', 'owner'] as const;
export type CustomerKey = (typeof CUSTOMER_KEYS)[number];

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

/** Splits a stored need object into the editable text fields and the keys the form must not drop. */
export function splitNeed(need: Record<string, unknown> | null): { fields: Record<NeedField, string>; extra: Record<string, unknown> } {
  const fields = { service: '', dates: '', people: '', budget: '', details: '' } as Record<NeedField, string>;
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(need ?? {})) {
    if ((NEED_FIELDS as readonly string[]).includes(k)) fields[k as NeedField] = str(v);
    else extra[k] = v;
  }
  return { fields, extra };
}

/** Empty strings are not stored: a need with nothing in it is `null`. */
export function joinNeed(fields: Record<NeedField, string>, extra: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = { ...extra };
  for (const k of NEED_FIELDS) if (fields[k].trim()) out[k] = fields[k].trim();
  return Object.keys(out).length ? out : null;
}

export function sameValue(a: CustomerFormValue, b: CustomerFormValue): boolean {
  return JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));
}

function normalise(v: CustomerFormValue): unknown {
  return [...CUSTOMER_KEYS.map((k) => v[k].trim()), ...NEED_FIELDS.map((k) => v.need[k].trim()), v.note.trim()];
}

export function isDirty(saved: CustomerFormValue, edited: CustomerFormValue): boolean {
  return !sameValue(saved, edited);
}

export function validate(v: CustomerFormValue): Partial<Record<CustomerKey | 'note', 'required' | 'tooLong' | 'email'>> {
  const errors: Partial<Record<CustomerKey | 'note', 'required' | 'tooLong' | 'email'>> = {};
  if (!v.displayName.trim()) errors.displayName = 'required';
  else if (v.displayName.trim().length > 512) errors.displayName = 'tooLong';
  if (v.email.trim() && !/^[^\s@]+@[^\s@]+$/.test(v.email.trim())) errors.email = 'email';
  if (v.phone.trim().length > 64) errors.phone = 'tooLong';
  if (v.tags.trim().length > 2000) errors.tags = 'tooLong';
  if (v.note.length > 20_000) errors.note = 'tooLong';
  return errors;
}

// ── save payload (core API) ───────────────────────────────────────────────────────────────────
export interface CareSaveBody {
  expectedCustomerRevision?: number;
  customer?: Partial<Record<CustomerKey, string | null>>;
  expectedProfileRevision?: number;
  profile?: { need?: Record<string, unknown> | null; note?: string | null };
}

const NULLABLE: ReadonlySet<CustomerKey> = new Set(['company', 'phone', 'email', 'tags', 'owner']);

/** Only what changed is sent, each part guarded by the revision the operator saw. null = nothing to save. */
export function buildSaveBody(snap: CustomerSnapshot, edited: CustomerFormValue): CareSaveBody | null {
  const body: CareSaveBody = {};
  const customer: Partial<Record<CustomerKey, string | null>> = {};
  for (const k of CUSTOMER_KEYS) {
    const next = edited[k].trim();
    if (next === snap.value[k].trim()) continue;
    customer[k] = NULLABLE.has(k) && next === '' ? null : next;
  }
  if (Object.keys(customer).length) {
    body.customer = customer;
    body.expectedCustomerRevision = snap.revisions.customer;
  }
  const needChanged = NEED_FIELDS.some((k) => edited.need[k].trim() !== snap.value.need[k].trim());
  const noteChanged = edited.note.trim() !== snap.value.note.trim();
  if (needChanged || noteChanged) {
    body.profile = {};
    if (needChanged) body.profile.need = joinNeed(edited.need, snap.needExtra);
    if (noteChanged) body.profile.note = edited.note.trim() === '' ? null : edited.note;
    body.expectedProfileRevision = snap.revisions.profile ?? 0;
  }
  return Object.keys(body).length ? body : null;
}

/**
 * After a STALE_REVISION the operator can reload the server copy and keep their own edits: a field
 * they changed keeps their value, every other field takes what the other writer saved.
 */
export function rebaseEdits(base: CustomerFormValue, mine: CustomerFormValue, theirs: CustomerFormValue): { value: CustomerFormValue; overlapping: string[] } {
  const value: CustomerFormValue = { ...theirs, need: { ...theirs.need } };
  const overlapping: string[] = [];
  for (const k of CUSTOMER_KEYS) {
    if (mine[k].trim() === base[k].trim()) continue;
    (value as unknown as Record<string, string>)[k] = mine[k];
    if (theirs[k].trim() !== base[k].trim() && theirs[k].trim() !== mine[k].trim()) overlapping.push(k);
  }
  for (const k of NEED_FIELDS) {
    if (mine.need[k].trim() === base.need[k].trim()) continue;
    value.need[k] = mine.need[k];
    if (theirs.need[k].trim() !== base.need[k].trim() && theirs.need[k].trim() !== mine.need[k].trim()) overlapping.push(`need.${k}`);
  }
  if (mine.note.trim() !== base.note.trim()) {
    value.note = mine.note;
    if (theirs.note.trim() !== base.note.trim() && theirs.note.trim() !== mine.note.trim()) overlapping.push('note');
  }
  return { value, overlapping };
}

/** Customer-form save outcome shown to the operator. */
export type SaveProblem =
  | { kind: 'legacy_owned' }
  | { kind: 'draining' }
  | { kind: 'stale'; part: 'customer' | 'profile' | 'unknown' }
  | { kind: 'invalid' }
  | { kind: 'gone' }
  | { kind: 'other'; message: string };

interface FailureLike { status: number; code: string; reason?: string; message: string }

export function classifySaveFailure(f: FailureLike): SaveProblem {
  if (f.reason === 'LEGACY_OWNED') return { kind: 'legacy_owned' };
  if (f.reason === 'ACCOUNT_DRAINING' || f.code === 'ACCOUNT_FROZEN') return { kind: 'draining' };
  if (f.code === 'STALE_REVISION') return { kind: 'stale', part: f.reason === 'CUSTOMER_REVISION' ? 'customer' : f.reason === 'PROFILE_REVISION' ? 'profile' : 'unknown' };
  if (f.code === 'NOT_FOUND') return { kind: 'gone' };
  if (f.code === 'INVALID_COMMAND') return { kind: 'invalid' };
  return { kind: 'other', message: f.message };
}
