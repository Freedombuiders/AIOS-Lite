import { FileAudio, FileImage, FileText, FileVideo, Mic, Paperclip } from 'lucide-preact';
import { MediaImage } from './inbox/MediaImage';
import { formatBytes } from '@modules/care/web/lib/care/timeFormat';
import { ct } from '@modules/care/web/lib/care/i18n';
import type { AttachmentView } from '@modules/care/web/lib/care/messageView';

function KindIcon({ a }: { a: AttachmentView }) {
  if (a.isVoice) return <Mic size={14} aria-hidden="true" />;
  if (a.kind === 'image') return <FileImage size={14} aria-hidden="true" />;
  if (a.kind === 'video') return <FileVideo size={14} aria-hidden="true" />;
  if (a.kind === 'audio') return <FileAudio size={14} aria-hidden="true" />;
  if (a.kind === 'document') return <FileText size={14} aria-hidden="true" />;
  return <Paperclip size={14} aria-hidden="true" />;
}

function Chip({ a }: { a: AttachmentView }) {
  return (
    <li class="care-attachment" data-testid="care-attachment" data-kind={a.kind}>
      <KindIcon a={a} />
      <span class="care-attachment-name">{a.fileName || ct('msg.attachment.unnamed')}</span>
      <span class="care-faint">
        {a.isVoice ? ct('msg.attachment.voice') : ct(`msg.attachment.${a.kind}`)}
        {a.mimeType ? ` · ${a.mimeType}` : ''}
        {a.sizeBytes !== null ? ` · ${formatBytes(a.sizeBytes)}` : ''}
      </span>
      <span class="care-attachment-note">{ct('msg.attachment.metadataOnly')}</span>
    </li>
  );
}

/**
 * Attachments of one message. A Zalo image is shown from the copy the care module keeps (`/messages/:id/media`); every
 * other attachment, and an image without a copy, is a metadata chip. Provider URLs are never fetched or linked from here.
 */
export function AttachmentList({ attachments, messageId, showImages }: { attachments: AttachmentView[]; messageId?: string; showImages?: boolean }) {
  if (!attachments.length) return null;
  return (
    <ul class="care-attachments" aria-label={ct('msg.attachment.title')}>
      {attachments.map((a) => (
        showImages && messageId && a.kind === 'image' && !a.isVoice
          ? <li key={a.id} class="care-attachment-media"><MediaImage messageId={messageId} index={a.index} name={a.fileName} fallback={<ul class="care-attachments"><Chip a={a} /></ul>} /></li>
          : <Chip key={a.id} a={a} />
      ))}
    </ul>
  );
}
