import { useState } from 'preact/hooks';
import { ExternalLink, Globe, ImageOff } from 'lucide-preact';
import { FormatChip, StatusPill } from '@modules/marketing/web/components/fb/common';
import { BTN_SM } from '@modules/marketing/web/components/fb/ops-shared';
import { fmtCompact, fmtPct, fmtSlot, type FbContentDto, type FbMedia } from '@modules/marketing/web/lib/fbstudio';

function MediaPreview({ contentId, media, index, title, facebookUrl }: { contentId: number; media: FbMedia; index: number; title: string; facebookUrl?: string }) {
  const [failed, setFailed] = useState(false);
  const src = `/api/m/marketing/content/${contentId}/media/${index}`;
  if (failed) {
    return (
      <div class="flex min-h-48 flex-col items-center justify-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
        <span class="flex items-center gap-2"><ImageOff size={18} /> {facebookUrl ? 'Tệp gốc không còn trên máy' : 'Không tải được media'}</span>
        {facebookUrl && (
          <a href={facebookUrl} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-[12.5px] text-[var(--color-accent)] hover:underline">
            Xem trên Facebook <ExternalLink size={12} />
          </a>
        )}
      </div>
    );
  }
  return media.kind === 'video' ? (
    <video src={src} controls playsInline preload="metadata" aria-label={`Video: ${title}`} onError={() => setFailed(true)} class="block w-full max-h-[480px] bg-black object-contain" />
  ) : (
    <img src={src} alt={title || `Ảnh ${index + 1}`} loading="lazy" onError={() => setFailed(true)} class="block w-full h-full max-h-[480px] object-contain" />
  );
}

export function ContentCard({ c, pictureUrl, checked, onCheck, onOpen, onRepublish }: {
  c: FbContentDto; pictureUrl?: string; checked: boolean;
  onCheck: (on: boolean) => void; onOpen: () => void; onRepublish: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [allMedia, setAllMedia] = useState(false);
  const video = c.format === 'reel' || c.format === 'video';
  const facebookUrl = /^https:\/\/(?:www\.|m\.|web\.)?facebook\.com\//i.test(c.permalink) ? c.permalink : '';
  const embedded = !c.media.length && c.origin === 'imported' && c.format !== 'text' && !!facebookUrl;
  const embedUrl = embedded ? `https://www.facebook.com/plugins/${video ? 'video' : 'post'}.php?${new URLSearchParams({ href: facebookUrl, show_text: 'false', width: '500' })}` : '';
  const media = allMedia ? c.media : c.media.slice(0, 4);
  const timestamp = c.publishedAt ?? c.scheduledAt ?? c.createdAt;
  const problem = c.status === 'failed' || c.status === 'missed';

  return (
    <article aria-label={c.title || 'Bài đăng chưa có tiêu đề'} class={`min-w-0 overflow-hidden rounded-xl border bg-[var(--color-card)] shadow-sm ${checked ? 'border-[var(--color-accent)] ring-1 ring-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
      <div class="flex items-center gap-2.5 p-3.5">
        {pictureUrl && !avatarFailed ? <img src={pictureUrl} alt="" onError={() => setAvatarFailed(true)} class="h-10 w-10 shrink-0 rounded-full object-cover" /> : <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-soft)] font-semibold text-[var(--color-accent)]" aria-hidden="true">{(c.pageName || 'Page').slice(0, 1)}</span>}
        <div class="min-w-0 flex-1">
          <div class="truncate text-[13px] font-semibold">{c.pageName || 'Chưa gán Page'}</div>
          <div class="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">{fmtSlot(timestamp)} · <Globe size={11} aria-label="Bài đăng Facebook" /></div>
        </div>
        <input type="checkbox" checked={checked} aria-label={`Chọn: ${c.title}`} class="h-4 w-4 shrink-0 accent-[var(--color-accent)]" onChange={(e) => onCheck((e.target as HTMLInputElement).checked)} />
      </div>
      <div class="px-3.5 pb-3 text-[13px] leading-relaxed">
        <p class={`m-0 whitespace-pre-wrap break-words ${expanded ? '' : 'line-clamp-4'}`}>{c.caption || c.title || '(chưa có nội dung)'}</p>
        {(c.caption.length > 180 || c.caption.split('\n').length > 4) && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} class="mt-1 font-semibold text-[var(--color-text-muted)] hover:underline">{expanded ? 'Thu gọn' : 'Xem thêm'}</button>}
      </div>
      {media.length > 0 && <div class={`bg-[var(--color-elevated)] ${media.length > 1 ? 'grid grid-cols-2 gap-0.5' : ''}`}>
        {media.map((m, i) => <div key={`${m.path}-${i}`} class={`relative min-w-0 ${media.length > 1 ? 'aspect-square overflow-hidden' : ''}`}>
          <MediaPreview contentId={c.id} media={m} index={i} title={c.title} facebookUrl={c.status === 'published' ? facebookUrl : undefined} />
          {!allMedia && i === 3 && c.media.length > 4 && <button type="button" class="absolute inset-0 bg-black/60 text-3xl font-semibold text-white" onClick={() => setAllMedia(true)} aria-label={`Xem tất cả ${c.media.length} media`}>+{c.media.length - 4}</button>}
        </div>)}
      </div>}
      {embedded && <div class="bg-white">
        <iframe src={embedUrl} title={`Preview Facebook: ${c.title}`} loading="lazy" allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" class={`block w-full border-0 ${video ? 'h-[460px]' : 'h-[400px]'}`} />
        <p class="m-0 px-3 py-2 text-[11px] text-gray-500">Preview do Facebook cung cấp. Nếu không hiển thị, mở bài trên Facebook bên dưới.</p>
      </div>}
      {!media.length && !embedded && c.format !== 'text' && c.format !== 'link' && <div class="flex min-h-40 items-center justify-center gap-2 bg-[var(--color-elevated)] text-[12px] text-[var(--color-text-muted)]"><ImageOff size={18} /> Chưa có media preview</div>}
      {c.linkUrl && /^https?:\/\//i.test(c.linkUrl) && <a href={c.linkUrl} target="_blank" rel="noopener noreferrer" class="block truncate border-t border-[var(--color-border)] bg-[var(--color-elevated)] px-3.5 py-3 text-[12px] text-[var(--color-accent)] hover:underline">{c.linkUrl}</a>}
      <div class="flex flex-col gap-2.5 p-3.5 border-t border-[var(--color-border)]">
        <div class="flex flex-wrap items-center gap-2"><StatusPill status={c.status} /><FormatChip format={c.format} />{c.pillar && <span class="text-[11px] text-[var(--color-text-muted)]">{c.pillar}</span>}</div>
        {c.metrics && <div class="text-[12px] text-[var(--color-text-muted)]">Reach {fmtCompact(c.metrics.reach)} · ER {fmtPct(c.metrics.er)}{c.metrics.comments !== null ? ` · ${fmtCompact(c.metrics.comments)} bình luận` : ''}</div>}
        {problem && c.lastError && <p class="m-0 break-words text-[12px] text-[var(--color-status-failed)]">{c.lastError}</p>}
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" class={BTN_SM} onClick={onOpen}>Xem chi tiết</button>
          {problem && <button type="button" class={BTN_SM} onClick={onRepublish}>Đăng lại</button>}
          <span class="ml-auto inline-flex items-center gap-3">
            {facebookUrl && <a href={facebookUrl} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-[12px] text-[var(--color-accent)] hover:underline">Facebook <ExternalLink size={12} /></a>}
          </span>
        </div>
      </div>
    </article>
  );
}
