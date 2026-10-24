/**
 * Pure text heuristics used by the Care message gates and context builder. They port the INTENT
 * of the legacy Zalo/Email gates (src/zalo/{gate,limits,content}.ts, src/email/{gate,parse}.ts)
 * without importing them, so the Care policy keeps working after the legacy modules go away.
 */

/** Lower-case, strip combining marks, đ -> d. Used for diacritic-insensitive matching. */
export function foldVietnamese(text: string): string {
  return (text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

export function matchesAnyKeyword(content: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return false;
  const folded = foldVietnamese(content);
  return keywords.some((kw) => {
    const needle = foldVietnamese(kw).trim();
    return needle.length > 0 && folded.includes(needle);
  });
}

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/**
 * First keyword found in the text (diacritic- and case-insensitive) or null. The match must
 * start at a word boundary ("refund" matches "refunded", "tien" does not match "chuyentien").
 */
export function matchKeywordAtWordStart(text: string, keywords: readonly string[]): string | null {
  const folded = foldVietnamese(text);
  for (const kw of keywords) {
    const needle = foldVietnamese(kw).trim();
    if (!needle) continue;
    let from = 0;
    for (;;) {
      const at = folded.indexOf(needle, from);
      if (at < 0) break;
      if (!isWordChar(folded[at - 1])) return kw.trim();
      from = at + 1;
    }
  }
  return null;
}

// ── Chat (Zalo-style) ──────────────────────────────────────────────────────────────────────

// Compared after folding: ừ->u, ờ->o, à/ạ->a, vâng->vang, dạ->da.
const CHAT_NOISE_RE = /^(ok|oke|okie|okay|uhm|u|um|o|a|vang|da|tks|thanks|👍[\u{1F3FB}-\u{1F3FF}]?|❤️?)[\s!.]*$/u;

/** A bare acknowledgement ("ok", "dạ", "👍") that needs no reply. */
export function isChatNoise(text: string): boolean {
  const t = foldVietnamese(text.normalize('NFC')).trim();
  return t !== '' && CHAT_NOISE_RE.test(t);
}

const CHAT_OPT_OUT_ACCENTED = ['đừng nhắn', 'không nhắn nữa', 'không muốn nhận', 'hủy đăng ký', 'huỷ đăng ký', 'đừng làm phiền'];
const CHAT_OPT_OUT_FOLDED = ['dung nhan', 'khong nhan nua', 'khong muon nhan', 'huy dang ky', 'dung lam phien', 'unsubscribe'];

/**
 * The customer asks to stop receiving messages. Accented text is matched against accented
 * phrases so "đúng, nhận được rồi" never counts as "đừng nhắn"; only text typed without any
 * diacritics falls back to folded matching.
 */
export function isChatOptOut(text: string): boolean {
  const nfc = text.normalize('NFC').toLowerCase();
  const folded = foldVietnamese(nfc);
  if (/\bstop\b/.test(folded) || folded.includes('unsubscribe')) return true;
  if (CHAT_OPT_OUT_ACCENTED.some((p) => nfc.includes(p))) return true;
  return folded === nfc && CHAT_OPT_OUT_FOLDED.some((p) => folded.includes(p));
}

// ── Email ────────────────────────────────────────────────────────────────────────────────────

const WROTE_END = /(wrote|đã viết|đã gửi|a écrit|schrieb)\s*:\s*$/i;
const WROTE_START = /^\s*(on|vào|ngày|trong ngày|le|am)\b/i;
const ORIGINAL_MSG = /^\s*-{2,}\s*(original message|original|thư gốc|tin nhắn gốc|thư trả lời|reply message)\s*-{2,}\s*$/i;
const UNDERSCORE_RULE = /^\s*_{10,}\s*$/;
const FROM_LINE = /^\s*\*?(from|từ|von|de)\*?\s*:/i;
const SENT_LINE = /^\s*\*?(sent|date|đã gửi|gửi lúc|ngày gửi|ngày|gesendet)\*?\s*:/i;

/**
 * Drops the quoted history of an email reply ("On ... wrote:", "> quoted", "-----Original
 * Message-----", "From: ... Sent: ...") and keeps the new text. Quoted history never becomes a
 * trigger or an instruction.
 */
export function stripQuotedReply(text: string): string {
  const original = (text ?? '').replace(/\r\n?/g, '\n').trim();
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
    const joined = WROTE_START.test(line) && !WROTE_END.test(line) && i + 1 < lines.length ? `${line.trim()} ${lines[i + 1].trim()}` : line.trim();
    if (joined.length <= 400 && WROTE_END.test(joined) && (WROTE_START.test(joined) || joined.includes('@'))) { cut = i; break; }
    if (ORIGINAL_MSG.test(line)) { cut = i; break; }
    if (UNDERSCORE_RULE.test(line) && nextNonEmpty(i + 1, 1).some((l) => FROM_LINE.test(l))) { cut = i; break; }
    if (FROM_LINE.test(line) && lines.slice(i + 1, i + 7).some((l) => SENT_LINE.test(l))) { cut = i; break; }
  }
  const kept = lines.slice(0, cut);
  while (kept.length) {
    const last = kept[kept.length - 1].trim();
    if (!last || last.startsWith('>')) kept.pop();
    else break;
  }
  return kept.join('\n').trim() || original;
}

const EMAIL_OPT_OUT_RE = new RegExp([
  'unsubscribe',
  'huy dang ky',
  'ngung gui',
  'dung gui( email| mail| thu)? nua',
  'khong muon nhan( email| mail| thu)',
  'remove me from',
  'stop emailing',
  'stop sending',
].join('|'));
const EMAIL_OPT_OUT_WINDOW = 500;
// "Unsubscribe | Manage preferences", "Unsubscribe: https://...": a mail footer, not the customer.
const FOOTER_LINE_RE = /https?:\/\/|\||<[^>]*>|manage (your )?(email )?preferences|update (your )?preferences|view (this )?(email )?in (your )?browser/i;

/** An unsubscribe / "đừng gửi nữa" request in the customer's NEW text (footers ignored). */
export function isEmailOptOut(text: string): boolean {
  const head = (text || '').slice(0, EMAIL_OPT_OUT_WINDOW)
    .split(/\r?\n/)
    .filter((line) => !FOOTER_LINE_RE.test(line))
    .join('\n');
  return EMAIL_OPT_OUT_RE.test(foldVietnamese(head));
}

const NOISE_MAX_CHARS = 60;
const ACK_TOKENS = new Set(['cam', 'thanks', 'thank', 'thx', 'ty', 'ok', 'okay', 'oke', 'da', 'vang', 'noted', 'nhan', 'received', 'got', '👍']);
const FILLER_TOKENS = new Set([
  'on', 'anh', 'chi', 'em', 'ban', 'shop', 'nhe', 'nha', 'a', 'ah', 'nhieu', 'rat', 'xin', 'so', 'much', 'very', 'many',
  'for', 'your', 'email', 'mail', 'thu', 'you', 'it', 'duoc', 'roi', 'hi', 'chao', 'dear', 'best', 'regards', 'tran',
  'trong', 'again', 'help', '🙏',
]);

/** Only a thank-you / acknowledgement ("Cảm ơn shop", "Thanks!", 👍). A question or any other word makes it real. */
export function isEmailNoise(text: string): boolean {
  const raw = (text || '').trim();
  if (raw === '' || raw.length > NOISE_MAX_CHARS || /[?？]/.test(raw)) return false;
  const tokens = foldVietnamese(raw.normalize('NFC'))
    .replace(/👍/gu, ' 👍 ')
    .replace(/🙏/gu, ' 🙏 ')
    .replace(/[^\p{L}\p{N}\s👍🙏]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.some((t) => ACK_TOKENS.has(t)) && tokens.every((t) => ACK_TOKENS.has(t) || FILLER_TOKENS.has(t));
}

const AUTO_SUBJECT = /^\s*(auto:|auto[- ]?(reply|response)|automatic reply|autoreply|out of office|trả lời tự động|tự động trả lời|thư trả lời tự động|undeliverable|delivery status notification|mail delivery)/i;
const AUTO_LOCAL_TOKEN = /^(no[-_.]?reply|noreply|donotreply|mailer-daemon|mailerdaemon|postmaster|bounces?|notifications?|notify|notifier|alerts?|newsletters?|automated|autoreply|auto[-_.]?reply|thongbao|ebanking)$/i;
const AUTO_LOCAL_JOINED = /(^|[-_.+])(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|auto[-_.]?reply)([-_.+0-9]|$)/i;
const TRANSACTION_SUBJECT = /(th[oô]ng b[aá]o giao d[iị]ch|bi[eế]n đ[oộ]ng s[oố] d[uư]|transaction notification|transaction alert|\botp\b|m[aã] x[aá]c (th[uự]c|nh[aậ]n)|verification code|security code|security alert|c[aả]nh b[aá]o b[aả]o m[aậ]t)/i;

export function looksAutomatedLocalPart(local: string): boolean {
  if (AUTO_LOCAL_JOINED.test(local)) return true;
  return local.split(/[-_.+0-9]+/).some((t) => t !== '' && AUTO_LOCAL_TOKEN.test(t));
}

/**
 * A short machine-readable reason when the mail looks machine-sent (list headers, Precedence,
 * Auto-Submitted, auto-reply subjects, no-reply senders, transaction notices, operator-listed
 * patterns), else null. Headers are matched case-insensitively.
 */
export function detectAutomatedMail(
  msg: { from: string; subject: string; headers?: Record<string, string> },
  extraPatterns: readonly string[] = [],
): string | null {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(msg.headers ?? {})) h[k.toLowerCase()] = String(v);
  if (h['list-unsubscribe']) return 'list_unsubscribe';
  if (h['list-id']) return 'list_id';
  if (/^(bulk|list|junk|auto_reply)$/i.test((h['precedence'] ?? '').trim())) return 'precedence_bulk';
  const autoSubmitted = (h['auto-submitted'] ?? '').trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return 'auto_submitted';
  if (h['x-autoreply'] || h['x-autorespond']) return 'x_autoreply';
  if (/\b(all|oof|autoreply|dr|rn|nri)\b/i.test(h['x-auto-response-suppress'] ?? '')) return 'auto_response_suppress';
  if (AUTO_SUBJECT.test(msg.subject ?? '') || /out of office/i.test(msg.subject ?? '')) return 'auto_reply_subject';
  const email = (msg.from ?? '').toLowerCase();
  if (looksAutomatedLocalPart(email.split('@')[0] ?? '')) return 'no_reply_sender';
  if (TRANSACTION_SUBJECT.test(msg.subject ?? '')) return 'transaction_notice';
  for (const p of extraPatterns) {
    const pattern = p.trim().toLowerCase();
    if (pattern && email.includes(pattern)) return 'listed_pattern';
  }
  return null;
}

/**
 * Neutralises anything that could close or open an `<untrusted>` block from inside customer
 * text (any case, any whitespace between `<` / `/` / the tag name). The tag opener is replaced
 * with a look-alike so the text stays readable but can never be parsed as markup of ours.
 */
export function neutralizeUntrustedMarkup(text: string): string {
  return text.replace(/<(\s*\/?\s*untrusted)/gi, '‹$1');
}
