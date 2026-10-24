// Màn chỉnh sửa: header (version switch, send marks, approve) · transcript | player | tabs · timeline.
// Reached from "Mở màn chỉnh sửa" (URL ?project=<id>&view=editor). Plan edits are optimistic PATCHes.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ChevronLeft, Check, Loader2, Send } from 'lucide-preact';
import {
  acceptPlan, approveAndExport, cutOverrides, diffPanel, editorLoading, editorTab, editPlan, isReadOnly, loadEditor,
  marks, resetEditor, savingPlan, sendMarks, showDiff, showVersion, transcript, viewVersion, type EditorTab,
} from '@modules/video/web/lib/video-edit/editor';
import {
  brollBlocks, buildModel, captionChunks, hookBlock, overlayBlocks,
} from '@modules/video/web/lib/video-edit/plan-geometry';
import { closeEditor, planEvent, project, projectJobs } from '@modules/video/web/lib/video-edit/studio';
import { BrollTab } from './BrollTab';
import { EffectsTab } from './EffectsTab';
import { HookTab } from './HookTab';
import { MarksTab } from './MarksTab';
import { PreviewPlayer } from './PreviewPlayer';
import { Timeline } from './Timeline';
import { TranscriptEditor } from './TranscriptEditor';
import { VersionBar } from './VersionBar';

const WIDE_PX = 900;

function useWide(ref: { current: HTMLElement | null }): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWide(el.getBoundingClientRect().width >= WIDE_PX);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return wide;
}

/** Full-screen editor; `embedded` renders it inside another view (Video Studio › Hoàn thiện) with `onClose` for the back button. */
export function EditorView({ embedded = false, onClose }: { embedded?: boolean; onClose?: () => void } = {}) {
  const p = project.value;
  const rootRef = useRef<HTMLDivElement>(null);
  const wide = useWide(rootRef);
  const projectId = p?.id;

  useEffect(() => {
    if (!projectId) return;
    void loadEditor(projectId);
    return () => resetEditor();
  }, [projectId]);

  // New plan version from the server (agent revise, marks batch) -> swap it in.
  const ev = planEvent.value;
  useEffect(() => { if (ev) acceptPlan(ev.plan); }, [ev]);
  const latest = p?.planVersion ?? 0;
  useEffect(() => {
    if (projectId && editPlan.value && viewVersion.value === null && editPlan.value.version !== latest && latest > 0) void showVersion(null);
  }, [latest, projectId]);

  const plan = editPlan.value ?? (viewVersion.value === null ? p?.plan ?? null : null);
  const words = transcript.value?.words ?? [];
  const overrides = cutOverrides.value;
  const cut = useMemo(() => {
    const s = new Set(plan?.cutWords ?? []);
    for (const [k, v] of Object.entries(overrides)) { if (v) s.add(Number(k)); else s.delete(Number(k)); }
    return s;
  }, [plan, overrides]);
  const model = useMemo(() => (plan ? buildModel(plan, words, overrides) : null), [plan, words, overrides]);
  const timeline = useMemo(() => {
    if (!plan || !model) return null;
    return {
      plan, model,
      captions: captionChunks(plan, words, model, cut),
      hook: hookBlock(plan, model),
      overlays: overlayBlocks(plan),
      brolls: brollBlocks(plan, words, model),
    };
  }, [plan, model, words, cut]);

  if (!p || !plan || !model || !timeline) {
    return <div class="vs-loading" role="status">Đang mở màn chỉnh sửa…</div>;
  }

  const readOnly = isReadOnly();
  const drafts = marks.value.filter((m) => m.status === 'draft');
  const busy = p.busy;
  const saving = savingPlan.value > 0 || Object.keys(overrides).length > 0;
  const renderJob = Object.values(projectJobs.value).filter((j) => j.kind === 'render').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const rendering = p.status === 'rendering' || renderJob?.status === 'queued' || renderJob?.status === 'running';
  const pct = renderJob?.progress !== undefined ? Math.round(renderJob.progress * 100) : null;
  const approved = p.planStatus === 'approved';
  const diff = diffPanel.value;
  const tab = editorTab.value;
  const tabs: { id: EditorTab; label: string; count: number }[] = [
    { id: 'marks', label: 'Góp ý', count: marks.value.length },
    { id: 'hook', label: 'Hook', count: plan.hook?.options.length ?? 0 },
    { id: 'broll', label: 'B-roll', count: plan.brolls.length },
    { id: 'fx', label: 'Hiệu ứng', count: plan.overlays.length },
  ];

  const player = (
    <section class="vs-ed-stage" aria-label="Xem trước">
      <PreviewPlayer projectId={p.id} version={viewVersion.value ?? p.planVersion} aspect={p.aspect} total={model.total} readOnly={readOnly} />
    </section>
  );
  const transcriptCol = (
    <TranscriptEditor plan={plan} words={words} model={model} cut={cut} marks={marks.value} readOnly={readOnly || busy} loading={editorLoading.value} />
  );
  const side = (
    <aside class="vs-ed-side" aria-label="Chi tiết chỉnh sửa">
      <div class="vs-seg vs-ed-tabs" role="tablist" aria-label="Loại chỉnh sửa">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" id={`vs-ed-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="vs-ed-panel" class={tab === t.id ? 'is-active' : ''} onClick={() => { editorTab.value = t.id; }}>
            {t.label} <span class="vs-faint">{t.count}</span>
          </button>
        ))}
      </div>
      <div class="vs-ed-panel" id="vs-ed-panel" role="tabpanel" aria-labelledby={`vs-ed-tab-${tab}`}>
        {tab === 'marks' && <MarksTab marks={marks.value} readOnly={readOnly} />}
        {tab === 'hook' && <HookTab plan={plan} words={words} readOnly={readOnly || busy} />}
        {tab === 'broll' && <BrollTab plan={plan} words={words} model={model} readOnly={readOnly || busy} />}
        {tab === 'fx' && <EffectsTab plan={plan} readOnly={readOnly} />}
      </div>
    </aside>
  );

  return (
    <div class={`vs-ed${wide ? ' is-wide' : ''}${embedded ? ' is-embedded' : ''}`} ref={rootRef}>
      <header class="vs-ed-head">
        {!embedded && (
          <button type="button" class="vs-btn vs-ed-back" onClick={() => (onClose ? onClose() : closeEditor())}>
            <ChevronLeft size={16} aria-hidden="true" /> <span class="vs-mono">{p.code}</span>
          </button>
        )}
        <span class="vs-ed-title" title={p.title}>{p.title}</span>
        <VersionBar latest={p.planVersion} status={p.planStatus} />
        <div class="vs-ed-actions">
          {saving && <span class="vs-faint vs-ed-saving" role="status"><Loader2 size={13} class="vs-spin" aria-hidden="true" /> Đang lưu…</span>}
          {drafts.length > 0 && <span class="vs-ed-unsent">{drafts.length} góp ý chưa gửi</span>}
          {plan.version >= 2 && (
            <button type="button" class="vs-btn" aria-expanded={diff?.to === plan.version} onClick={() => void showDiff()}>Xem thay đổi v{plan.version - 1} → v{plan.version}</button>
          )}
          <button type="button" class="vs-btn vs-btn-accent" disabled={drafts.length === 0 || busy || readOnly} onClick={() => void sendMarks()}>
            <Send size={14} aria-hidden="true" /> Gửi {drafts.length} góp ý cho agent
          </button>
          {rendering ? (
            <span class="vs-ed-render" role="status">
              <Loader2 size={14} class="vs-spin" aria-hidden="true" /> Đang xuất{pct !== null ? ` ${pct}%` : '…'}
              {pct !== null && <span class="vs-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Tiến độ xuất video"><span style={{ width: `${pct}%` }} /></span>}
            </span>
          ) : approved && p.outputs.final ? (
            <button type="button" class="vs-btn vs-btn-hl" onClick={() => (onClose ? onClose() : closeEditor())}><Check size={14} aria-hidden="true" /> Xem kết quả</button>
          ) : (
            <button type="button" class="vs-btn vs-btn-hl" disabled={busy || readOnly || approved} onClick={() => void approveAndExport()}>
              <Check size={14} aria-hidden="true" /> {approved ? 'Đã duyệt' : 'Duyệt & xuất'}
            </button>
          )}
        </div>
      </header>

      {diff && (
        <section class="vs-ed-diff" aria-label={`Thay đổi từ v${diff.from} sang v${diff.to}`}>
          <div class="vs-eyebrow">Thay đổi v{diff.from} → v{diff.to}</div>
          {diff.changes === null && <p class="vs-muted" role="status">Đang so sánh…</p>}
          {diff.changes && diff.changes.length === 0 && <p class="vs-muted">Không ghi nhận thay đổi nào.</p>}
          {diff.changes && diff.changes.length > 0 && <ul>{diff.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>}
          {diff.error && <p class="vs-faint">{diff.error}</p>}
        </section>
      )}
      {readOnly && (
        <div class="vs-ed-banner" role="status">
          Đang xem bản v{viewVersion.value} (chỉ đọc).
          <button type="button" class="vs-btn" onClick={() => void showVersion(null)}>Về bản mới nhất v{p.planVersion}</button>
        </div>
      )}
      {busy && <div class="vs-ed-banner" role="status"><Loader2 size={14} class="vs-spin" aria-hidden="true" /> Agent đang sửa kế hoạch. Bản mới sẽ hiện ở đây khi xong.</div>}

      <div class="vs-ed-body">
        {wide ? (
          <>
            <div class="vs-ed-col vs-ed-col-tr">{transcriptCol}</div>
            <div class="vs-ed-col vs-ed-col-stage">{player}</div>
            <div class="vs-ed-col vs-ed-col-side">{side}</div>
          </>
        ) : (
          <>
            {player}
            {side}
            {transcriptCol}
          </>
        )}
      </div>
      <Timeline data={{ ...timeline, marks: marks.value }} />
    </div>
  );
}
