// Multi-lane timeline (output time): Video · Hook · Phụ đề · Hiệu ứng · B-roll · Nhạc · Tiếng động · Góp ý.
// Lanes are derived from the plan; clicking any lane seeks the player, the playhead follows timeupdate.
import type { ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';
import { formatTimeDec } from '@modules/video/web/lib/video-edit/format';
import { playerControls, playerTime } from '@modules/video/web/lib/video-edit/editor';
import type { BlockItem, CaptionChunk, PlanModel } from '@modules/video/web/lib/video-edit/plan-geometry';
import type { EditPlan, VideoMark } from '@modules/video/web/lib/video-edit/types';

export interface TimelineData {
  plan: EditPlan;
  model: PlanModel;
  captions: CaptionChunk[];
  hook: BlockItem | null;
  overlays: BlockItem[];
  brolls: BlockItem[];
  marks: VideoMark[];
}

function tickStep(total: number): number {
  if (total <= 20) return 2;
  if (total <= 60) return 5;
  if (total <= 150) return 10;
  return 30;
}

export function Timeline({ data }: { data: TimelineData }) {
  const { plan, model, marks } = data;
  const total = Math.max(model.total, 0.1);
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / total) * 100)).toFixed(3)}%`;
  const span = (s: number, e: number) => ({ left: pct(s), width: `${Math.max(0.4, (Math.min(e, total) - s) / total * 100).toFixed(3)}%` });
  const seekFrom = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (r.width <= 0) return;
    playerControls.seek(((e.clientX - r.left) / r.width) * total);
  };
  const dragging = useRef(false);
  const scrub = {
    onPointerDown: (e: PointerEvent) => { dragging.current = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); seekFrom(e); },
    onPointerMove: (e: PointerEvent) => { if (dragging.current) seekFrom(e); },
    onPointerUp: () => { dragging.current = false; },
  };

  const step = tickStep(total);
  const ticks: number[] = [];
  for (let t = 0; t <= total + 0.01; t += step) ticks.push(t);

  const rows: { key: string; label: string; body: ComponentChildren; hidden?: boolean }[] = [
    {
      key: 'video', label: 'Video', body: model.segs.map((s, i) => (
        <span key={i} class="vs-tlb vs-tlb-video" style={span(s.out, s.out + (s.end - s.start))} title={`Nguồn ${formatTimeDec(s.start)} – ${formatTimeDec(s.end)}`}>
          {formatTimeDec(s.start)}
        </span>
      )),
    },
    { key: 'hook', label: 'Hook', hidden: !data.hook, body: data.hook && <span class="vs-tlb vs-tlb-hook" style={span(data.hook.s, data.hook.e)} title={data.hook.label}>{data.hook.label}</span> },
    {
      key: 'caps', label: 'Phụ đề', hidden: data.captions.length === 0,
      body: data.captions.map((c, i) => <span key={i} class="vs-tlb vs-tlb-cap" style={span(c.s, c.e)} title={c.text}>{c.text}</span>),
    },
    {
      key: 'fx', label: 'Hiệu ứng', hidden: data.overlays.length === 0,
      body: data.overlays.map((o) => <span key={o.id} class="vs-tlb vs-tlb-fx" style={span(o.s, o.e)} title={o.label}>{o.label}</span>),
    },
    {
      key: 'broll', label: 'B-roll', hidden: data.brolls.length === 0,
      body: data.brolls.map((b) => <span key={b.id} class="vs-tlb vs-tlb-broll" style={span(b.s, b.e)} title={b.label}>{b.label}</span>),
    },
    {
      key: 'music', label: 'Nhạc', hidden: !plan.music,
      body: plan.music && <span class="vs-tlb vs-tlb-music" style={span(0, total)}>{plan.music.mood}{plan.music.duck ? ' · tự nhỏ khi đang nói' : ''}</span>,
    },
    {
      key: 'sfx', label: 'Tiếng động', hidden: plan.sfx.length === 0,
      body: plan.sfx.map((s, i) => <span key={i} class="vs-tl-diamond" style={{ left: pct(s.at) }} title={`Tiếng động ${formatTimeDec(s.at)}`} />),
    },
    {
      key: 'marks', label: 'Góp ý',
      body: marks.map((m, i) => (
        <button
          key={m.id}
          type="button"
          class={`vs-tl-pin${m.status !== 'draft' ? ' is-sent' : ''}`}
          style={{ left: pct(m.start) }}
          aria-label={`Góp ý ${i + 1} tại ${formatTimeDec(m.start)}`}
          onClick={(e) => { e.stopPropagation(); playerControls.seek(m.start); }}
        >{i + 1}</button>
      )),
    },
  ];

  return (
    <section class="vs-tl" aria-label="Dòng thời gian">
      <div class="vs-tl-row">
        <span class="vs-tl-label" />
        <div class="vs-tl-lane vs-tl-ruler" {...scrub} aria-hidden="true">
          {ticks.map((t, i) => (
            <span key={t} class="vs-tl-tick" style={{ left: pct(t), transform: i === ticks.length - 1 && t > total * 0.96 ? 'translateX(-100%)' : i === 0 ? 'none' : 'translateX(-50%)' }}>{formatTimeDec(t).replace(/\.0$/, '')}</span>
          ))}
        </div>
      </div>
      <div class="vs-tl-lanes">
        {rows.filter((r) => !r.hidden).map((r) => (
          <div class="vs-tl-row" key={r.key}>
            <span class="vs-tl-label">{r.label}</span>
            <div class="vs-tl-lane" onClick={seekFrom} role="presentation">{r.body}</div>
          </div>
        ))}
        <div class="vs-tl-playhead" aria-hidden="true" style={{ ['--f' as string]: String(Math.min(1, playerTime.value / total)) }} />
      </div>
    </section>
  );
}
