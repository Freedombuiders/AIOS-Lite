// Side sheet for one calendar item: details, the Facebook link, reschedule,
// and delete (schedule or remote post) with an inline confirm.

import { PlatformBadge } from '@/components/social/PlatformBadge';
import { platformMeta } from '@/lib/social-platforms';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { X } from 'lucide-preact';
import { FormatChip, StatusPill } from '@modules/marketing/web/components/fb/common';
import {
  apiFail, BTN, BTN_DANGER, BTN_PRIMARY, fmtDayLong, fromLocalInput, INPUT, InlineError, toLocalInput,
} from '@modules/marketing/web/components/fb/ops-shared';
import { apiPatch, apiPost } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import { fmtCompact, fmtPct, type FbContentDto, type FbFormat } from '@modules/marketing/web/lib/fbstudio';

const MEDIA_NOTE: Record<FbFormat, string> = {
  reel: 'Video dọc, đăng như video thường',
  video: 'Video ngang',
  photo: '1 ảnh',
  album: 'Nhiều ảnh',
  text: 'Không có media',
  link: 'Bài kèm link',
};

function mediaLine(c: FbContentDto): string {
  if (c.media.length === 0) return MEDIA_NOTE[c.format];
  const v = c.media.filter((m) => m.kind === 'video');
  if (v.length > 0) {
    const d = v[0]!.durationS;
    return `Video${d ? ` · ${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, '0')}` : ''}`;
  }
  return `${c.media.length} ảnh`;
}

export function PostSheet({ item, onClose, onChanged }: {
  item: FbContentDto;
  onClose: () => void;
  /** Refetch the month. */
  onChanged: () => void;
}) {
  const posted = item.status === 'published';
  const live = item.status === 'publishing';
  const when = (posted ? item.publishedAt : item.scheduledAt) ?? item.scheduledAt;
  const ref = useRef<HTMLElement>(null);

  const [confirming, setConfirming] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveTo, setMoveTo] = useState(toLocalInput(item.scheduledAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Close on Escape, keep Tab inside the sheet, restore focus afterwards.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab' || !ref.current) return;
      const controls = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const oldTime = item.scheduledAt;
  const deleteLabel = posted ? 'Xóa bài khỏi Facebook' : 'Xóa lịch đăng';

  async function remove() {
    setBusy(true);
    setError('');
    try {
      if (posted) {
        await apiPost(`/api/m/marketing/content/${item.id}/delete-remote`);
        pushToast({ tone: 'success', title: `Đã xóa khỏi Facebook: ${item.title}` });
      } else {
        // 'scheduled' goes back to Đã duyệt; other states just lose their time slot.
        const prevAt = item.scheduledAt;
        if (item.status === 'scheduled') await apiPost(`/api/m/marketing/content/${item.id}/unschedule`);
        else await apiPatch(`/api/m/marketing/content/${item.id}`, { scheduledAt: null });
        const canUndo = prevAt !== null && prevAt > Date.now() / 1000;
        pushToast({
          tone: 'info',
          title: `Đã xóa lịch: ${item.title}`,
          ttlMs: 8000,
          action: canUndo
            ? {
                label: 'Hoàn tác',
                onClick: async () => {
                  try {
                    await apiPatch(`/api/m/marketing/content/${item.id}`, { scheduledAt: prevAt });
                    pushToast({ tone: 'success', title: 'Đã khôi phục lịch đăng' });
                    onChanged();
                  } catch (e) {
                    pushToast({ tone: 'error', title: 'Không hoàn tác được', description: apiFail(e).message });
                  }
                },
              }
            : undefined,
        });
      }
      onChanged();
      onClose();
    } catch (err) {
      setError(apiFail(err).message);
      setBusy(false);
    }
  }

  async function move() {
    const sec = fromLocalInput(moveTo);
    if (!sec) return;
    setBusy(true);
    setError('');
    try {
      await apiPatch(`/api/m/marketing/content/${item.id}`, { scheduledAt: sec });
      pushToast({ tone: 'success', title: 'Đã dời giờ đăng' });
      onChanged();
      onClose();
    } catch (err) {
      // 409 carries the Page rule that blocked it (max per day, min gap, window).
      setError(apiFail(err).message);
      setBusy(false);
    }
  }

  return (
    <div class="fixed inset-0 z-30 flex justify-end bg-black/35">
      <button type="button" aria-label="Đóng chi tiết" tabIndex={-1} onClick={onClose} class="flex-1 border-0 bg-transparent cursor-default" />
      <section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fb-cal-sheet-title"
        class="flex-[0_1_440px] min-w-0 max-w-full w-[440px] h-full overflow-y-auto box-border p-5 bg-[var(--color-sidebar)] border-l border-[var(--color-border-strong)] flex flex-col gap-4"
      >
        <div class="flex items-center gap-2">
          <FormatChip format={item.format} />
          <StatusPill status={item.status} />
          <button
            type="button"
            aria-label="Đóng"
            onClick={onClose}
            class="ml-auto w-9 h-9 inline-flex items-center justify-center rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-card)] hover:bg-[var(--color-control-hover)]"
          >
            <X size={16} />
          </button>
        </div>

        <h2 id="fb-cal-sheet-title" class="m-0 text-[18px] font-semibold leading-snug text-[var(--color-text)]">{item.title || '(chưa có tiêu đề)'}</h2>

        <dl class="m-0 grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-[13px]">
          <dt class="text-[var(--color-text-muted)]">Nền tảng</dt><dd class="m-0 inline-flex items-center gap-2 text-[14px] font-semibold"><PlatformBadge platform={item.platform} size={32} />{platformMeta(item.platform).name}</dd>
          <dt class="text-[var(--color-text-muted)]">Page</dt><dd class="m-0">{item.pageName ?? '–'}</dd>
          <dt class="text-[var(--color-text-muted)]">Giờ đăng</dt><dd class="m-0">{when ? fmtDayLong(when) : 'Chưa xếp'}</dd>
          <dt class="text-[var(--color-text-muted)]">Tuyến content</dt><dd class="m-0">{item.pillar || '–'}</dd>
          <dt class="text-[var(--color-text-muted)]">Agent tạo</dt>
          <dd class="m-0 font-mono text-[12.5px]">{item.source === 'user' ? 'Bạn' : item.source}</dd>
          <dt class="text-[var(--color-text-muted)]">Media</dt><dd class="m-0">{mediaLine(item)}</dd>
        </dl>

        <div class="flex flex-col gap-1.5">
          <div class="text-[12px] font-semibold text-[var(--color-text-muted)]">Nội dung bài</div>
          <div class="p-3 rounded-lg bg-[var(--color-card)] text-[13.5px] leading-relaxed whitespace-pre-line break-words">
            {item.caption || <span class="text-[var(--color-text-faint)]">Chưa có caption.</span>}
          </div>
        </div>

        <div class="flex flex-col gap-1.5 p-3 rounded-lg border border-[var(--color-border)]">
          <div class="text-[12px] font-semibold text-[var(--color-text-muted)]">Bài trên Facebook</div>
          {posted && item.permalink ? (
            <>
              <a href={item.permalink} target="_blank" rel="noopener noreferrer" class="text-[13.5px] font-semibold text-[var(--color-accent)] underline">
                Mở bài trên Facebook ↗
              </a>
              <div class="font-mono text-[12px] text-[var(--color-text-faint)] break-all">{item.permalink.replace(/^https?:\/\//, '')}</div>
              <div class="grid grid-cols-3 gap-2 mt-1.5">
                {[
                  ['Reach', fmtCompact(item.metrics?.reach)],
                  ['ER', fmtPct(item.metrics?.er)],
                  ['Comment', fmtCompact(item.metrics?.comments)],
                ].map(([k, v]) => (
                  <div key={k} class="p-2 rounded-md bg-[var(--color-bg)]">
                    <div class="text-[11.5px] text-[var(--color-text-muted)]">{k}</div>
                    <div class="text-[14px] font-semibold tabular-nums">{v}</div>
                  </div>
                ))}
              </div>
              {!item.metrics && <div class="text-[12px] text-[var(--color-text-faint)]">Chưa có số liệu: trình thu số liệu chưa chạy cho bài này.</div>}
            </>
          ) : posted ? (
            <div class="text-[13px] text-[var(--color-text-muted)]">Bài đã đăng nhưng chưa lưu được đường dẫn.</div>
          ) : (
            <div class="text-[13px] text-[var(--color-text-muted)]">
              {item.status === 'missed' && 'Chưa đăng vì app tắt quá thời gian ân hạn. Bấm Dời giờ để xếp lại.'}
              {item.status === 'failed' && `Đăng lỗi${item.lastError ? `: ${item.lastError}` : '.'} Mở trong Kho để đăng lại.`}
              {item.status === 'review' && 'Đang chờ bạn duyệt. Publisher chỉ đăng sau khi bạn bấm Duyệt trong Kho.'}
              {item.status === 'publishing' && 'Đang đăng lên Facebook…'}
              {(item.status === 'scheduled' || item.status === 'approved') && (when
                ? `Link bài có sau khi Publisher đăng lúc ${fmtDayLong(when)}.`
                : 'Bài đã duyệt nhưng chưa có giờ đăng.')}
            </div>
          )}
        </div>

        {confirming && (
          <div role="alert" class="p-3 rounded-lg border border-[color-mix(in_srgb,var(--color-status-failed)_50%,transparent)] bg-[color-mix(in_srgb,var(--color-status-failed)_8%,transparent)] flex flex-col gap-2.5">
            <div class="text-[13px] leading-relaxed">
              {posted
                ? 'Xóa bài này khỏi Page trên Facebook? Không hoàn tác được. Số liệu đã thu vẫn giữ trong dashboard.'
                : `Xóa lịch${when ? ` ${fmtDayLong(when)}` : ''}? Bài vẫn nằm trong Kho${item.status === 'scheduled' ? ' ở trạng thái Đã duyệt' : ''}.`}
            </div>
            <div class="flex gap-2">
              <button type="button" class={`${BTN} flex-1 h-10`} onClick={() => setConfirming(false)} disabled={busy}>Hủy</button>
              <button
                type="button"
                class="flex-1 h-10 rounded-md bg-[#d03b3b] text-white text-[13px] font-semibold hover:opacity-90 disabled:opacity-50"
                onClick={() => void remove()}
                disabled={busy}
              >
                {busy ? 'Đang xóa…' : deleteLabel}
              </button>
            </div>
          </div>
        )}

        {moving && !posted && (
          <div class="p-3 rounded-lg border border-[var(--color-border-strong)] flex flex-col gap-2">
            <label class="flex flex-col gap-1.5 text-[12px] text-[var(--color-text-muted)]">
              Giờ đăng mới (giờ trên máy bạn)
              <input type="datetime-local" class={INPUT} value={moveTo} onInput={(e) => setMoveTo((e.target as HTMLInputElement).value)} />
            </label>
            <div class="flex justify-end gap-2">
              <button type="button" class={BTN} onClick={() => setMoving(false)} disabled={busy}>Hủy</button>
              <button type="button" class={BTN_PRIMARY} onClick={() => void move()} disabled={busy || !fromLocalInput(moveTo)}>Lưu giờ mới</button>
            </div>
          </div>
        )}

        {error && <InlineError>{error}</InlineError>}

        <div class="flex flex-wrap gap-2 mt-auto">
          <Link href={`/m/marketing/library?id=${item.id}`} class={BTN}>Mở trong Kho</Link>
          {!posted && !live && (
            <button type="button" class={BTN} aria-expanded={moving} onClick={() => { setMoving((v) => !v); setConfirming(false); }}>Dời giờ</button>
          )}
          {!live && (
            <button type="button" class={`${BTN_DANGER} ml-auto`} onClick={() => { setConfirming(true); setMoving(false); }} disabled={confirming}>
              {deleteLabel}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
