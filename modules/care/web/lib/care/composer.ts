// Composer logic shared by the chat and email reply boxes. Pure: no DOM, no fetch.
//
// Invariants the UI relies on:
//  - a draft belongs to ONE conversation; switching conversations never carries text across;
//  - a clientRequestId is minted once per payload and REUSED on retry, so a lost response can
//    never produce a second send; editing the payload mints a new one (the server rejects the
//    same id with a different payload);
//  - the email preview shows exactly what will be sent: To, Cc, subject. There is no BCC.

import type { CareConversationDto, CareMessageDto } from './dto';
import { extractAddress, looksAutomated, normalizeAddress, replySubject, uniqueAddresses } from './addresses';
import type { CareFailure } from './failure';
import type { ZaloStyle } from '@/lib/richText';

export type EmailReplyMode = 'reply' | 'reply_all';

/** A file uploaded by a channel module (care.composerExtras), waiting to go out with the next reply (Zalo only). */
export interface ChatAttachment {
  mediaId: string;
  name: string;
  kind: string;
  mime: string;
  size: number;
}

/** A Zalo @mention over the draft text (`pos`/`len` cover the `@Name` characters; type 1 = @all, groups only). */
export interface ChatMention {
  uid: string;
  pos: number;
  len: number;
  type?: 0 | 1;
}

/** Zalo caps (the server enforces the same ones). */
export const MAX_STYLES = 200;
export const MAX_MENTIONS = 50;

export interface ChatDraft {
  kind: 'chat';
  text: string;
  /** Zalo formatting ranges over the EXACT `text` (see richText.ts); absent / empty = plain message. */
  styles?: ZaloStyle[];
  /** Zalo @mentions over `text` (group conversations only). */
  mentions?: ChatMention[];
  attachments?: ChatAttachment[];
  /** The AI draft this text was copied from ("Sửa rồi gửi"): discarded once the reply is accepted. */
  fromDraftId?: string;
  requestId: string | null;
  payloadKey: string | null;
}

export interface EmailDraft {
  kind: 'email';
  mode: EmailReplyMode;
  body: string;
  /** null = follow the thread subject automatically. */
  subject: string | null;
  /** Cc addresses the operator dropped from the preview (lower-cased). */
  removedCc: string[];
  /** Recipients of an AI draft loaded into the composer; replaces the computed ones until the reply mode changes. */
  recipients?: { to: string[]; cc: string[] } | null;
  /** The AI draft this was copied from ("Sửa rồi gửi"): discarded once the reply is accepted. */
  fromDraftId?: string;
  requestId: string | null;
  payloadKey: string | null;
}

export type ComposerDraft = ChatDraft | EmailDraft;

export function emptyDraft(kind: 'chat' | 'email'): ComposerDraft {
  return kind === 'chat'
    ? { kind: 'chat', text: '', requestId: null, payloadKey: null }
    : { kind: 'email', mode: 'reply', body: '', subject: null, removedCc: [], requestId: null, payloadKey: null };
}

export function draftHasContent(d: ComposerDraft): boolean {
  if (d.kind === 'chat' && (d.attachments?.length ?? 0) > 0) return true;
  return (d.kind === 'chat' ? d.text : d.body).trim().length > 0;
}

/** The text a draft would send (placeholders are checked against it). */
export function draftText(d: ComposerDraft): string {
  return d.kind === 'chat' ? d.text : d.body;
}

// ── request ids ───────────────────────────────────────────────────────────────────────────────
export function newRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const rand = c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `care-${rand}`; // 8..128 chars of [A-Za-z0-9_.:-], as the API requires
}

// ── email preview ─────────────────────────────────────────────────────────────────────────────
export interface EmailPreview {
  to: string[];
  /** Cc after removals. */
  cc: string[];
  /** Cc as computed before the operator removed any (so removals can be undone). */
  ccCandidates: string[];
  subject: string;
  inReplyToHeader?: string;
  replyToMessageId?: string;
  warnings: Array<'automated_recipient' | 'no_recipient' | 'no_message'>;
}

interface EmailMetaLike {
  type?: string;
  subject?: string;
  from?: string;
  replyTo?: string;
  to?: string[];
  cc?: string[];
  messageIdHeader?: string;
}

function emailMeta(m: CareMessageDto): EmailMetaLike | null {
  const meta = m.metadata as unknown as EmailMetaLike | undefined;
  return meta && meta.type === 'email' ? meta : null;
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * `messages` is newest first. The thread's last inbound email is what gets answered; if the thread
 * only holds our own mail, the preview continues that exchange (same recipients as the last send).
 */
export function computeEmailPreview(
  draft: Pick<EmailDraft, 'mode' | 'subject' | 'removedCc'> & { recipients?: EmailDraft['recipients'] },
  messages: CareMessageDto[],
  ownAddresses: string[],
): EmailPreview {
  const emails = messages.filter((m) => emailMeta(m));
  const base = emails.find((m) => m.direction === 'in') ?? emails[0];
  if (!base) {
    return { to: [], cc: [], ccCandidates: [], subject: draft.subject ?? 'Re:', warnings: ['no_message'] };
  }
  const meta = emailMeta(base)!;
  const own = new Set(ownAddresses.map(normalizeAddress));
  let to: string[];
  let ccPool: string[];
  if (base.direction === 'in') {
    const primary = meta.replyTo?.trim() || meta.from?.trim() || '';
    to = uniqueAddresses(primary ? [primary] : [], own);
    ccPool = draft.mode === 'reply_all' ? [...list(meta.to), ...list(meta.cc)] : [];
  } else {
    to = uniqueAddresses(list(meta.to), own);
    ccPool = draft.mode === 'reply_all' ? list(meta.cc) : [];
  }
  if (draft.recipients && draft.recipients.to.length > 0) {
    // An AI draft carries its own recipients; the owner can still drop Cc addresses from them.
    to = uniqueAddresses(draft.recipients.to, own);
    ccPool = draft.recipients.cc;
  }
  const toKeys = new Set(to.map(normalizeAddress));
  const ccCandidates = uniqueAddresses(ccPool, new Set([...own, ...toKeys]));
  const removed = new Set(draft.removedCc.map((a) => a.toLowerCase()));
  const cc = ccCandidates.filter((a) => !removed.has(a.toLowerCase()));
  const warnings: EmailPreview['warnings'] = [];
  if (to.length === 0) warnings.push('no_recipient');
  if ([...to, ...cc].some(looksAutomated)) warnings.push('automated_recipient');
  return {
    to,
    cc,
    ccCandidates,
    subject: draft.subject ?? replySubject(meta.subject),
    ...(meta.messageIdHeader ? { inReplyToHeader: meta.messageIdHeader } : {}),
    replyToMessageId: base.id,
    warnings,
  };
}

/** Our own mailbox addresses for an email account: its native ID, plus a label that looks like an address. */
export function ownAddressesOf(account: { nativeAccountId: string; label: string } | undefined): string[] {
  if (!account) return [];
  return [account.nativeAccountId, account.label].map(extractAddress).filter((a) => /^[^@\s]+@[^@\s]+$/.test(a));
}

// ── submit ────────────────────────────────────────────────────────────────────────────────────
export interface ReplyBody {
  clientRequestId: string;
  accountId: string;
  channel: string;
  text: string;
  expectedConversationRevision?: number;
  /** Files added by a channel module through care.composerExtras. */
  attachments?: Array<{ mediaId: string }>;
  /** Zalo only: style ranges over `text` (omitted for plain messages). */
  styles?: ZaloStyle[];
  /** Zalo group only: @mentions over `text` (omitted when there are none). */
  mentions?: ChatMention[];
  target?: {
    replyToMessageId?: string;
    topicId?: string;
    to?: string[];
    cc?: string[];
    subject?: string;
    inReplyToHeader?: string;
  };
}

export interface PreparedSubmit {
  body: ReplyBody;
  /** The draft to store while the request is in flight (carries the id so a retry reuses it). */
  draft: ComposerDraft;
}

export function topicIdOf(messages: CareMessageDto[]): string | undefined {
  for (const m of messages) {
    const t = (m.metadata as { topicId?: unknown }).topicId;
    if (typeof t === 'string' && t) return t;
  }
  return undefined;
}

function stableKey(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * The formatting a Zalo draft sends: ranges clamped to the text, empties dropped, capped at the server limits. Telegram and
 * email never carry any, and mentions only exist in group conversations. Empty results are `undefined`, so a plain message
 * produces exactly the request it always did.
 */
export function richPayload(draft: ChatDraft, conversation: Pick<CareConversationDto, 'channel' | 'kind'>): { styles?: ZaloStyle[]; mentions?: ChatMention[] } {
  if (conversation.channel !== 'zalo') return {};
  const n = draft.text.length;
  const styles: ZaloStyle[] = [];
  for (const s of draft.styles ?? []) {
    const start = Math.max(0, s.start);
    const len = Math.min(s.len, n - start);
    if (len > 0) styles.push({ ...s, start, len });
  }
  const mentions: ChatMention[] = [];
  if (conversation.kind === 'group') {
    for (const m of draft.mentions ?? []) {
      if (m.pos < 0 || m.len <= 0 || m.pos + m.len > n || draft.text[m.pos] !== '@') continue;
      mentions.push({ uid: m.uid, pos: m.pos, len: m.len, ...(m.type === 1 ? { type: 1 as const } : {}) });
    }
  }
  return {
    ...(styles.length ? { styles: styles.slice(0, MAX_STYLES) } : {}),
    ...(mentions.length ? { mentions: mentions.slice(0, MAX_MENTIONS) } : {}),
  };
}

export type PrepareResult = { ok: true; value: PreparedSubmit } | { ok: false; reason: 'empty' | 'no_recipient' | 'no_message' };

export function prepareSubmit(args: {
  draft: ComposerDraft;
  conversation: CareConversationDto;
  messages: CareMessageDto[];
  ownAddresses: string[];
  genId?: () => string;
}): PrepareResult {
  const { draft, conversation, messages } = args;
  const genId = args.genId ?? newRequestId;
  if (!draftHasContent(draft)) return { ok: false, reason: 'empty' };

  let text: string;
  let target: ReplyBody['target'];
  if (draft.kind === 'email') {
    const p = computeEmailPreview(draft, messages, args.ownAddresses);
    if (p.warnings.includes('no_message')) return { ok: false, reason: 'no_message' };
    if (p.to.length === 0) return { ok: false, reason: 'no_recipient' };
    // The mailbox signature belongs to the server (appended once on send); the body goes as typed.
    text = draft.body;
    target = {
      to: p.to,
      ...(p.cc.length ? { cc: p.cc } : {}),
      subject: p.subject,
      ...(p.inReplyToHeader ? { inReplyToHeader: p.inReplyToHeader } : {}),
      ...(p.replyToMessageId ? { replyToMessageId: p.replyToMessageId } : {}),
    };
  } else {
    text = draft.text;
    const topicId = conversation.kind === 'topic' ? topicIdOf(messages) : undefined;
    target = topicId ? { topicId } : undefined;
  }

  const attachments = draft.kind === 'chat' && draft.attachments?.length ? draft.attachments.map((a) => ({ mediaId: a.mediaId })) : undefined;
  const rich = draft.kind === 'chat' ? richPayload(draft, conversation) : {};
  // `undefined` members vanish from the JSON, so a plain message keeps the key it always had.
  const payloadKey = stableKey({ c: conversation.id, a: conversation.accountId, text, target, attachments, styles: rich.styles, mentions: rich.mentions });
  const reuse = draft.requestId !== null && draft.payloadKey === payloadKey;
  const requestId = reuse ? draft.requestId! : genId();
  const body: ReplyBody = {
    clientRequestId: requestId,
    accountId: conversation.accountId,
    channel: conversation.channel,
    text,
    expectedConversationRevision: conversation.revision,
    ...(attachments ? { attachments } : {}),
    ...(rich.styles ? { styles: rich.styles } : {}),
    ...(rich.mentions ? { mentions: rich.mentions } : {}),
    ...(target ? { target } : {}),
  };
  return { ok: true, value: { body, draft: { ...draft, requestId, payloadKey } } };
}

export type SubmitOutcome =
  /** Accepted (or an idempotent duplicate): the text is now the server's responsibility. */
  | { kind: 'accepted'; duplicate: boolean }
  /** Sending is not wired on the server (501). Keep the draft, show the capability state. */
  | { kind: 'unavailable' }
  /** The conversation moved on, or the id clashed: keep the text, tell the operator. */
  | { kind: 'conflict'; code: CareFailure['code']; mintNewId: boolean; refresh: boolean }
  | { kind: 'rejected'; code: CareFailure['code'] }
  /** No response: we cannot know whether it was accepted, so the SAME id is retried. */
  | { kind: 'unknown' };

export function classifyFailure(f: CareFailure): SubmitOutcome {
  if (f.status === 0 || f.code === 'NETWORK' || f.code === 'NETWORK_TIMEOUT') return { kind: 'unknown' };
  if (f.status === 501 || (f.code === 'UNSUPPORTED_CAPABILITY' && f.status !== 422)) return { kind: 'unavailable' };
  if (f.code === 'DUPLICATE_REQUEST_PAYLOAD_MISMATCH') return { kind: 'conflict', code: f.code, mintNewId: true, refresh: false };
  if (f.status === 409) {
    return { kind: 'conflict', code: f.code, mintNewId: false, refresh: f.code === 'STALE_REVISION' || f.code === 'FENCING_REJECTED' };
  }
  if (f.status >= 500) return { kind: 'unknown' }; // the port may have stored the intent before failing
  return { kind: 'rejected', code: f.code };
}

/** Draft after a submit finished. Accepted clears the body; a payload mismatch drops the id. */
export function settleDraft(draft: ComposerDraft, outcome: SubmitOutcome): ComposerDraft {
  if (outcome.kind === 'accepted') {
    return draft.kind === 'chat'
      ? { ...draft, text: '', styles: undefined, mentions: undefined, attachments: [], fromDraftId: undefined, requestId: null, payloadKey: null }
      : { ...draft, body: '', subject: null, removedCc: [], recipients: null, fromDraftId: undefined, mode: 'reply', requestId: null, payloadKey: null };
  }
  if (outcome.kind === 'conflict' && outcome.mintNewId) return { ...draft, requestId: null, payloadKey: null };
  return draft;
}

function bodyOf(d: ComposerDraft): string {
  return d.kind === 'chat' ? d.text : d.body;
}

function formattingOf(d: ComposerDraft): string {
  return d.kind === 'chat' ? JSON.stringify([d.styles ?? [], d.mentions ?? []]) : '';
}

/**
 * `settleDraft` for a request that resolved while the operator kept typing: only the text that was
 * actually sent is cleared; anything typed since stays, and the id is dropped so it is not reused
 * for different text.
 */
export function settleDraftAgainst(current: ComposerDraft, sent: ComposerDraft, outcome: SubmitOutcome): ComposerDraft {
  if (outcome.kind === 'accepted' && (bodyOf(current) !== bodyOf(sent) || formattingOf(current) !== formattingOf(sent))) return { ...current, requestId: null, payloadKey: null };
  return settleDraft(current, outcome);
}
