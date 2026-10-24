// Pure editing helpers behind the Zalo reply box: text + style ranges + @mentions move together. No DOM, no fetch.
//
// A draft's `styles` (Zalo formatting) and `mentions` are ranges over the PLAIN text, so every edit of the text has to
// shift them. Styles reuse richText.ts (adjustStylesForEdit); mentions follow the same idea but are dropped as soon as
// their own `@Name` characters are touched.

import { adjustStylesForEdit, type ZaloStyle } from '@/lib/richText';
import { MAX_MENTIONS, type ChatDraft, type ChatMention } from './composer';
import { normalizeText } from './canned';
import type { CareMessageDto } from './dto';

export interface RichFields {
  text: string;
  styles: ZaloStyle[];
  mentions: ChatMention[];
}

export function fieldsOf(d: ChatDraft): RichFields {
  return { text: d.text, styles: d.styles ?? [], mentions: d.mentions ?? [] };
}

/** Writes the fields back; empty ranges are removed so a plain draft stays plain. */
export function withFields(d: ChatDraft, f: RichFields): ChatDraft {
  return { ...d, text: f.text, styles: f.styles.length ? f.styles : undefined, mentions: f.mentions.length ? f.mentions : undefined };
}

/** Applies `fn` to a chat draft's fields (any other kind of draft passes through untouched). */
export function patchChatFields<D extends { kind: string }>(d: D, fn: (f: RichFields) => RichFields): D {
  if (d.kind !== 'chat') return d;
  return withFields(d as unknown as ChatDraft, fn(fieldsOf(d as unknown as ChatDraft))) as unknown as D;
}

// ── mentions follow the text ────────────────────────────────────────────────────────────────────

/**
 * Re-positions mentions after the text changed from `oldText` to `newText` (the edit is the diff of the two: common prefix
 * and suffix). A mention whose characters were touched (typed into, partly deleted, replaced) is dropped; one before the
 * edit stays, one after it shifts. Text typed right at either edge of a mention does not become part of it.
 */
export function adjustMentionsForEdit(mentions: ChatMention[], oldText: string, newText: string): ChatMention[] {
  if (oldText === newText || mentions.length === 0) return mentions;
  let p = 0;
  const max = Math.min(oldText.length, newText.length);
  while (p < max && oldText[p] === newText[p]) p++;
  let suffix = 0;
  while (suffix < max - p && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix++;
  const q = oldText.length - suffix; // old [p, q) was replaced
  const delta = newText.length - suffix - p - (q - p);
  const out: ChatMention[] = [];
  for (const m of mentions) {
    const end = m.pos + m.len;
    if (end <= p) out.push(m); // wholly before the edit
    else if (m.pos >= q) out.push({ ...m, pos: m.pos + delta }); // wholly after it
    // else: the edit reaches into the mention, so it is no longer a mention
  }
  return out;
}

/** Text typed / pasted / deleted: styles and mentions follow. */
export function editText(f: RichFields, next: string): RichFields {
  if (next === f.text) return f;
  return {
    text: next,
    styles: adjustStylesForEdit(f.styles, f.text, next),
    mentions: adjustMentionsForEdit(f.mentions, f.text, next),
  };
}

export function setStyles(f: RichFields, styles: ZaloStyle[]): RichFields {
  return { ...f, styles };
}

export interface Inserted {
  fields: RichFields;
  caret: number;
}

function clampSel(text: string, start: number, end: number): [number, number] {
  const a = Math.max(0, Math.min(start, text.length));
  const b = Math.max(a, Math.min(end, text.length));
  return [a, b];
}

/**
 * Inserts `insert` over the selection [start, end), moving styles and mentions with the text. Returns null when the result
 * would pass `maxLength` (the native limit does not apply to programmatic edits).
 */
export function insertText(f: RichFields, start: number, end: number, insert: string, maxLength?: number): Inserted | null {
  const [a, b] = clampSel(f.text, start, end);
  const next = f.text.slice(0, a) + insert + f.text.slice(b);
  if (maxLength && next.length > maxLength) return null;
  return { fields: editText(f, next), caret: a + insert.length };
}

// ── @mention trigger + candidates ──────────────────────────────────────────────────────────────

export interface MentionTrigger {
  /** Index of the `@` in the text. */
  start: number;
  /** What was typed after it (one word). */
  query: string;
}

/** An `@` at the start of the text or after whitespace, followed by at most one word up to the caret. */
export function detectMention(text: string, caret: number): MentionTrigger | null {
  const end = Math.max(0, Math.min(caret, text.length));
  const m = /(^|\s)@([^\s@]{0,30})$/.exec(text.slice(0, end));
  if (!m) return null;
  return { start: end - m[2].length - 1, query: m[2] };
}

export interface MentionCandidate {
  /** Zalo uid, or 'all'. */
  uid: string;
  name: string;
  type: 0 | 1;
}

export const MENTION_ALL_UID = 'all';

/**
 * People who can be mentioned in a group, built from the customer messages already loaded (there is no member API):
 * the sender uid / name Zalo stored with every inbound message. `messages` is newest first, so the latest name wins.
 */
export function mentionCandidates(messages: CareMessageDto[]): MentionCandidate[] {
  const seen = new Map<string, MentionCandidate>();
  for (const m of messages) {
    if (m.direction !== 'in' || m.deleted) continue;
    const env = (m.metadata as { rawEnvelope?: { senderUid?: unknown; senderName?: unknown } } | undefined)?.rawEnvelope;
    const uid = typeof env?.senderUid === 'string' ? env.senderUid.trim() : '';
    if (!uid || uid === MENTION_ALL_UID) continue;
    const name = ((typeof env?.senderName === 'string' ? env.senderName : '') || m.senderName || '').trim().replace(/\s+/g, ' ');
    if (!name) continue;
    if (!seen.has(uid)) seen.set(uid, { uid, name, type: 0 });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

/** Prefix matches first, then substring matches (accent-insensitive); "@all" leads when it matches. */
export function filterMentions(cands: MentionCandidate[], query: string, allLabel: string): MentionCandidate[] {
  const q = normalizeText(query.trim());
  const rank = (c: MentionCandidate): number => {
    const n = normalizeText(c.name);
    if (!q || n.startsWith(q)) return 0;
    if (n.split(' ').some((w) => w.startsWith(q))) return 1;
    if (n.includes(q)) return 2;
    return 3;
  };
  const all: MentionCandidate = { uid: MENTION_ALL_UID, name: allLabel, type: 1 };
  const found = cands.filter((c) => rank(c) < 3).sort((a, b) => rank(a) - rank(b));
  const allMatches = !q || normalizeText(allLabel).startsWith(q) || 'all'.startsWith(q);
  return allMatches ? [all, ...found] : found;
}

/**
 * Replaces the typed `@query` [trigger.start, caret) with `@Name ` and records the mention. Returns null when the text
 * would pass `maxLength` or the mention cap is reached.
 */
export function insertMention(f: RichFields, trigger: Pick<MentionTrigger, 'start'>, caret: number, cand: MentionCandidate, maxLength?: number): Inserted | null {
  if (f.mentions.length >= MAX_MENTIONS) return null;
  const token = `@${cand.name}`;
  const ins = insertText(f, trigger.start, caret, `${token} `, maxLength);
  if (!ins) return null;
  const mention: ChatMention = { uid: cand.uid, pos: trigger.start, len: token.length, ...(cand.type === 1 ? { type: 1 as const } : {}) };
  const mentions = [...ins.fields.mentions, mention].sort((x, y) => x.pos - y.pos);
  return { fields: { ...ins.fields, mentions }, caret: ins.caret };
}
