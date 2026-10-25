// Editor v2 timeline (output time): Chữ · Phụ đề · Minh hoạ · Cảnh trám · Đồ hoạ · Zoom · Nhạc · Tiếng động ·
// Video · Góp ý. A block is a button: it selects the element (inspector) and seeks the player; a click on a
// lane's empty part seeks there. Thu phóng widens the lanes, the strip scrolls sideways inside itself.
import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { playerControls, playerTime } from '@modules/video/web/lib/video-edit/editor';
import {
  clockVi, KIND_LABEL, KIND_TRACK, musicState, soundTicks, TRACKS, type EditorElement, type TrackId,
} from '@modules/video/web/lib/video-edit/editor2';
import type { CaptionChunk, PlanModel } from '@modules/video/web/lib/video-edit/plan-geometry';
import type { EditPlan, VideoMark } from '@modules/video/web/lib/video-edit/types';
import { bgmAssets, overridesDoc, selectedId as selectedSignal, selectElement, template, tool } from './state';

/** Lanes are this wide at Thu phóng 1 (mockup), wider when zoomed. */
const BASE_WIDTH = 980;

function tickStep(total: number): number {
  if (total <= 30) return 2;
  if (total <= 60) return 5;
  if (total <= 150) return 10;
  return 30;
}

export function Tracks({ plan, model, elements, captions, marks, selectedId }: {
  plan: EditPlan;
  model: PlanModel;
  elements: EditorElement[];
  captions: CaptionChunk[];
  marks: VideoMark[];
  selectedId: string | null;
}) {
  const [zoom, setZoom] = useState(1);
  const total = Math.max(model.total, 0.1);
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / total) * 100)).toFixed(3)}%`;
  const span = (s: number, e: number) => ({ left: pct(s), width: `${Math.max(0.4, ((Math.min(e, total) - s) / total) * 100).toFixed(3)}%` });
  const seekFrom = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (r.width <= 0) return;
    playerControls.seek(((e.clientX - r.left) / r.width) * total);
  };
  const dragging = useRef(false);
  const scrub = {
    onPointerDown: (e: PointerEvent) => { dragging.current = true; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); seekFrom(e); },
    onPointerMove: (e: PointerEvent) => { if (dragging.current) seekFrom(e); },
    onPointerUp: () => { dragging.current = false; },
  };

  const step = tickStep(total);
  const ticks: number[] = [];
  for (let t = 0; t <= total + 0.01; t += step) ticks.push(t);

  const music = musicState(plan, overridesDoc.value);
  const track = music.assetId ? bgmAssets.value.find((a) => a.id === music.assetId) : undefined;
  const musicLabel = `${track?.name ?? music.mood ?? 'Nhạc nền'}${music.duck ? ' · tự giảm khi đang nói' : ''}`;
  const beats = (track?.beats ?? []).filter((b) => b <= total);

  const elementBlocks = (id: TrackId) => elements.filter((e) => KIND_TRACK[e.kind] === id).map((e) => {
    const selected = e.id === selectedId;
    return <button
      key={e.id}
      type="button"
      class={`vs-dn-tl-block is-${id}${selected ? ' is-selected' : ''}${e.hidden ? ' is-hidden' : ''}`}
      style={span(e.at, e.end)}
      aria-pressed={selected}
      aria-label={`${KIND_LABEL[e.kind]} “${e.label}”, ${clockVi(e.at)} – ${clockVi(e.end)}${e.hidden ? ', đang ẩn' : ''}`}
      title={e.label}
      onClick={(ev) => { ev.stopPropagation(); selectElement(e); }}
    >{e.label}</button>;
  });

  const lanes: Record<TrackId, ComponentChildren> = {
    text: elementBlocks('text'),
    caption: captions.map((c, i) => (
      <button key={i} type="button" class="vs-dn-tl-block is-caption" style={span(c.s, c.e)} aria-label={`Phụ đề: ${c.text}`} title={c.text}
        onClick={(ev) => { ev.stopPropagation(); tool.value = 'caption'; selectedSignal.value = null; playerControls.seek(c.s + 0.05); }}>{c.text}</button>
    )),
    scene: elementBlocks('scene'),
    broll: elementBlocks('broll'),
    graphic: [
      ...elementBlocks('graphic'),
      // Effects of a legacy (VideoStyle) template: shown, not editable here.
      ...plan.overlays.map((o) => <span key={`ov-${o.id}`} class="vs-dn-tl-block is-graphic is-static" style={span(o.at, o.at + o.duration)} title={o.effect}>{o.effect}</span>),
    ],
    zoom: elementBlocks('zoom'),
    music: !music.off && <>
      <button type="button" class="vs-dn-tl-block is-music" style={span(0, total)} aria-label={`Nhạc: ${musicLabel}`}
        onClick={(ev) => { ev.stopPropagation(); tool.value = 'sound'; selectedSignal.value = null; }}>{musicLabel}</button>
      {beats.map((b, i) => <span key={i} class="vs-dn-tl-beat" style={{ left: pct(b) }} aria-hidden="true" />)}
    </>,
    sfx: soundTicks(plan, elements, template.value).map((s) => (
      <span key={s.key} class="vs-dn-tl-diamond" style={{ left: pct(s.at) }} title={`Tiếng động tại ${clockVi(s.at)}`} />
    )),
    video: model.segs.map((s, i) => (
      <span key={i} class="vs-dn-tl-block is-video" style={span(s.out, s.out + (s.end - s.start))} title={`Nguồn ${clockVi(s.start, true)} – ${clockVi(s.end, true)}`}>
        nguồn {clockVi(s.start, true)}
      </span>
    )),
    mark: marks.map((m, i) => (
      <button key={m.id} type="button" class={`vs-dn-tl-pin${m.status !== 'draft' ? ' is-sent' : ''}`} style={{ left: pct(m.start) }}
        aria-label={`Góp ý ${i + 1} tại ${clockVi(m.start)}: ${m.note}`} title={m.note}
        onClick={(ev) => { ev.stopPropagation(); playerControls.seek(m.start); }}>{i + 1}</button>
    )),
  };

  return <section class="vs-dn-tl" aria-label="Dòng thời gian">
    <div class="vs-dn-tl-tools">
      <span class="vs-muted vs-dn-small">Bấm một khối để chọn và tua tới đó.</span>
      <div class="vs-dn-tl-zoom">
        <label>Thu phóng <input type="range" min={1} max={4} step={0.5} value={zoom} onInput={(e) => setZoom(Number(e.currentTarget.value))} /></label>
        <button type="button" class="vs-btn" onClick={() => setZoom(1)}>Vừa khung</button>
      </div>
    </div>
    <div class="vs-dn-tl-scroll">
      <div class="vs-dn-tl-inner" style={{ minWidth: `${BASE_WIDTH * zoom}px`, width: zoom > 1 ? `${zoom * 100}%` : undefined }}>
        <div class="vs-dn-tl-row">
          <span class="vs-dn-tl-label" />
          <div class="vs-dn-tl-lane vs-dn-tl-ruler" {...scrub} aria-hidden="true">
            {ticks.map((t, i) => (
              <span key={t} class="vs-dn-tl-tick" style={{ left: pct(t), transform: i === 0 ? 'none' : t > total * 0.97 ? 'translateX(-100%)' : 'translateX(-50%)' }}>
                {clockVi(t, true).replace(/,0$/, '')}
              </span>
            ))}
          </div>
        </div>
        {TRACKS.map((tr) => (
          <div class="vs-dn-tl-row" key={tr.id} data-track={tr.id}>
            <span class="vs-dn-tl-label">{tr.label}</span>
            <div class="vs-dn-tl-lane" onClick={seekFrom} role="presentation">{lanes[tr.id]}</div>
          </div>
        ))}
        <div class="vs-dn-tl-playhead" aria-hidden="true" style={{ ['--f' as string]: String(Math.min(1, playerTime.value / total)) }} />
      </div>
    </div>
  </section>;
}
