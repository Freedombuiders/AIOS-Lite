// Editor v2 › Thư viện (docs/mockups/Library.dc.html, Music.dc.html), basic: swap a B-roll for a scored
// suggestion (GET /assets/search with the slot, POST /assets/fetch, override assetId) and pick the background
// music (override music). Sound effects, graphics and drag-and-drop come in phase 2.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { ChevronLeft, Image, Pause, Play, Search } from 'lucide-preact';
import { errorMessage } from '@modules/video/web/lib/video-edit/api';
import {
  candidateLength, candidateMeta, clockVi, editor2Api, licenseLine, musicDuckPatch, musicPickPatch, musicState,
  secondsVi, SOURCE_LABEL, type AssetCandidate, type AssetSource, type EditorElement,
} from '@modules/video/web/lib/video-edit/editor2';
import { assetFileUrl } from '@modules/video/web/lib/video-edit/library-api';
import type { PlanModel } from '@modules/video/web/lib/video-edit/plan-geometry';
import { project } from '@modules/video/web/lib/video-edit/studio';
import type { BrollItem, EditPlan, TranscriptWord, VideoAsset } from '@modules/video/web/lib/video-edit/types';
import { searchKey } from '../quick/quick-model';
import {
  bgmAssets, editMusic, libraryPanel, overridesDoc, playSound, resetMusic, selectElement, stopSound, useCandidate,
} from './state';

const SOURCES: { id: AssetSource | 'all'; label: string }[] = [
  { id: 'all', label: 'Tất cả' },
  { id: 'project', label: 'Tư liệu dự án' },
  { id: 'mine', label: 'Kho của tôi' },
  { id: 'pexels', label: 'Pexels video' },
  { id: 'pexels-photo', label: 'Pexels ảnh' },
];

function Thumb({ c }: { c: AssetCandidate }) {
  if (c.thumbUrl) return <img src={c.thumbUrl} alt="" loading="lazy" />;
  if (c.source === 'mine' || c.source === 'project') {
    return c.kind === 'image'
      ? <img src={assetFileUrl(c.ref)} alt="" loading="lazy" />
      : <video src={assetFileUrl(c.ref)} preload="metadata" muted playsInline aria-hidden="true" />;
  }
  return <Image size={34} aria-hidden="true" />;
}

function BrollLibrary({ item, model, words }: { item: EditorElement; model: PlanModel; words: TranscriptWord[] }) {
  const p = project.value!;
  const broll = item.el as BrollItem;
  const current = item.override?.assetId ?? broll.assetId;
  const [q, setQ] = useState('');
  const [source, setSource] = useState<AssetSource | 'all'>('all');
  const [found, setFound] = useState<{ candidates: AssetCandidate[]; notes: string[]; scored: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [using, setUsing] = useState<string | null>(null);

  /** Empty query = suggestions for this slot, scored against what is being said. */
  const search = async (text: string) => {
    setLoading(true);
    setError('');
    try {
      const r = await editor2Api.searchAssets(text.trim()
        ? { q: text.trim(), aspect: p.aspect, projectId: p.id, limit: 12 }
        : { projectId: p.id, brollId: item.id, aspect: p.aspect, limit: 12 });
      setFound({ ...r, scored: !text.trim() });
    } catch (e) {
      setError(errorMessage(e));
      setFound(null);
    } finally { setLoading(false); }
  };
  useEffect(() => { setQ(''); setSource('all'); void search(''); }, [item.id]);

  const spoken = words.filter((w) => {
    const o = model.toOut(w.start);
    return o !== null && o >= item.at - 0.05 && o < item.end;
  }).map((w) => w.text).join(' ');
  const all = found?.candidates ?? [];
  const shown = all.filter((c) => source === 'all' || c.source === source);

  const use = async (c: AssetCandidate) => {
    setUsing(c.ref);
    const r = await useCandidate(item.id, c);
    setUsing(null);
    if (r === 'ok') libraryPanel.value = null;
    else if (r === 'stale') void search(q);
  };

  return <>
    <section class="vs-dn-lib-slot" aria-label="Chỗ đang thay">
      <span class="vs-dn-lib-slot-icon" aria-hidden="true"><Image size={20} /></span>
      <div class="vs-dn-lib-slot-text">
        <strong>Đổi cảnh trám tại {clockVi(item.at)} – {clockVi(item.end)} · {secondsVi(item.end - item.at)}</strong>
        {spoken && <span class="vs-muted">Lời nói: “{spoken}”</span>}
      </div>
      {broll.query && <div class="vs-dn-lib-slot-query">
        <span class="vs-muted vs-dn-small">AI tìm theo mô tả: <span class="vs-dn-strong">{broll.query.description}</span></span>
        <div class="vs-dn-chips">{broll.query.keywords.map((k) => <span key={k} class="vs-dn-lib-kw">{k}</span>)}</div>
      </div>}
    </section>

    <form class="vs-dn-lib-search" onSubmit={(e) => { e.preventDefault(); void search(q); }}>
      <label class="vs-dn-lib-input">
        <Search size={16} aria-hidden="true" />
        <span class="vs-dn-sr">Tìm cảnh</span>
        <input type="search" value={q} placeholder="Tìm bằng tiếng Việt, ví dụ: người rời bàn làm việc" onInput={(e) => setQ(e.currentTarget.value)} />
      </label>
      <button type="submit" class="vs-btn" disabled={loading}>Tìm</button>
      {q.trim() && <button type="button" class="vs-dn-linkbtn" onClick={() => { setQ(''); void search(''); }}>Về gợi ý của AI</button>}
      <span class="vs-muted vs-dn-small">{found?.scored ? 'Xếp theo: AI chấm độ hợp' : 'Kết quả tìm, chưa chấm'}</span>
    </form>

    <div class="vs-dn-chips" role="group" aria-label="Nguồn">
      {SOURCES.map((s) => {
        const count = s.id === 'all' ? all.length : all.filter((c) => c.source === s.id).length;
        return <button key={s.id} type="button" class="vs-dn-chip" aria-pressed={source === s.id} onClick={() => setSource(s.id)}>
          {s.label} <span class="vs-faint">{count}</span>
        </button>;
      })}
    </div>

    {found?.notes.map((n, i) => <p key={i} class="vs-muted vs-dn-small" role="note">{n}</p>)}
    {error && <div class="vs-error" role="alert">{error}</div>}
    {loading && <p class="vs-muted" role="status">Đang tìm và chấm cảnh hợp với câu đang nói…</p>}
    {!loading && found && shown.length === 0 && <p class="vs-muted">Chưa tìm thấy cảnh nào. Thử từ khoá khác.</p>}

    <div class="vs-dn-lib-grid">
      {shown.map((c) => {
        const inUse = c.ref === current;
        return <article key={c.ref} class={`vs-dn-lib-card${inUse ? ' is-current' : ''}`}>
          <div class="vs-dn-lib-thumb">
            <Thumb c={c} />
            <span class={`vs-dn-lib-src is-${c.source}`}>{SOURCE_LABEL[c.source]}</span>
            {candidateLength(c) && <span class="vs-dn-lib-len">{candidateLength(c)}</span>}
            {inUse && <span class="vs-dn-lib-using">Đang dùng</span>}
          </div>
          <div class="vs-dn-lib-body">
            <strong>{c.caption}</strong>
            {c.score !== undefined && <div class="vs-dn-lib-score">
              <span class={`vs-dn-lib-badge${c.score >= 4 ? ' is-good' : c.score === 3 ? ' is-ok' : ''}`}>Hợp {c.score}/5</span>
              {c.reason && <span class="vs-muted vs-dn-small">{c.reason}</span>}
            </div>}
            <span class="vs-muted vs-dn-small">{candidateMeta(c)}</span>
            <span class="vs-faint vs-dn-small">{licenseLine(c)}</span>
            <button type="button" class="vs-dn-lib-use" disabled={inUse || using !== null} onClick={() => void use(c)}>
              {using === c.ref ? 'Đang lấy…' : inUse ? 'Đang dùng' : 'Dùng'}
            </button>
          </div>
        </article>;
      })}
    </div>
  </>;
}

function SlotPicker({ elements }: { elements: EditorElement[] }) {
  const brolls = elements.filter((e) => e.kind === 'broll');
  if (!brolls.length) return <p class="vs-muted">Video này chưa có cảnh trám nào. Nhờ AI sửa để thêm cảnh trám.</p>;
  return <section class="vs-dn-lib-pick" aria-label="Chọn cảnh trám muốn đổi">
    <h2 class="vs-dn-ed-eyebrow">Chọn cảnh trám muốn đổi</h2>
    <ul>
      {brolls.map((e) => <li key={e.id}>
        <button type="button" class="vs-dn-layer" onClick={() => { selectElement(e); libraryPanel.value = { tab: 'broll', brollId: e.id }; }}>
          <span class="vs-dn-swatch-dot is-broll" aria-hidden="true" />
          <span class="vs-dn-layer-label">{e.label}</span>
          <span class="vs-dn-layer-kind">{clockVi(e.at)}</span>
        </button>
      </li>)}
    </ul>
  </section>;
}

function sourceOf(a: VideoAsset): string {
  return a.source === 'library' ? 'Kho của tôi' : 'CC0 có sẵn';
}

function MusicLibrary({ plan }: { plan: EditPlan }) {
  const tracks = bgmAssets.value;
  const m = musicState(plan, overridesDoc.value);
  const [mood, setMood] = useState('all');
  const [q, setQ] = useState('');
  const [playing, setPlaying] = useState<string | null>(null);
  useEffect(() => () => stopSound(), []);
  const moods = useMemo(() => [...new Set(tracks.map((t) => t.mood).filter((x): x is string => !!x))], [tracks]);
  const key = searchKey(q);
  const shown = tracks.filter((t) => (mood === 'all' || t.mood === mood)
    && (!key || searchKey([t.name, t.mood, t.genre, t.caption, t.description].filter(Boolean).join(' ')).includes(key)));
  const toggle = (a: VideoAsset) => {
    if (playing === a.id) { stopSound(); setPlaying(null); return; }
    playSound(a.id, 1.6);
    setPlaying(a.id);
  };

  return <div class="vs-dn-lib-cols">
    <main class="vs-dn-lib-main">
      <div class="vs-dn-lib-music-head">
        <div>
          <h2 class="vs-dn-lib-h">Nhạc nền</h2>
          <p class="vs-muted">Nhạc của bạn và nhạc CC0 có sẵn. Vạch cam là nhịp mạnh máy dò sẵn.</p>
        </div>
        <label class="vs-dn-lib-input">
          <Search size={16} aria-hidden="true" />
          <span class="vs-dn-sr">Tìm nhạc</span>
          <input type="search" value={q} placeholder="Ví dụ: lofi nhẹ, không lời" onInput={(e) => setQ(e.currentTarget.value)} />
        </label>
      </div>
      {moods.length > 0 && <div class="vs-dn-chips" role="group" aria-label="Lọc theo mood">
        {['all', ...moods].map((x) => <button key={x} type="button" class="vs-dn-chip" aria-pressed={mood === x} onClick={() => setMood(x)}>
          {x === 'all' ? 'Tất cả' : x}
        </button>)}
      </div>}
      {tracks.length === 0 && <p class="vs-muted">Thư viện chưa có nhạc nền. Thêm nhạc ở mục Thư viện của Video Studio.</p>}
      <ul class="vs-dn-lib-tracks">
        {shown.map((a) => {
          const inUse = !m.off && a.id === m.assetId;
          const beats = a.durationSec ? (a.beats ?? []).filter((b) => b <= a.durationSec!) : [];
          return <li key={a.id} class={`vs-dn-lib-track${inUse ? ' is-current' : ''}`}>
            <button type="button" class="vs-dn-lib-play" aria-label={playing === a.id ? `Dừng ${a.name}` : `Nghe thử ${a.name}`} onClick={() => toggle(a)}>
              {playing === a.id ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" fill="currentColor" />}
            </button>
            <div class="vs-dn-lib-track-text">
              <span><strong>{a.name}</strong>{a.attribution && <span class="vs-muted vs-dn-small"> {a.attribution}</span>}</span>
              {(a.caption || a.description) && <span class="vs-muted vs-dn-small">{a.caption || a.description}</span>}
            </div>
            {a.mood && <span class="vs-dn-lib-kw">{a.mood}</span>}
            {beats.length > 0 && <span class="vs-dn-lib-beats" aria-hidden="true">
              {beats.slice(0, 60).map((b, i) => <span key={i} style={{ left: `${(b / a.durationSec!) * 100}%`, height: i % 4 === 0 ? '16px' : '9px' }} />)}
            </span>}
            <span class={`vs-dn-lib-src is-${a.source === 'library' ? 'mine' : 'cc0'}`}>{sourceOf(a)}</span>
            <button type="button" class={`vs-dn-lib-pickbtn${inUse ? ' is-current' : ''}`} disabled={inUse} onClick={() => editMusic(musicPickPatch(plan, a.id))}>
              {inUse ? 'Đang dùng' : 'Dùng'}
            </button>
          </li>;
        })}
      </ul>
    </main>
    <aside class="vs-dn-lib-aside" aria-labelledby="vs-dn-mix-title">
      <h2 id="vs-dn-mix-title" class="vs-dn-lib-h">Cách trộn cho video này</h2>
      <label class="vs-dn-insp-check">
        <input type="checkbox" checked={m.duck} disabled={m.off} onChange={(e) => editMusic(musicDuckPatch(plan, e.currentTarget.checked))} />
        <span>Tự giảm nhạc khi đang nói</span>
      </label>
      <button type="button" class="vs-btn" disabled={m.off} onClick={() => editMusic(musicPickPatch(plan, null))}>Không dùng nhạc</button>
      {m.edited && <button type="button" class="vs-dn-linkbtn" onClick={() => void resetMusic()}>Trả về nhạc AI chọn</button>}
      <p class="vs-muted vs-dn-small">Chỉ thêm bài bạn có quyền dùng. Nhạc đổi ở đây là chỉnh tay của bạn, AI sửa lại cũng không đổi.</p>
    </aside>
  </div>;
}

export function LibraryPanel({ plan, model, words, elements }: { plan: EditPlan; model: PlanModel; words: TranscriptWord[]; elements: EditorElement[] }) {
  const lib = libraryPanel.value!;
  const slot = lib.brollId ? elements.find((e) => e.id === lib.brollId && e.kind === 'broll') : undefined;
  const close = () => { libraryPanel.value = null; };
  return <section class="vs-dn-lib" aria-label="Thư viện">
    <header class="vs-dn-lib-head">
      <button type="button" class="vs-dn-back" onClick={close}><ChevronLeft size={16} aria-hidden="true" /> Về editor</button>
      <strong>Thư viện</strong>
      <nav class="vs-dn-lib-tabs" aria-label="Loại tài nguyên">
        <button type="button" aria-current={lib.tab === 'broll' ? 'page' : undefined} onClick={() => { libraryPanel.value = { ...lib, tab: 'broll' }; }}>Cảnh trám &amp; ảnh</button>
        <button type="button" aria-current={lib.tab === 'music' ? 'page' : undefined} onClick={() => { libraryPanel.value = { ...lib, tab: 'music' }; }}>Nhạc</button>
      </nav>
    </header>
    <div class="vs-dn-lib-content">
      {lib.tab === 'music'
        ? <MusicLibrary plan={plan} />
        : slot ? <BrollLibrary key={slot.id} item={slot} model={model} words={words} /> : <SlotPicker elements={elements} />}
    </div>
  </section>;
}
