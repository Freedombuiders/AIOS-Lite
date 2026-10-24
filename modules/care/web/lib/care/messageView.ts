// How a stored message is presented. The DTO carries text + free-form metadata, so everything here
// is defensive: unknown shapes degrade to an explicit placeholder, never to an invented preview.

import type { CareMessageDto } from './dto';

export interface AttachmentView {
  /** Position in the message's raw `attachments` array: what `GET /messages/:id/media?i=` takes. */
  index: number;
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number | null;
  kind: 'image' | 'video' | 'audio' | 'document' | 'other';
  isVoice: boolean;
}

export type Placeholder =
  /** Provider deleted/edited-away the message. */
  | 'deleted'
  /** Sticker, reaction, poll, location... something the Care timeline cannot render yet. */
  | 'unsupported'
  /** Neither text nor attachments. */
  | 'empty';

export interface MessageView {
  isEmail: boolean;
  text: string;
  attachments: AttachmentView[];
  /** Why the body is replaced by an explicit note (null: render the text). */
  placeholder: Placeholder | null;
  /** Label of the unsupported thing (e.g. "sticker") for the placeholder copy. */
  unsupportedLabel: string | null;
  /** Telegram media that exists at the source but is not exported (protected / not downloadable): a labelled note. */
  unexportedMedia: { kind: 'photo' | 'document'; reason: 'restricted' | 'unsupported' } | null;
}

export function attachmentKind(mime: string): AttachmentView['kind'] {
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('application/') || m.startsWith('text/')) return 'document';
  return 'other';
}

export function readAttachments(metadata: Record<string, unknown>): AttachmentView[] {
  const raw = metadata.attachments;
  if (!Array.isArray(raw)) return [];
  const out: AttachmentView[] = [];
  for (const [index, a] of raw.entries()) {
    if (!a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    const mimeType = typeof r.mimeType === 'string' ? r.mimeType : '';
    out.push({
      index,
      id: typeof r.id === 'string' ? r.id : String(out.length),
      fileName: typeof r.fileName === 'string' && r.fileName ? r.fileName : '',
      mimeType,
      sizeBytes: typeof r.sizeBytes === 'number' && Number.isFinite(r.sizeBytes) ? r.sizeBytes : null,
      kind: attachmentKind(mimeType),
      isVoice: r.isVoice === true,
    });
  }
  return out;
}

function flag(meta: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((k) => meta[k] === true);
}

function readUnexportedMedia(meta: Record<string, unknown>): MessageView['unexportedMedia'] {
  const raw = meta.unexportedMedia;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    kind: r.kind === 'photo' ? 'photo' : 'document',
    reason: r.reason === 'restricted' ? 'restricted' : 'unsupported',
  };
}

export function describeMessage(m: CareMessageDto): MessageView {
  const meta = m.metadata ?? {};
  const isEmail = meta.type === 'email';
  const attachments = readAttachments(meta);
  const text = typeof m.text === 'string' ? m.text : '';
  const unexportedMedia = readUnexportedMedia(meta);
  const base = { isEmail, text, attachments, unexportedMedia };

  // A tombstone (deleted at the source) keeps its place but never shows text, attachments or media.
  if (m.deleted === true || flag(meta, 'tombstone', 'isDeleted', 'deleted', 'recalled', 'revoked')) {
    return { ...base, text: '', attachments: [], unexportedMedia: null, placeholder: 'deleted', unsupportedLabel: null };
  }
  if (!isEmail && typeof meta.stickerId === 'string' && meta.stickerId && !text.trim()) {
    return { ...base, placeholder: 'unsupported', unsupportedLabel: 'sticker' };
  }
  if (!text.trim() && attachments.length === 0 && !unexportedMedia) {
    const html = isEmail && typeof meta.bodyHtml === 'string' && meta.bodyHtml.trim();
    const snippet = isEmail && typeof meta.snippet === 'string' && meta.snippet.trim();
    if (!html && !snippet) return { ...base, placeholder: isEmail ? 'empty' : 'unsupported', unsupportedLabel: null };
  }
  return { ...base, placeholder: null, unsupportedLabel: null };
}

export type BubbleSide = 'incoming' | 'outgoing' | 'system';

export function bubbleSide(m: Pick<CareMessageDto, 'senderRole'>): BubbleSide {
  if (m.senderRole === 'customer') return 'incoming';
  if (m.senderRole === 'system') return 'system';
  return 'outgoing';
}

/** Collapses the timeline into day buckets (oldest first) for date separators. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
