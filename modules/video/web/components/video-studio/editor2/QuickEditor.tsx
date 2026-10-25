// Dựng nhanh › Editor v2 (docs/mockups/Editor.dc.html): top bar · tool rail | inspector | preview + "Nhờ AI sửa" |
// layers at the playhead · multi-track timeline. Inspector edits are owner overrides (PUT /overrides, 400 ms
// debounce) and the preview reloads after each save; Thư viện swaps a B-roll file or the background music.
// Reached from Đang dựng › Mở editor (?tab=quick&project=<id>&view=editor).
import { useEffect, useMemo, useRef } from 'preact/hooks';
import {
  BookOpen, Captions, ChevronLeft, Download, Image, LayoutList, LayoutTemplate, Loader2, Music, Redo2, Shapes,
  Sparkles, TriangleAlert, Type, Undo2, ZoomIn,
} from 'lucide-preact';
import { mediaUrl } from '@modules/video/web/lib/video-edit/api';
import { acceptPlan, editPlan, marks, playerTime, transcript } from '@modules/video/web/lib/video-edit/editor';
import {
  buildElements, clockVi, elementForTool, KIND_LABEL, layersAt, planSummary, quickPreviewUrl,
} from '@modules/video/web/lib/video-edit/editor2';
import { buildModel, captionChunks } from '@modules/video/web/lib/video-edit/plan-geometry';
import { planEvent, project, projectJobs } from '@modules/video/web/lib/video-edit/studio';
import { PreviewPlayer } from '../PreviewPlayer';
import { AskBox } from './AskBox';
import { Inspector } from './Inspector';
import { LibraryPanel } from './LibraryPanel';
import {
  askFocus, askScope, assetNames, dropped, exportVideo, libraryPanel, loadQuickEditor, overridesDoc, previewStamp,
  reloadOverrides, reloadPlan, resetQuickEditor, restoreDropped, restoring, saveState, selectedId, selectElement,
  template, tool, TOOL_KIND, type ToolId,
} from './state';
import { Tracks } from './Tracks';
import '@modules/video/web/styles/video-studio.css';
import '@modules/video/web/styles/video-quick.css';

const TOOLS: { id: ToolId; label: string; Icon: typeof Type }[] = [
  { id: 'text', label: 'Chữ', Icon: Type },
  { id: 'caption', label: 'Phụ đề', Icon: Captions },
  { id: 'scene', label: 'Minh hoạ', Icon: LayoutList },
  { id: 'broll', label: 'Cảnh trám', Icon: Image },
  { id: 'graphic', label: 'Đồ hoạ', Icon: Shapes },
  { id: 'sound', label: 'Âm thanh', Icon: Music },
  { id: 'zoom', label: 'Zoom', Icon: ZoomIn },
  { id: 'template', label: 'Mẫu', Icon: LayoutTemplate },
];

const SAVE_LABEL = { idle: 'Đã lưu', saved: 'Đã lưu', saving: 'Đang lưu…', error: 'Chưa lưu được' } as const;

export function QuickEditor({ onBack }: { onBack: () => void }) {
  const p = project.value;
  const projectId = p?.id;

  useEffect(() => {
    if (!projectId) return;
    void loadQuickEditor(projectId);
    return () => resetQuickEditor();
  }, [projectId]);

  // A new plan from the server (AI revise after "Nhờ AI sửa") → show it; `dropped` depends on it.
  const ev = planEvent.value;
  const seenEv = useRef(ev);
  useEffect(() => {
    if (!ev || ev === seenEv.current || !projectId) return;
    seenEv.current = ev;
    acceptPlan(ev.plan);
    void reloadOverrides(projectId);
  }, [ev, projectId]);
  const latest = p?.planVersion ?? 0;
  useEffect(() => {
    if (projectId && editPlan.value && latest > 0 && editPlan.value.version !== latest) void reloadPlan(projectId);
  }, [latest, projectId]);

  const plan = editPlan.value ?? p?.plan ?? null;
  const words = transcript.value?.words ?? [];
  const doc = overridesDoc.value;
  const tpl = template.value;
  const names = assetNames.value;
  const model = useMemo(() => (plan ? buildModel(plan, words, {}) : null), [plan, words]);
  const captions = useMemo(() => (plan && model ? captionChunks(plan, words, model, new Set(plan.cutWords)) : []), [plan, model, words]);
  const elements = useMemo(() => (plan && model ? buildElements(plan, {
    words, model, overrides: doc,
    componentLabel: (c) => tpl?.components[c]?.label,
    assetName: (id) => names[id],
  }) : []), [plan, model, words, doc, tpl, names]);

  if (!p) return <p class="vs-muted vs-dn-pad" role="status">Đang mở editor…</p>;
  if (!plan || !model) {
    return <div class="vs-dn-page">
      <div class="vs-dn-bar">
        <button type="button" class="vs-dn-back" onClick={onBack}><ChevronLeft size={16} aria-hidden="true" /> Đang dựng</button>
        <span class="vs-dn-crumb">Dựng nhanh › {p.title}</span>
      </div>
      <p class="vs-muted vs-dn-pad" role="status">{p.planVersion > 0 ? 'Đang mở editor…' : 'Chưa có bản dựng để mở. Chờ AI dựng xong rồi quay lại.'}</p>
    </div>;
  }

  const t = playerTime.value;
  const selected = elements.find((e) => e.id === selectedId.value) ?? null;
  const layers = layersAt(t, elements, captions, model);
  const busy = p.busy;
  const renderJob = Object.values(projectJobs.value).filter((j) => j.kind === 'render').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const rendering = p.status === 'rendering' || renderJob?.status === 'queued' || renderJob?.status === 'running';
  const pct = renderJob?.progress !== undefined ? Math.round(renderJob.progress * 100) : null;
  const library = libraryPanel.value;
  const restoringId = restoring.value;

  const pickTool = (id: ToolId) => {
    const kind = TOOL_KIND[id];
    if (kind) {
      if (selected?.kind === kind) { tool.value = id; return; }
      const el = elementForTool(elements, kind, t);
      if (el) { selectElement(el); return; }
    }
    tool.value = id;
    selectedId.value = null;
  };
  /** Music when the sound tool is open, else the B-roll swap (for the selected B-roll, or a slot to pick). */
  const openLibrary = () => {
    if (library) { libraryPanel.value = null; return; }
    libraryPanel.value = tool.value === 'sound' ? { tab: 'music' } : { tab: 'broll', ...(selected?.kind === 'broll' ? { brollId: selected.id } : {}) };
  };
  const selectFromLayer = (id: string) => {
    const el = elements.find((e) => e.id === id);
    if (el) selectElement(el, false);
  };

  return <div class="vs-dn-ed">
    <header class="vs-dn-ed-head">
      <button type="button" class="vs-dn-ed-icon" aria-label="Về Đang dựng" title="Về Đang dựng" onClick={onBack}><ChevronLeft size={18} aria-hidden="true" /></button>
      <div class="vs-dn-ed-name">
        <strong>{p.title}</strong>
        <span class={saveState.value === 'error' ? 'is-error' : ''} role="status">{SAVE_LABEL[saveState.value]} · {planSummary(model.total, elements)}</span>
      </div>
      <div class="vs-dn-ed-actions">
        <button type="button" class="vs-dn-ed-lib" aria-pressed={!!library} onClick={openLibrary}>
          <BookOpen size={15} aria-hidden="true" /> Thư viện
        </button>
        <button type="button" class="vs-dn-ed-btn" onClick={() => { libraryPanel.value = null; askScope.value = 'element'; askFocus.value++; }}>
          <Sparkles size={15} aria-hidden="true" /> Nhờ AI sửa
        </button>
        <button type="button" class="vs-dn-ed-icon" aria-label="Hoàn tác" title="Hoàn tác có ở bản sau" disabled><Undo2 size={17} aria-hidden="true" /></button>
        <button type="button" class="vs-dn-ed-icon" aria-label="Làm lại" title="Làm lại có ở bản sau" disabled><Redo2 size={17} aria-hidden="true" /></button>
        {p.outputs.final && !rendering && (
          <a class="vs-dn-ed-btn" href={mediaUrl(p.id, 'final', p.renders?.length ?? 0)} download>Tải video</a>
        )}
        {rendering ? (
          <span class="vs-dn-ed-render" role="status">
            <Loader2 size={14} class="vs-spin" aria-hidden="true" /> Đang xuất{pct !== null ? ` ${pct}%` : '…'}
            {pct !== null && <span class="vs-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Tiến độ xuất video"><span style={{ width: `${pct}%` }} /></span>}
          </span>
        ) : (
          <button type="button" class="vs-dn-ed-export" disabled={busy} onClick={() => void exportVideo()}>
            <Download size={15} aria-hidden="true" /> Xuất video
          </button>
        )}
      </div>
    </header>

    {dropped.value.length > 0 && (
      <section class="vs-dn-dropped" aria-label="Phần AI vừa bỏ">
        <TriangleAlert size={18} aria-hidden="true" class="vs-dn-dropped-icon" />
        <div class="vs-dn-dropped-text">
          <strong>Bản AI mới bỏ mất {dropped.value.length} phần bạn đã sửa tay.</strong>
          <span class="vs-muted">Bấm Khôi phục để đưa lại đúng như bạn đã sửa.</span>
        </div>
        <ul class="vs-dn-dropped-list">
          {dropped.value.map((d) => <li key={d.id}>
            <span>{KIND_LABEL[d.kind]} “{d.label}”</span>
            <button type="button" class="vs-btn" disabled={!!restoringId || busy} onClick={() => void restoreDropped(d)}>
              {restoringId === d.id ? 'Đang khôi phục…' : 'Khôi phục'}
            </button>
          </li>)}
        </ul>
      </section>
    )}
    {busy && <div class="vs-dn-ed-banner" role="status"><Loader2 size={14} class="vs-spin" aria-hidden="true" /> AI đang sửa theo góp ý. Bản mới hiện ở đây khi xong, phần bạn đã sửa tay được giữ nguyên.</div>}

    {library && <LibraryPanel plan={plan} model={model} words={words} elements={elements} />}

    <div class="vs-dn-ed-work" hidden={!!library}>
      <div class="vs-dn-ed-body">
        <nav class="vs-dn-rail" aria-label="Công cụ">
          {TOOLS.map(({ id, label, Icon }) => (
            <button key={id} type="button" aria-current={tool.value === id ? 'true' : undefined} onClick={() => pickTool(id)}>
              <Icon size={18} aria-hidden="true" />{label}
            </button>
          ))}
        </nav>

        <Inspector item={selected} plan={plan} captions={captions} />

        <main class="vs-dn-ed-main" aria-label="Xem trước">
          <PreviewPlayer
            projectId={p.id}
            version={p.planVersion}
            aspect={p.aspect}
            total={model.total}
            src={quickPreviewUrl(p.id, p.planVersion, previewStamp.value)}
            markLabel="Ghim góp ý"
            onMark={() => { askScope.value = 'time'; askFocus.value++; }}
          />
          <AskBox item={askScope.value === 'element' ? selected : null} busy={busy} />
        </main>

        <aside class="vs-dn-layers" aria-labelledby="vs-dn-layers-title">
          <h2 id="vs-dn-layers-title" class="vs-dn-ed-eyebrow">Lớp tại {clockVi(t)}</h2>
          {layers.length === 0 ? <p class="vs-muted vs-dn-small">Không có lớp nào ở đây.</p> : (
            <ul class="vs-dn-layer-list">
              {layers.map((l) => <li key={l.key}>
                {l.id ? (
                  <button type="button" class={`vs-dn-layer${l.id === selected?.id ? ' is-selected' : ''}`} aria-pressed={l.id === selected?.id} onClick={() => selectFromLayer(l.id!)}>
                    <span class={`vs-dn-swatch-dot is-${l.track}`} aria-hidden="true" />
                    <span class="vs-dn-layer-label">{l.label}</span>
                    <span class="vs-dn-layer-kind">{l.kindLabel}</span>
                  </button>
                ) : (
                  <span class="vs-dn-layer">
                    <span class={`vs-dn-swatch-dot is-${l.track}`} aria-hidden="true" />
                    <span class="vs-dn-layer-label">{l.label}</span>
                    <span class="vs-dn-layer-kind">{l.kindLabel}</span>
                  </span>
                )}
              </li>)}
            </ul>
          )}
          <p class="vs-muted vs-dn-small">Nhiều lớp chồng nhau thì chọn ở đây, hoặc bấm trên dòng thời gian.</p>
        </aside>
      </div>

      <Tracks plan={plan} model={model} elements={elements} captions={captions} marks={marks.value} selectedId={selected?.id ?? null} />
    </div>
  </div>;
}
