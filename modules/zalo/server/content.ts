/**
 * Pure helpers for Zalo message payloads (zca-js). No I/O, no imports, so the
 * DB layer, the daemon and the tests can all share them.
 *
 * Content-type detection follows ZaloCRM's zalo-message-helpers.ts: the
 * action-based checks must run before the msgType keyword checks, because
 * Zalo wraps calls, bank cards and QR codes in the same "recommended.*"
 * family that the keyword check would otherwise classify as a contact card.
 * Zalo also ships the typo "recommened", so both spellings are matched.
 */

export type ZaloContentType =
  | 'text' | 'image' | 'sticker' | 'video' | 'voice' | 'gif' | 'link'
  | 'location' | 'file' | 'contact_card' | 'bank_transfer' | 'call'
  | 'qr_code' | 'reminder' | 'poll' | 'note' | 'forwarded' | 'rich';

export interface ZaloMention {
  uid: string;
  pos: number;
  len: number;
  /** 0 = a user, 1 = @all. */
  type: 0 | 1;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function detectContentType(msgType: string | undefined, content: unknown): ZaloContentType {
  if (!msgType) return 'text';

  if (isObj(content)) {
    const action = str(content.action);
    if (action.includes('calltime') || action.includes('misscall')) return 'call';
    if (action === 'zinstant.bankcard') return 'bank_transfer';
    if (str(content.description).includes('qrCodeUrl')) return 'qr_code';
    if ((action === 'recommened.link' || action === 'recommended.link') && str(content.href).startsWith('http')) {
      return 'link';
    }
    if (content.callDuration !== undefined || content.callType !== undefined) return 'call';
  }

  if (msgType.includes('photo') || msgType.includes('image')) return 'image';
  if (msgType.includes('sticker')) return 'sticker';
  if (msgType.includes('video')) return 'video';
  if (msgType.includes('voice')) return 'voice';
  if (msgType.includes('gif')) return 'gif';
  if (msgType.includes('link')) return 'link';
  if (msgType.includes('location')) return 'location';
  if (msgType.includes('file') || msgType.includes('doc')) return 'file';
  if (msgType.includes('recommended') || msgType.includes('card')) return 'contact_card';
  if (msgType.includes('bank') || msgType.includes('transfer')) return 'bank_transfer';
  if (msgType.includes('call') || msgType.includes('voip')) return 'call';
  if (msgType.includes('qr')) return 'qr_code';
  if (msgType.includes('remind') || msgType.includes('todo')) return 'reminder';
  if (msgType.includes('poll') || msgType.includes('vote')) return 'poll';
  if (msgType.includes('note')) return 'note';
  if (msgType.includes('forward')) return 'forwarded';

  if (isObj(content)) {
    const action = str(content.action);
    if (action === 'msginfo.actionlist') return 'reminder';
    if (content.bankCode || content.bankName) return 'bank_transfer';
    if (str(content.params).includes('zinstant.bankcard')) return 'bank_transfer';
    // Link auto-unfurl: href + thumb/title with no action.
    if (str(content.href).startsWith('http') && (typeof content.thumb === 'string' || typeof content.title === 'string') && !action) {
      return 'link';
    }
    return 'rich';
  }
  return 'text';
}

/** Raw zca-js content → the string stored in the DB (JSON for objects). */
export function serializeContent(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw === undefined || raw === null) return '';
  try { return JSON.stringify(raw); } catch { return ''; }
}

function parseObj(body: string): Obj | null {
  if (!body.startsWith('{')) return null;
  try {
    const v = JSON.parse(body) as unknown;
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Mentions arrive on two channels: `data.mentions` on group messages, or a
 * JSON string under `data.propertyExt.ext` (where Zalo's server actually
 * packs them). Try both; undefined when there are none.
 */
export function extractMentions(data: unknown): ZaloMention[] | undefined {
  if (!isObj(data)) return undefined;
  const normalize = (list: unknown[]): ZaloMention[] => list
    .filter(isObj)
    .map((m) => ({
      uid: String(m.uid ?? ''),
      pos: Number(m.pos ?? 0),
      len: Number(m.len ?? 0),
      type: (m.type === 1 ? 1 : 0) as 0 | 1,
    }))
    .filter((m) => m.uid !== '' && m.len > 0);

  if (Array.isArray(data.mentions) && data.mentions.length > 0) {
    const out = normalize(data.mentions);
    return out.length > 0 ? out : undefined;
  }
  try {
    const propertyExt = isObj(data.propertyExt) ? data.propertyExt : null;
    let ext: unknown = propertyExt?.ext;
    if (typeof ext === 'string') ext = JSON.parse(ext);
    if (isObj(ext) && Array.isArray(ext.mentions) && ext.mentions.length > 0) {
      const out = normalize(ext.mentions);
      return out.length > 0 ? out : undefined;
    }
  } catch { /* malformed ext — no mentions */ }
  return undefined;
}

export interface ZaloQuote {
  ownerUid: string;
  text: string;
  senderName: string;
}

export function extractQuote(data: unknown): ZaloQuote | undefined {
  if (!isObj(data) || !isObj(data.quote)) return undefined;
  const q = data.quote;
  const ownerUid = q.ownerId !== undefined ? String(q.ownerId) : '';
  return { ownerUid, text: str(q.msg), senderName: str(q.fromD) };
}

/** Lowercase and strip Vietnamese diacritics so "bao gia" matches "báo giá". */
export function foldVietnamese(text: string): string {
  return (text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

export function matchesAnyKeyword(content: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const folded = foldVietnamese(content);
  return keywords.some((kw) => {
    const needle = foldVietnamese(kw).trim();
    return needle.length > 0 && folded.includes(needle);
  });
}

const PLACEHOLDER: Record<ZaloContentType, string> = {
  text: '',
  image: '[Ảnh]',
  sticker: '[Sticker]',
  video: '[Video]',
  voice: '[Tin nhắn thoại]',
  gif: '[GIF]',
  link: '[Link]',
  location: '[Vị trí]',
  file: '[File]',
  contact_card: '[Danh thiếp]',
  bank_transfer: '[Chuyển khoản]',
  call: '[Cuộc gọi]',
  qr_code: '[Mã QR]',
  reminder: '[Nhắc hẹn]',
  poll: '[Bình chọn]',
  note: '[Ghi chú]',
  forwarded: '[Tin chuyển tiếp]',
  rich: '[Tin đặc biệt]',
};

/**
 * One-line, human-readable rendering of a stored body — used for the thread
 * list preview, the transcript fed to agents, and search. Non-text payloads
 * become a bracketed label plus whatever title/caption/link they carry.
 */
export function renderText(contentType: string, body: string): string {
  if (contentType === 'text') return body;
  const label = PLACEHOLDER[contentType as ZaloContentType] ?? '[Tin đặc biệt]';
  const obj = parseObj(body);
  if (!obj) return body && !body.startsWith('{') ? `${label} ${body}`.trim() : label;
  const parts = [str(obj.title), str(obj.description)]
    .map((s) => s.trim())
    .filter((s) => s !== '' && !s.startsWith('{') && s.length < 300);
  if (contentType === 'link' && str(obj.href)) parts.push(str(obj.href));
  return [label, ...parts].join(' ').trim();
}

/** Best-effort media/link URL for the dashboard (Zalo CDN links expire). */
export function mediaUrl(body: string): string | null {
  const obj = parseObj(body);
  if (!obj) return null;
  for (const key of ['href', 'hdUrl', 'normalUrl', 'thumb']) {
    const v = str(obj[key]);
    if (v.startsWith('http')) return v;
  }
  return null;
}
