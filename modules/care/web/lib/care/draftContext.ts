// Context shown next to a draft under review: the customer's latest messages.

import type { CareMessageDto } from './dto';
import { readAttachments } from './messageView';

export interface ContextMessage {
  id: string;
  text: string;
  sentAtMs: number;
  /** File names (or kinds) of attachments: the draft may be answering a picture. */
  attachments: string[];
  sticker: boolean;
}

/**
 * The customer's last `n` messages, oldest first: what the draft answers. An email without text falls back to its snippet;
 * a picture or sticker is listed as such. Deleted messages and messages with nothing to show are skipped.
 */
export function lastCustomerMessages(newestFirst: CareMessageDto[], n = 3): ContextMessage[] {
  const out: ContextMessage[] = [];
  for (const m of newestFirst) {
    if (m.senderRole !== 'customer' || m.deleted) continue;
    const meta = m.metadata ?? {};
    const snippet = typeof (meta as { snippet?: unknown }).snippet === 'string' ? (meta as { snippet: string }).snippet : '';
    const text = ((m.text ?? '').trim() || snippet.trim()).slice(0, 600);
    const attachments = readAttachments(meta).map((a) => a.fileName || a.mimeType || a.kind);
    const sticker = typeof (meta as { stickerId?: unknown }).stickerId === 'string' && Boolean((meta as { stickerId: string }).stickerId);
    if (!text && attachments.length === 0 && !sticker) continue;
    out.push({ id: m.id, text, sentAtMs: m.sentAtMs, attachments, sticker });
    if (out.length >= n) break;
  }
  return out.reverse();
}
