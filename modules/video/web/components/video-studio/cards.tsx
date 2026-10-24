// Inline cards shown in the chat thread: source video, edit plan awaiting approval, final result.
import { useState } from 'preact/hooks';
import { Check, Copy, Download, MessageSquareWarning, Play, Scissors, Send, X } from 'lucide-preact';
import { pushToast } from '@/lib/toasts';
import { errorMessage, mediaUrl, videoEditApi } from '@modules/video/web/lib/video-edit/api';
import { patchPlan } from '@modules/video/web/lib/video-edit/editor';
import { formatBytes, formatClock, formatRange, formatSecs } from '@modules/video/web/lib/video-edit/format';
import { wordsInRange } from '@modules/video/web/lib/video-edit/plan-geometry';
import { decidePlan, openEditor, patchProject, previewKind, rightOpen, rightTab, styleById } from '@modules/video/web/lib/video-edit/studio';
import type { EditPlan, QuickFeedback, RemovedKind, Transcript, VideoProject } from '@modules/video/web/lib/video-edit/types';

export const REMOVED_LABEL: Record<RemovedKind, string> = {
  silence: 'Chỗ lặng', filler: 'Từ đệm', retake: 'Nói lại', offtopic: 'Lạc đề',
};

export function SourceVideoCard({ project }: { project: VideoProject }) {
  const s = project.source;
  if (!s) return null;
  const rotated = s.rotation === 90 || s.rotation === 270;
  const w = rotated ? s.height : s.width;
  const h = rotated ? s.width : s.height;
  return (
    <article class="vs-card" aria-label="Video gốc">
      <button
        type="button"
        class="vs-card-thumb"
        aria-label="Xem video gốc"
        onClick={() => { previewKind.value = 'source'; rightTab.value = 'preview'; rightOpen.value = true; }}
      >
        <img src={mediaUrl(project.id, 'thumb', s.sizeBytes)} alt="" loading="lazy" />
        <span class="vs-card-play" aria-hidden="true"><Play size={18} fill="currentColor" /></span>
      </button>
      <div class="vs-card-body">
        <div class="vs-eyebrow">Video gốc</div>
        <div class="vs-card-title" title={s.fileName}>{s.fileName}</div>
        <div class="vs-card-meta">
          <span>{formatClock(s.durationSec)}</span>
          <span>{w}×{h}</span>
          <span>{Math.round(s.fps * 10) / 10} fps</span>
          <span>{formatBytes(s.sizeBytes)}</span>
        </div>
      </div>
    </article>
  );
}

const PLAN_STATUS_LABEL: Record<NonNullable<VideoProject['planStatus']>, string> = {
  draft: 'Đang sửa', waiting_approval: 'Chờ bạn duyệt', approved: 'Đã duyệt', rejected: 'Đã huỷ',
};

export function PlanCard({ project, plan }: { project: VideoProject; plan: EditPlan }) {
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const style = styleById(plan.styleId);
  const groups = (Object.keys(REMOVED_LABEL) as RemovedKind[]).map((kind) => {
    const items = plan.removed.filter((r) => r.kind === kind);
    return { kind, count: items.length, secs: items.reduce((a, r) => a + (r.end - r.start), 0) };
  }).filter((g) => g.count > 0);
  const act = async (action: 'approve' | 'revise' | 'reject') => {
    setBusy(true);
    try { await decidePlan(action, action === 'revise' ? note.trim() || undefined : undefined); }
    finally { setBusy(false); setRevising(false); setNote(''); }
  };
  const disabled = busy || project.busy;
  const status = project.planStatus;
  const decided = status === 'approved' || status === 'rejected';
  const hook = plan.hook?.options.find((o) => o.id === plan.hook?.chosen);
  return (
    <article class="vs-card vs-card-plan" aria-label="Kế hoạch dựng">
      <div class="vs-card-body">
        <div class="vs-eyebrow vs-plan-eyebrow">
          <span>Kế hoạch dựng · bản {plan.version}</span>
          {status && <span class={`vs-plan-status vs-plan-status-${status}`}>{PLAN_STATUS_LABEL[status]}</span>}
        </div>
        <div class="vs-plan-dur">
          <span>{formatSecs(plan.sourceDurationSec)}</span>
          <span class="vs-faint" aria-hidden="true">→</span>
          <strong>{formatSecs(plan.outputDurationSec)}</strong>
        </div>
        {plan.summary && <p class="vs-plan-summary">{plan.summary}</p>}
        <dl class="vs-plan-grid">
          {groups.length > 0 && (
            <div>
              <dt>Cắt bỏ</dt>
              <dd>{groups.map((g) => `${REMOVED_LABEL[g.kind]} ×${g.count} (${formatSecs(g.secs)})`).join(' · ')}</dd>
            </div>
          )}
          <div><dt>Phong cách</dt><dd>{style ? `${style.command} ${style.name}` : plan.styleId}</dd></div>
          {hook && <div><dt>Hook</dt><dd>“{hook.text}”{hook.mode === 'moved' ? ' (đưa đoạn hay lên đầu)' : ''}</dd></div>}
          <div><dt>Hiệu ứng</dt><dd>{plan.overlays.length} lớp chữ · {plan.zooms.length} lần zoom · {plan.brolls.filter((b) => b.enabled).length} B-roll</dd></div>
          <div><dt>Nhạc</dt><dd>{plan.music ? `${plan.music.mood}, ${plan.music.gainDb} dB${plan.music.duck ? ', tự nhỏ khi có lời' : ''}` : 'Không dùng'}</dd></div>
          <div><dt>Tiếng động</dt><dd>{plan.sfx.length} chỗ</dd></div>
          <div><dt>Ảnh bìa</dt><dd>{plan.covers.length > 0 ? `${plan.covers.length} phương án: ${plan.covers.map((c) => `“${c.title}”`).join(', ')}` : 'Chưa có'}</dd></div>
        </dl>
        {revising && (
          <div class="vs-plan-revise">
            <textarea
              class="vs-input"
              rows={3}
              placeholder="Bạn muốn sửa gì? VD: cắt kỹ hơn phần mở đầu, chữ to lên…"
              aria-label="Góp ý sửa kế hoạch"
              value={note}
              onInput={(e) => setNote(e.currentTarget.value)}
            />
            <div class="vs-row-gap">
              <button type="button" class="vs-btn vs-btn-accent" disabled={disabled || !note.trim()} onClick={() => void act('revise')}><Send size={14} aria-hidden="true" /> Gửi góp ý</button>
              <button type="button" class="vs-btn" onClick={() => setRevising(false)}>Thôi</button>
            </div>
          </div>
        )}
        {!revising && (
          <div class="vs-row-gap">
            {!decided && (
              <>
                <button type="button" class="vs-btn vs-btn-accent" disabled={disabled} onClick={() => void act('approve')}><Check size={14} aria-hidden="true" /> Duyệt kế hoạch</button>
                <button type="button" class="vs-btn" disabled={disabled} onClick={() => setRevising(true)}><MessageSquareWarning size={14} aria-hidden="true" /> Yêu cầu sửa</button>
                <button type="button" class="vs-btn" disabled={disabled} onClick={() => void act('reject')}><X size={14} aria-hidden="true" /> Huỷ</button>
              </>
            )}
            <button type="button" class="vs-btn" onClick={openEditor}><Scissors size={14} aria-hidden="true" /> Mở màn chỉnh sửa</button>
          </div>
        )}
      </div>
    </article>
  );
}

const QUICK: { id: QuickFeedback; label: string; done: string }[] = [
  { id: 'ok', label: 'Ổn, đóng được', done: 'Đã ghi nhớ: kênh thích bản này.' },
  { id: 'fix', label: 'Có chỗ muốn sửa', done: 'Đã ghi nhận. Mở màn chỉnh sửa để sửa.' },
  { id: 'less-effects', label: 'Hiệu ứng hơi nhiều', done: 'Đã ghi nhớ: lần sau dùng ít hiệu ứng hơn.' },
];

export function ResultCard({ project }: { project: VideoProject }) {
  const covers = Math.min(3, project.outputs.covers ?? 0);
  const plan = project.plan;
  const v = project.renders?.length ? project.renders[project.renders.length - 1].version : project.updatedAt;
  const finalUrl = mediaUrl(project.id, 'final', v);
  const [cover, setCover] = useState<number>(project.chosenCover ?? 1);
  const [sent, setSent] = useState<QuickFeedback | null>(null);
  const [sending, setSending] = useState(false);
  const caption = plan ? [plan.meta.caption, plan.meta.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')].filter(Boolean).join('\n\n') : '';

  const pickCover = (n: number) => { setCover(n); void patchProject({ chosenCover: n }); };
  const quick = async (q: QuickFeedback) => {
    setSending(true);
    try {
      await videoEditApi.feedback(project.id, q);
      setSent(q);
      if (q === 'fix') openEditor();
    } catch (e) { pushToast({ tone: 'error', title: 'Chưa ghi nhận được phản hồi', description: errorMessage(e), ttlMs: 6000 }); }
    finally { setSending(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(caption); pushToast({ tone: 'success', title: 'Đã chép caption', ttlMs: 2500 }); }
    catch { pushToast({ tone: 'warn', title: 'Trình duyệt chặn chép tự động, hãy bôi đen và chép tay.' }); }
  };

  return (
    <article class="vs-card vs-card-result" aria-label="Video đã dựng">
      <div class="vs-card-body">
        <div class="vs-eyebrow">Video đã dựng{project.renders?.length ? ` · bản xuất ${project.renders[project.renders.length - 1].version}` : ''}</div>
        <video class="vs-result-video" src={finalUrl} controls preload="metadata" playsInline />
        {covers > 0 && (
          <div>
            <div class="vs-eyebrow vs-result-label" id={`vs-covers-${project.id}`}>Ảnh bìa · chọn 1</div>
            <div class="vs-covers" role="radiogroup" aria-labelledby={`vs-covers-${project.id}`}>
              {Array.from({ length: covers }, (_, i) => {
                const n = i + 1;
                const meta = plan?.covers[i];
                return (
                  <button key={n} type="button" role="radio" aria-checked={cover === n} class={`vs-cover${cover === n ? ' is-on' : ''}`} onClick={() => pickCover(n)} aria-label={`Ảnh bìa ${n}${meta ? `: ${meta.title}` : ''}`}>
                    <img src={mediaUrl(project.id, `cover-${n}` as 'cover-1', v)} alt="" loading="lazy" />
                    {cover === n && <span class="vs-cover-check" aria-hidden="true"><Check size={12} /></span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {caption && (
          <div class="vs-field">
            <span>Caption đề xuất</span>
            <textarea class="vs-input" rows={4} readOnly value={caption} aria-label="Caption đề xuất" />
          </div>
        )}
        <div class="vs-row-gap">
          <a class="vs-btn vs-btn-accent" href={finalUrl} download={`${project.code}.mp4`}><Download size={14} aria-hidden="true" /> Tải xuống</a>
          {caption && <button type="button" class="vs-btn" onClick={() => void copy()}><Copy size={14} aria-hidden="true" /> Chép caption</button>}
          <button type="button" class="vs-btn" onClick={openEditor} disabled={!plan}><Scissors size={14} aria-hidden="true" /> Mở màn chỉnh sửa</button>
          <button type="button" class="vs-btn" disabled title="Giai đoạn 3">Đưa vào Content Studio <span class="vs-phase">GĐ3</span></button>
        </div>
        <div class="vs-quick-replies" role="group" aria-label="Phản hồi nhanh">
          {sent ? (
            <p class="vs-muted vs-quick-done" role="status">{QUICK.find((q) => q.id === sent)?.done}</p>
          ) : (
            QUICK.map((q) => <button key={q.id} type="button" class="vs-quick-btn" disabled={sending} onClick={() => void quick(q.id)}>{q.label}</button>)
          )}
        </div>
        {plan && plan.removed.length > 0 && <RemovedList project={project} plan={plan} />}
      </div>
    </article>
  );
}

const MAX_REMOVED_SHOWN = 40;

function RemovedList({ project, plan }: { project: VideoProject; plan: EditPlan }) {
  const [open, setOpen] = useState(false);
  const [tr, setTr] = useState<Transcript | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const toggle = (e: Event) => {
    const isOpen = (e.currentTarget as HTMLDetailsElement).open;
    setOpen(isOpen);
    if (isOpen && !tr) void videoEditApi.transcript(project.id).then(setTr).catch(() => { /* list still readable without the "Giữ lại" buttons */ });
  };
  const keep = async (idx: number) => {
    const r = plan.removed[idx];
    if (!tr) return;
    const cut = new Set(plan.cutWords);
    const ids = wordsInRange(tr.words, r.start, r.end).map((w) => w.i).filter((i) => cut.has(i));
    if (ids.length === 0) return;
    setBusy(idx);
    const ok = await patchPlan({ toggleWords: ids });
    setBusy(null);
    if (ok) pushToast({ tone: 'success', title: 'Đã giữ lại đoạn này', description: 'Có bản kế hoạch mới. Mở màn chỉnh sửa để duyệt và xuất lại.', action: { label: 'Mở', onClick: openEditor }, ttlMs: 8000 });
  };
  const shown = all ? plan.removed : plan.removed.slice(0, MAX_REMOVED_SHOWN);
  return (
    <details class="vs-removed" onToggle={toggle}>
      <summary>Đoạn đã bỏ · {plan.removed.length}</summary>
      {open && (
        <>
          <ul class="vs-removed-list">
            {shown.map((r, i) => {
              const hasWords = !!tr && r.kind !== 'silence' && wordsInRange(tr.words, r.start, r.end).some((w) => plan.cutWords.includes(w.i));
              return (
                <li key={i}>
                  <span class="vs-mono vs-faint">{formatRange(r.start, r.end)}</span>
                  <span class="vs-tag">{REMOVED_LABEL[r.kind]}</span>
                  <span class="vs-removed-text">{r.text ?? ''}</span>
                  {hasWords && <button type="button" class="vs-btn vs-removed-btn" disabled={busy !== null || project.busy} onClick={() => void keep(i)}>{busy === i ? 'Đang lưu…' : 'Giữ lại'}</button>}
                </li>
              );
            })}
          </ul>
          {!all && plan.removed.length > MAX_REMOVED_SHOWN && <button type="button" class="vs-link" onClick={() => setAll(true)}>Xem hết {plan.removed.length} đoạn</button>}
        </>
      )}
    </details>
  );
}
