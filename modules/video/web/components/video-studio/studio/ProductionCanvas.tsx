/** One video: Phân cảnh ⇄ Xem thử ⇄ Hoàn thiện, with the spend gate, live progress and publishing. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { AlertTriangle, Check, Clapperboard, ExternalLink, Film, Layers, Loader2, Plus, RotateCcw, Send, Sparkles, Trash2, Wand2 } from 'lucide-preact';

import { mediaUrl } from '@modules/video/web/lib/video-edit/api';
import { project } from '@modules/video/web/lib/video-edit/studio';
import { errorText, productionApi } from '@modules/video/web/lib/video-production-api';
import {
  STATE_LABEL, describeEstimate, fmtSec, sceneCounts, totalSec,
  type CastMember, type CostEstimate, type EngineStatus, type Production, type SceneKind,
} from '@modules/video/web/lib/video-production';
import { EditorView } from '../EditorView';
import { TicketPanel } from '../TicketPanel';
import { KolAvatar } from '../production/MentionComposer';
import { SceneCard } from '../production/SceneCard';
import { ApprovalCard } from './ApprovalCard';
import { ScenePreviewPlayer } from './ScenePreviewPlayer';

export type CanvasView = 'board' | 'preview' | 'finish';

export function ProductionCanvas({ p, setP, cast, engines, view, onView, onDeleted }: {
  p: Production; setP: (p: Production) => void; cast: CastMember[]; engines: EngineStatus[] | null;
  view: CanvasView; onView: (v: CanvasView) => void; onDeleted: () => void;
}) {
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const [title, setTitle] = useState(p.title);
  const [remaining, setRemaining] = useState<CostEstimate | null>(null);
  const [publishTo, setPublishTo] = useState(p.cast[0] ?? '');
  const [published, setPublished] = useState<{ link: string; reused: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => { setTitle(p.title); }, [p.title]);

  // Edits save through their own queue: never dropped while another action runs, shown as saving / saved.
  const [saving, setSaving] = useState<'' | 'saving' | 'saved' | 'error'>('');
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const inFlight = useRef(0);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>();
  function save(fn: () => Promise<{ production: Production }>) {
    inFlight.current++;
    setSaving('saving');
    clearTimeout(savedTimer.current);
    let failed = false;
    queue.current = queue.current
      .then(fn)
      .then((r) => setP(r.production))
      .catch((e) => { failed = true; say(errorText(e), true); })
      .finally(() => {
        inFlight.current--;
        if (inFlight.current) return;
        setSaving(failed ? 'error' : 'saved');
        savedTimer.current = setTimeout(() => setSaving(''), failed ? 6000 : 1800);
      });
  }

  const counts = sceneCounts(p.scenes);
  const toMake = counts.draft + counts.failed;
  const allDone = counts.total > 0 && counts.done === counts.total;
  // Only scenes that can start go on the card; the rest show why on their own card.
  const startable = p.scenes.filter((s) => (s.status === 'draft' || s.status === 'failed') && !s.problem);
  const blocked = toMake - startable.length;
  const waitingRetry = p.scenes.filter((s) => s.status === 'queued' && s.retry).length;
  // Re-estimate only when what would be generated changes (not on every progress event).
  const draftKey = p.scenes.filter((s) => s.status === 'draft' || s.status === 'failed').map((s) => [s.id, s.kind, s.engine, s.durationSec, s.text.length, s.kolId].join(':')).join('|');
  useEffect(() => {
    if (!toMake) { setRemaining(null); return; }
    productionApi.estimate(p.id).then((r) => setRemaining(r.estimate)).catch(() => setRemaining(null));
  }, [p.id, draftKey]);

  const say = (text: string, bad = false) => {
    setToast({ text, bad });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), bad ? 8000 : 3500);
  };

  async function run<T extends { production: Production }>(label: string, fn: () => Promise<T>, done?: string | ((r: T) => string)): Promise<T | null> {
    if (busy) return null;
    setBusy(label);
    try {
      const r = await fn();
      setP(r.production);
      if (done) say(typeof done === 'function' ? done(r) : done);
      return r;
    } catch (e) {
      say(errorText(e), true);
      return null;
    } finally {
      setBusy('');
    }
  }

  const host = project.value?.id === p.projectId ? project.value : null;
  const castHere = cast.filter((c) => p.cast.includes(c.id));
  const lead = castHere[0] ?? null;
  const hasFinal = Boolean(host?.outputs.final);
  const finishing = p.state === 'finishing' || p.state === 'assembling' || Boolean(host?.source);

  const add = (kind: SceneKind) => run('add', () => productionApi.addScene(p.id, {
    kind, kolId: kind === 'broll' ? null : lead?.id ?? null, ...(kind === 'broll' ? { engine: 'veo', durationSec: 5 } : {}),
  }));
  const askApproval = (sceneIds?: string[]) => run('generate', () => productionApi.generate(p.id, sceneIds), (r) => `Đã gửi thẻ duyệt: ${describeEstimate(r.estimate)}`);

  async function publish() {
    if (!p.projectId || busy) return;
    setBusy('publish');
    try {
      const r = await productionApi.publish(p.projectId, publishTo ? { personaId: publishTo } : {});
      setPublished({ link: r.link, reused: r.reused });
      say(r.reused ? 'Bản này đã có bài nháp trong KOL Studio.' : 'Đã tạo bài nháp trong KOL Studio, chờ bạn duyệt và chọn kênh.');
    } catch (e) {
      say(errorText(e), true);
    } finally {
      setBusy('');
    }
  }

  const primary = (() => {
    if (p.pendingApproval) return <button type="button" class="vp-btn vp-btn-sm" onClick={() => onView('board')}>Chờ bạn duyệt chi phí</button>;
    if (p.state === 'generating') return <span class="vp-pill is-busy"><Loader2 size={12} class="animate-spin" /> Đang tạo {counts.running} cảnh</span>;
    if (toMake > 0) {
      if (!startable.length) return <span class="vp-pill is-bad" title="Xem lý do trên từng cảnh">{blocked} cảnh cần sửa trước khi tạo</span>;
      return (
        <>
          {blocked > 0 && <span class="vp-pill is-bad" title="Các cảnh này chưa tạo được, xem lý do trên từng cảnh">{blocked} cảnh cần sửa</span>}
          <button type="button" class="vp-btn vp-btn-primary" disabled={Boolean(busy)} onClick={() => askApproval(startable.map((s) => s.id))}>
            {busy === 'generate' ? <Loader2 size={14} class="animate-spin" /> : <Sparkles size={14} />} Xin duyệt & tạo {startable.length} cảnh
          </button>
        </>
      );
    }
    if (p.state === 'assembling') return <span class="vp-pill is-busy"><Loader2 size={12} class="animate-spin" /> Đang ghép video</span>;
    if (allDone && (p.state === 'ready' || p.state === 'failed')) {
      return (
        <button type="button" class="vp-btn vp-btn-accent" disabled={Boolean(busy)} onClick={() => run('finish', () => productionApi.finish(p.id), 'Đã ghép, đang chuyển sang hoàn thiện HyperFrames.').then(() => onView('finish'))}>
          {busy === 'finish' ? <Loader2 size={14} class="animate-spin" /> : p.state === 'failed' ? <RotateCcw size={14} /> : <Wand2 size={14} />} {p.state === 'failed' ? 'Ghép lại' : p.finishProjectId ? 'Ghép lại & hoàn thiện' : 'Hoàn thiện với HyperFrames'}
        </button>
      );
    }
    if (hasFinal) return <button type="button" class="vp-btn vp-btn-primary" onClick={() => onView('finish')}><Send size={14} /> Đăng lên KOL</button>;
    return null;
  })();

  return (
    <section class="vx-canvas" aria-label={p.title}>
      <header class="vx-canvas-head">
        <input class="vp-title-input" value={title} aria-label="Tên video" onInput={(e) => setTitle(e.currentTarget.value)}
          onBlur={() => { if (title.trim() && title !== p.title) void run('title', () => productionApi.patch(p.id, { title })); }} />
        <div class="vx-canvas-meta">
          <span class="vp-avatars">{castHere.map((k) => <KolAvatar key={k.id} kol={k} />)}</span>
          {p.series && <span class="vp-pill"><Layers size={11} /> Series {p.series.index}/{p.series.total}</span>}
          {saving && (
            <span class={`vx-save${saving === 'error' ? ' is-bad' : ''}`} role="status">
              {saving === 'saving' ? <><Loader2 size={11} class="animate-spin" /> Đang lưu…</> : saving === 'saved' ? <><Check size={11} /> Đã lưu</> : 'Chưa lưu được'}
            </span>
          )}
          <span class="vp-pill">{p.aspect} · {fmtSec(totalSec(p.scenes) || p.targetSec)}</span>
          <span class={`vp-pill ${p.state === 'ready' || hasFinal ? 'is-done' : p.state === 'generating' || p.state === 'assembling' ? 'is-busy' : p.state === 'failed' ? 'is-bad' : ''}`}>{hasFinal ? 'Đã xuất video' : STATE_LABEL[p.state]}</span>
        </div>
        <div class="vx-canvas-bar">
          <div class="vp-seg" role="tablist" aria-label="Chế độ xem">
            <button type="button" role="tab" aria-selected={view === 'board'} onClick={() => onView('board')}><Clapperboard size={13} /> Phân cảnh</button>
            <button type="button" role="tab" aria-selected={view === 'preview'} onClick={() => onView('preview')}><Film size={13} /> Xem thử</button>
            <button type="button" role="tab" aria-selected={view === 'finish'} onClick={() => onView('finish')}><Wand2 size={13} /> Hoàn thiện</button>
          </div>
          <span class="vp-spacer" />
          {primary}
        </div>
      </header>

      <div class="vx-canvas-body">
        {p.error && p.state !== 'generating' && p.state !== 'assembling' && (
          <div class="vx-alert" role="alert">
            <AlertTriangle size={15} />
            <span>{p.error}</span>
            {allDone && <button type="button" class="vp-btn vp-btn-sm" disabled={Boolean(busy)} onClick={() => void run('finish', () => productionApi.finish(p.id), 'Đã ghép, đang chuyển sang hoàn thiện HyperFrames.').then(() => onView('finish'))}><RotateCcw size={13} /> Thử lại</button>}
          </div>
        )}
        {view === 'board' && (
          <div class="vx-board">
            {waitingRetry > 0 && (
              <div class="vx-alert is-info" role="status">
                <Loader2 size={15} class="animate-spin" />
                <span>Nhà cung cấp đang quá tải: {waitingRetry} cảnh chưa tạo được (chưa tính phí) và sẽ tự thử lại sau ít phút, không cần duyệt lại.</span>
                <button type="button" class="vp-btn vp-btn-sm" disabled={Boolean(busy)} onClick={() => void run('stop', () => productionApi.stopRetries(p.id), 'Đã dừng tự thử lại.')}>Dừng tự thử lại</button>
              </div>
            )}
            {p.pendingApproval && <ApprovalCard key={p.pendingApproval.approvalId} approvalId={p.pendingApproval.approvalId} />}
            <div class="vx-progress-row">
              <div class="vp-progress" aria-hidden="true">
                <i class="ok" style={{ width: `${counts.total ? (counts.done / counts.total) * 100 : 0}%` }} />
                <i class="busy" style={{ width: `${counts.total ? (counts.running / counts.total) * 100 : 0}%` }} />
                <i class="bad" style={{ width: `${counts.total ? (counts.failed / counts.total) * 100 : 0}%` }} />
              </div>
              <span class="vp-faint">{counts.done}/{counts.total} cảnh xong{remaining && toMake ? ` · còn lại ${describeEstimate(remaining)}` : ''}</span>
            </div>
            {p.script?.hook && (
              <div class="vx-hook"><span class="vp-label">Hook</span><p>{p.script.hook}</p></div>
            )}
            {p.scenes.length === 0 && (
              <div class="vp-empty">
                {project.value?.busy ? <Loader2 size={20} class="animate-spin" /> : <Clapperboard size={22} />}
                <strong>{project.value?.busy ? 'Đạo diễn AI đang lên kịch bản và phân cảnh…' : 'Chưa có phân cảnh'}</strong>
                <p>{project.value?.busy ? 'Bộ não của KOL viết lời đúng giọng; Đạo diễn AI chọn công cụ cho từng cảnh rồi xin bạn duyệt chi phí một lần.' : p.error ?? 'Nhắn cho Đạo diễn AI ở khung bên phải, hoặc để bộ não KOL viết nhanh.'}</p>
                {!project.value?.busy && <button type="button" class="vp-btn vp-btn-primary" disabled={Boolean(busy) || !lead} onClick={() => run('write', () => productionApi.write(p.id), 'Đã viết kịch bản.')}><Wand2 size={14} /> Viết nhanh bằng bộ não KOL</button>}
              </div>
            )}
            {p.scenes.map((s, i) => (
              <SceneCard
                key={s.id} p={p} scene={s} index={i} cast={cast} engines={engines} busy={Boolean(busy)}
                onPatch={(patch) => save(() => productionApi.patchScene(p.id, s.id, patch))}
                onTrim={(trim) => save(() => productionApi.trimScene(p.id, s.id, trim))}
                onGenerate={() => void askApproval([s.id])}
                onMove={(to) => void run('move', () => productionApi.moveScene(p.id, s.id, to))}
                onRemove={() => { if (confirm(`Xoá cảnh ${i + 1}?`)) void run('remove', () => productionApi.removeScene(p.id, s.id)); }}
              />
            ))}
            <div class="vp-add">
              <button type="button" class="vp-btn vp-btn-ghost vp-btn-sm" disabled={Boolean(busy) || !lead} onClick={() => void add('talking')}><Plus size={13} /> Cảnh KOL nói</button>
              <button type="button" class="vp-btn vp-btn-ghost vp-btn-sm" disabled={Boolean(busy)} onClick={() => void add('broll')}><Plus size={13} /> Cảnh B-roll</button>
              <button type="button" class="vp-btn vp-btn-ghost vp-btn-sm" disabled={Boolean(busy) || !lead} onClick={() => void add('clip')}><Plus size={13} /> Clip có sẵn</button>
            </div>
            {p.script && (p.script.caption || p.script.hashtags.length > 0) && (
              <details class="vx-script">
                <summary>Chú thích đăng bài & hashtag</summary>
                {p.script.caption && <p>{p.script.caption}</p>}
                {p.script.hashtags.length > 0 && <div class="vp-tags">{p.script.hashtags.map((h) => <span key={h}>#{h}</span>)}</div>}
              </details>
            )}
            <details class="vx-script">
              <summary>Ý tưởng gốc</summary>
              <p>{p.brief}</p>
              <button type="button" class="vp-btn vp-btn-ghost vp-btn-sm" disabled={counts.running > 0 || p.state === 'assembling'}
                title={counts.running > 0 ? 'Đang tạo cảnh (đã tính phí): chờ xong rồi mới xoá' : undefined}
                onClick={() => {
                  if (confirm('Xoá video này? Các cảnh và bản dựng của video bị xoá vĩnh viễn (thư viện KOL không bị ảnh hưởng).')) {
                    productionApi.remove(p.id).then(onDeleted).catch((e) => say(errorText(e), true));
                  }
                }}><Trash2 size={13} /> Xoá video</button>
            </details>
          </div>
        )}

        {view === 'preview' && <ScenePreviewPlayer p={p} />}

        {view === 'finish' && (
          <div class="vx-finish">
            {!finishing && (
              <div class="vp-finish">
                <h3><Sparkles size={15} style={{ verticalAlign: '-2px' }} /> Hoàn thiện với HyperFrames</h3>
                <ul>
                  <li>Ghép {counts.total} cảnh thành một video {p.aspect}</li>
                  <li>Phụ đề tô từ khoá theo đúng lời thoại (không cần chép lời)</li>
                  <li>Hook 3 giây, hiệu ứng theo lời, zoom nhấn, nhạc nền theo bộ nhận diện KOL</li>
                  <li>Ảnh bìa và xuất MP4; bạn duyệt kế hoạch trước khi xuất</li>
                </ul>
                <button type="button" class="vp-btn vp-btn-accent vp-btn-lg" disabled={Boolean(busy) || !allDone || p.state === 'assembling' || p.state === 'generating'} onClick={() => void run('finish', () => productionApi.finish(p.id), 'Đã ghép, đang chuyển sang hoàn thiện HyperFrames.')}>
                  {p.state === 'assembling' ? <><Loader2 size={15} class="animate-spin" /> Đang ghép…</> : <><Wand2 size={15} /> {allDone ? 'Hoàn thiện ngay' : `Cần tạo xong ${counts.total - counts.done} cảnh nữa`}</>}
                </button>
              </div>
            )}
            {finishing && hasFinal && host && (
              <div class="vx-final">
                <video src={mediaUrl(host.id, 'final', host.renders?.at(-1)?.version ?? host.updatedAt)} controls playsInline preload="metadata" />
                <div class="vx-final-side">
                  <h3>Video đã xuất</h3>
                  <p class="vp-muted">Đăng lên KOL: video vào thư viện KOL và thành bài nháp kèm chú thích, hashtag. Bạn chọn kênh và lịch đăng trong KOL Studio.</p>
                  <label class="vp-label" for="vx-pub">Đăng bởi</label>
                  <select id="vx-pub" class="vp-select" value={publishTo} onChange={(e) => setPublishTo(e.currentTarget.value)}>
                    {castHere.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
                  </select>
                  <button type="button" class="vp-btn vp-btn-primary" disabled={Boolean(busy) || !publishTo} onClick={() => void publish()}>
                    {busy === 'publish' ? <Loader2 size={14} class="animate-spin" /> : <Send size={14} />} Đăng lên KOL
                  </button>
                  {published && <a class="vp-btn vp-btn-sm" href={published.link}><ExternalLink size={13} /> Mở bài nháp trong KOL Studio</a>}
                  <a class="vp-link" href={mediaUrl(host.id, 'final', host.renders?.at(-1)?.version)} download>Tải MP4</a>
                </div>
              </div>
            )}
            {finishing && host?.plan && (
              <div class="vs-root vx-editor"><EditorView embedded onClose={() => onView('finish')} /></div>
            )}
            {finishing && host && !host.plan && (
              <div class="vs-root vx-ticket">
                <p class="vp-muted" style={{ padding: '14px 16px 0' }}>Đang chuẩn hoá và phân tích bản ghép; agent dựng sẽ lên kế hoạch phụ đề, hook và hiệu ứng để bạn duyệt.</p>
                <TicketPanel />
              </div>
            )}
          </div>
        )}
      </div>

      {toast && <div class={`vp-toast ${toast.bad ? 'is-bad' : ''}`} role={toast.bad ? 'alert' : 'status'}>{toast.text}</div>}
    </section>
  );
}
