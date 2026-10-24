/**
 * Pure helpers that turn Composio's Gmail payloads into plain data, and the
 * "is this mail automated?" heuristics. No I/O. Owner: workstream B.
 */

import type { EmailAttachmentMeta, EmailCategory } from './store.js';

/** One Gmail message, normalized. Addresses are lower-cased. */
export interface GmailMessage {
  gmailMessageId: string;
  gmailThreadId: string;
  labelIds: string[];
  fromEmail: string;
  fromName: string;
  /** Reply-To address ('' when absent). */
  replyTo: string;
  to: string[];
  cc: string[];
  subject: string;
  /** text/plain part, or text derived from the HTML part. */
  bodyText: string;
  bodyHtml: string;
  snippet: string;
  /** Subset with lower-cased names: message-id, in-reply-to, references, reply-to,
   *  list-unsubscribe, list-id, precedence, auto-submitted, x-autoreply,
   *  x-autorespond, x-auto-response-suppress, return-path, date. */
  headers: Record<string, string>;
  attachments: EmailAttachmentMeta[];
  /** ms */
  sentAtMs: number;
  /** Gmail internalDate (ms, when the provider received the message). Absent when the payload has none. */
  internalDateMs?: number;
  /** Gmail historyId (digits). Absent when the payload has none. */
  historyId?: string;
}

const BODY_CAP = 200_000;
const SNIPPET_CAP = 200;
const HEADER_CAP = 1000;

const KEPT_HEADERS = new Set([
  'message-id', 'in-reply-to', 'references', 'reply-to', 'list-unsubscribe', 'list-id', 'precedence',
  'auto-submitted', 'x-autoreply', 'x-autorespond', 'x-auto-response-suppress', 'return-path', 'date',
]);

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// ── Addresses ─────────────────────────────────────────────────────────

/** "Name <a@b.com>" → { email: 'a@b.com', name: 'Name' }. */
export function parseAddress(raw: string): { email: string; name: string } {
  const text = (raw ?? '').trim();
  if (!text) return { email: '', name: '' };
  const angle = text.match(/<([^<>]*)>\s*$/) ?? text.match(/<([^<>]*)>/);
  if (angle) {
    const email = angle[1].trim().toLowerCase();
    const name = text.slice(0, angle.index).trim().replace(/^"(.*)"$/s, '$1').replace(/\\(.)/g, '$1').trim();
    return { email, name: name === email ? '' : name };
  }
  const bare = text.match(/[^\s<>",;()]+@[^\s<>",;()]+/);
  if (bare) return { email: bare[0].toLowerCase(), name: '' };
  return { email: text.toLowerCase(), name: '' };
}

/** Splits on commas that are outside quotes and angle brackets. */
function splitAddressList(raw: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && quoted) { cur += ch + (raw[++i] ?? ''); continue; }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angle++;
    else if (!quoted && ch === '>') angle = Math.max(0, angle - 1);
    if (!quoted && angle === 0 && (ch === ',' || ch === ';')) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** "a@b.com, Name <c@d.com>" → ['a@b.com', 'c@d.com']. */
export function parseAddressList(raw: string): string[] {
  const out: string[] = [];
  for (const part of splitAddressList(raw ?? '')) {
    const { email } = parseAddress(part);
    if (email && email.includes('@') && !out.includes(email)) out.push(email);
  }
  return out;
}

// ── HTML / text ───────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", hellip: '…', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', bull: '•', middot: '·',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

const BLOCK = '\u0001';

/** Readable text from HTML (block tags → newlines, entities decoded, scripts/styles dropped). */
export function htmlToText(html: string): string {
  let s = (html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol|blockquote|section|article|pre)\s*>/gi, BLOCK)
    .replace(/<(p|div|li|tr|h[1-6]|blockquote|pre)\b[^>]*>/gi, BLOCK)
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    // Adjacent block boundaries (</div><p>) are one line break, and never stack on a <br>.
    .replace(/[ \t]*\u0001[ \t\u0001]*/g, (_m, off: number, whole: string) => (off > 0 && whole[off - 1] === '\n' ? '' : '\n'));
  s = decodeEntities(s);
  return s
    .replace(/ /g, ' ')
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ── Quoted history ────────────────────────────────────────────────────

const WROTE_END = /(wrote|đã viết|đã gửi|a écrit|schrieb)\s*:\s*$/i;
const WROTE_START = /^\s*(on|vào|ngày|trong ngày|le|am)\b/i;
const ORIGINAL_MSG = /^\s*-{2,}\s*(original message|original|thư gốc|tin nhắn gốc|thư trả lời|reply message)\s*-{2,}\s*$/i;
const UNDERSCORE_RULE = /^\s*_{10,}\s*$/;
const FROM_LINE = /^\s*\*?(from|từ|von|de)\*?\s*:/i;
const SENT_LINE = /^\s*\*?(sent|date|đã gửi|gửi lúc|ngày gửi|ngày|gesendet)\*?\s*:/i;

/**
 * Drops the quoted history of a reply: "On … wrote:" / "Vào … đã viết:"
 * blocks, lines starting with ">", Gmail/Outlook quote separators
 * ("-----Original Message-----", "From: … Sent: …"). Keeps the new text.
 */
export function stripQuotedReply(text: string): string {
  const original = normalizeNewlines(text ?? '').trim();
  if (!original) return '';
  const lines = original.split('\n');
  let cut = lines.length;

  const nextNonEmpty = (from: number, count: number): string[] => {
    const out: string[] = [];
    for (let j = from; j < lines.length && out.length < count; j++) if (lines[j].trim()) out.push(lines[j]);
    return out;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // "On Tue, 7 Oct 2026 at 13:58, Name <a@b.com> wrote:" may wrap onto the next line.
    const joined = WROTE_START.test(line) && !WROTE_END.test(line) && i + 1 < lines.length ? `${line.trim()} ${lines[i + 1].trim()}` : line.trim();
    if (joined.length <= 400 && WROTE_END.test(joined) && (WROTE_START.test(joined) || joined.includes('@'))) { cut = i; break; }
    if (ORIGINAL_MSG.test(line)) { cut = i; break; }
    if (UNDERSCORE_RULE.test(line) && nextNonEmpty(i + 1, 1).some((l) => FROM_LINE.test(l))) { cut = i; break; }
    if (FROM_LINE.test(line)) {
      const following = lines.slice(i + 1, i + 7);
      if (following.some((l) => SENT_LINE.test(l))) { cut = i; break; }
    }
  }

  const kept = lines.slice(0, cut);
  while (kept.length) {
    const last = kept[kept.length - 1].trim();
    if (!last || last.startsWith('>')) kept.pop();
    else break;
  }
  const result = kept.join('\n').trim();
  return result || original;
}

// ── Gmail labels ──────────────────────────────────────────────────────

/** Gmail CATEGORY_* labels → category ('' when the message has none, e.g. SENT). */
export function gmailCategory(labelIds: string[]): EmailCategory {
  const labels = new Set(labelIds ?? []);
  if (labels.has('CATEGORY_PROMOTIONS')) return 'promotions';
  if (labels.has('CATEGORY_SOCIAL')) return 'social';
  if (labels.has('CATEGORY_UPDATES')) return 'updates';
  if (labels.has('CATEGORY_FORUMS')) return 'forums';
  if (labels.has('CATEGORY_PERSONAL') || labels.has('CATEGORY_PRIMARY')) return 'primary';
  if (labels.has('INBOX')) return 'primary';
  return '';
}

// ── Automated mail ────────────────────────────────────────────────────

const AUTO_SUBJECT = /^\s*(auto:|auto[- ]?(reply|response)|automatic reply|autoreply|out of office|trả lời tự động|tự động trả lời|thư trả lời tự động|undeliverable|delivery status notification|mail delivery)/i;
// Any token of the local part, split on separators: catches "acb-notification",
// "billing.alerts", "updates-noreply" as well as the bare forms.
const AUTO_LOCAL_TOKEN = /^(no[-_.]?reply|noreply|donotreply|mailer-daemon|mailerdaemon|postmaster|bounces?|notifications?|notify|notifier|alerts?|newsletters?|automated|autoreply|auto[-_.]?reply|thongbao|ebanking)$/i;
const AUTO_LOCAL_JOINED = /(^|[-_.+])(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|auto[-_.]?reply)([-_.+0-9]|$)/i;
/** Transaction notices (banks, wallets) and one-time codes: never a conversation. */
const TRANSACTION_SUBJECT = /(th[oô]ng b[aá]o giao d[iị]ch|bi[eế]n đ[oộ]ng s[oố] d[uư]|transaction notification|transaction alert|\botp\b|m[aã] x[aá]c (th[uự]c|nh[aậ]n)|verification code|security code|security alert|c[aả]nh b[aá]o b[aả]o m[aậ]t)/i;

function looksAutomatedLocal(local: string): boolean {
  if (AUTO_LOCAL_JOINED.test(local)) return true;
  return local.split(/[-_.+0-9]+/).some((t) => t !== '' && AUTO_LOCAL_TOKEN.test(t));
}

/**
 * Vietnamese reason when the message looks machine-sent, else null:
 * list headers (List-Unsubscribe, List-Id), Precedence bulk/list/junk,
 * Auto-Submitted other than "no", X-Autoreply/X-Autorespond, auto-reply
 * subjects ("Auto:", "Automatic reply", "Out of office", "Trả lời tự động"),
 * no-reply style local parts (noreply, no-reply, donotreply, mailer-daemon,
 * postmaster, bounce, notifications, newsletter…) and extraPatterns.
 */
export function detectAutomated(msg: Pick<GmailMessage, 'fromEmail' | 'subject' | 'headers'>, extraPatterns: string[]): string | null {
  const h = msg.headers ?? {};
  if (h['list-unsubscribe']) return 'Thư hàng loạt (List-Unsubscribe)';
  if (h['list-id']) return 'Thư hàng loạt (List-Id)';
  if (/^(bulk|list|junk|auto_reply)$/i.test((h['precedence'] ?? '').trim())) return 'Thư hàng loạt (Precedence)';
  const autoSubmitted = (h['auto-submitted'] ?? '').trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return 'Trả lời tự động (Auto-Submitted)';
  if (h['x-autoreply'] || h['x-autorespond']) return 'Trả lời tự động (X-Autoreply)';
  if (/\b(all|oof|autoreply|dr|rn|nri)\b/i.test(h['x-auto-response-suppress'] ?? '')) return 'Thư tự động (X-Auto-Response-Suppress)';
  if (AUTO_SUBJECT.test(msg.subject ?? '') || /out of office/i.test(msg.subject ?? '')) return 'Thư báo nghỉ / trả lời tự động';
  const email = (msg.fromEmail ?? '').toLowerCase();
  const local = email.split('@')[0] ?? '';
  if (looksAutomatedLocal(local)) return 'Địa chỉ no-reply / thông báo tự động';
  if (TRANSACTION_SUBJECT.test(msg.subject ?? '')) return 'Thông báo giao dịch / mã xác thực';
  for (const p of extraPatterns ?? []) {
    const pattern = p.trim().toLowerCase();
    if (pattern && email.includes(pattern)) return `Địa chỉ trong danh sách tự động (${pattern})`;
  }
  return null;
}

// ── Composio message → GmailMessage ───────────────────────────────────

function headerMap(payload: Json | null): Map<string, string> {
  const map = new Map<string, string>();
  const list = payload && Array.isArray(payload.headers) ? payload.headers : [];
  for (const entry of list) {
    if (!isObj(entry)) continue;
    const name = str(entry.name).trim().toLowerCase();
    if (name && !map.has(name)) map.set(name, str(entry.value));
  }
  return map;
}

function decodeBase64Url(data: string): string {
  try { return Buffer.from(data, 'base64url').toString('utf8'); } catch { return ''; }
}

interface Collected { plain: string[]; html: string[]; attachments: EmailAttachmentMeta[] }

function walkParts(part: unknown, out: Collected, depth = 0): void {
  if (!isObj(part) || depth > 12) return;
  const mime = str(part.mimeType).toLowerCase();
  const filename = str(part.filename);
  const body = isObj(part.body) ? part.body : {};
  const data = str(body.data);
  const attachmentId = str(body.attachmentId);
  if (filename && attachmentId) {
    out.attachments.push({
      filename,
      mimeType: str(part.mimeType) || 'application/octet-stream',
      size: typeof body.size === 'number' ? body.size : 0,
      attachmentId,
    });
  } else if (data && mime === 'text/plain') {
    out.plain.push(decodeBase64Url(data));
  } else if (data && mime === 'text/html') {
    out.html.push(decodeBase64Url(data));
  }
  if (Array.isArray(part.parts)) for (const p of part.parts) walkParts(p, out, depth + 1);
}

function parseAttachmentList(list: unknown): EmailAttachmentMeta[] {
  if (!Array.isArray(list)) return [];
  const out: EmailAttachmentMeta[] = [];
  for (const a of list) {
    if (!isObj(a)) continue;
    const attachmentId = str(a.attachmentId) || str(a.attachment_id) || str(a.id);
    const filename = str(a.filename) || str(a.name);
    if (!attachmentId || !filename) continue;
    out.push({
      filename,
      mimeType: str(a.mimeType) || str(a.mime_type) || 'application/octet-stream',
      size: typeof a.size === 'number' ? a.size : 0,
      attachmentId,
    });
  }
  return out;
}

function sentAtOf(raw: Json, headers: Map<string, string>): number {
  const ts = Date.parse(str(raw.messageTimestamp));
  if (Number.isFinite(ts)) return ts;
  const internal = Number(raw.internalDate);
  if (Number.isFinite(internal) && internal > 0) return internal;
  const date = Date.parse(headers.get('date') ?? '');
  if (Number.isFinite(date)) return date;
  return Date.now();
}

/** Normalizes one item of GMAIL_FETCH_EMAILS / GMAIL_FETCH_MESSAGE_BY_THREAD_ID `messages`. null if unusable. */
export function normalizeGmailMessage(raw: unknown): GmailMessage | null {
  if (!isObj(raw)) return null;
  const gmailMessageId = str(raw.messageId) || str(raw.id);
  const gmailThreadId = str(raw.threadId);
  if (!gmailMessageId || !gmailThreadId) return null;

  const payload = isObj(raw.payload) ? raw.payload : null;
  const hmap = headerMap(payload);

  const from = parseAddress(hmap.get('from') ?? str(raw.sender));
  const replyTo = parseAddress(hmap.get('reply-to') ?? '').email;
  const to = parseAddressList(hmap.get('to') ?? str(raw.to));
  const cc = parseAddressList(hmap.get('cc') ?? str(raw.cc));
  const subject = hmap.get('subject') ?? str(raw.subject);

  const collected: Collected = { plain: [], html: [], attachments: [] };
  if (payload) {
    walkParts(payload, collected);
    // Single-part messages carry the body on the payload itself (walkParts handled it via its mimeType).
  }
  const htmlRaw = collected.html.join('\n');
  const plainRaw = collected.plain.join('\n');
  const messageText = str(raw.messageText);
  let bodyText = '';
  if (plainRaw.trim()) bodyText = plainRaw;
  else if (messageText.trim()) bodyText = messageText;
  else if (htmlRaw.trim()) bodyText = htmlToText(htmlRaw);
  bodyText = normalizeNewlines(bodyText).slice(0, BODY_CAP);
  const bodyHtml = htmlRaw.slice(0, BODY_CAP);

  const preview = isObj(raw.preview) ? str(raw.preview.body) : '';
  const snippet = collapse(preview || str(raw.snippet) || bodyText).slice(0, SNIPPET_CAP);

  const headers: Record<string, string> = {};
  for (const [name, value] of hmap) if (KEPT_HEADERS.has(name)) headers[name] = value.slice(0, HEADER_CAP);

  const attachments = collected.attachments.slice();
  for (const a of parseAttachmentList(raw.attachmentList)) {
    if (!attachments.some((x) => x.attachmentId === a.attachmentId)) attachments.push(a);
  }

  const internalRaw = Number(raw.internalDate);
  const internalDateMs = Number.isSafeInteger(internalRaw) && internalRaw > 0 ? internalRaw : undefined;
  const historyId = /^\d{1,30}$/.test(str(raw.historyId)) ? str(raw.historyId) : '';

  return {
    gmailMessageId,
    gmailThreadId,
    labelIds: Array.isArray(raw.labelIds) ? raw.labelIds.filter((l): l is string => typeof l === 'string') : [],
    fromEmail: from.email,
    fromName: from.name,
    replyTo,
    to,
    cc,
    subject,
    bodyText,
    bodyHtml,
    snippet,
    headers,
    attachments,
    sentAtMs: sentAtOf(raw, hmap),
    ...(internalDateMs !== undefined ? { internalDateMs } : {}),
    ...(historyId ? { historyId } : {}),
  };
}
