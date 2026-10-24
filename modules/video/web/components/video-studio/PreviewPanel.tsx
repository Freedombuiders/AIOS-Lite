// "Xem trước": player (source / final), media info, and the keep/removed timeline.
import { mediaUrl } from '@modules/video/web/lib/video-edit/api';
import { formatBytes, formatClock } from '@modules/video/web/lib/video-edit/format';
import { previewKind, project } from '@modules/video/web/lib/video-edit/studio';
import type { EditPlan, RemovedKind, VideoProject } from '@modules/video/web/lib/video-edit/types';
import { REMOVED_LABEL } from './cards';

export function PreviewPanel() {
  const p = project.value;
  if (!p?.source) {
    return <p class="vs-muted vs-pad">Chưa có video để xem. Thả video quay thô vào khung chat để bắt đầu.</p>;
  }
  const hasFinal = !!p.outputs.final;
  const kind = hasFinal && previewKind.value === 'final' ? 'final' : 'source';
  const src = kind === 'final' ? mediaUrl(p.id, 'final', p.updatedAt) : mediaUrl(p.id, 'source', p.source.sizeBytes);
  return (
    <div class="vs-preview">
      {hasFinal && (
        <div class="vs-seg vs-seg-small" role="group" aria-label="Chọn bản xem">
          <button type="button" class={kind === 'source' ? 'is-active' : ''} aria-pressed={kind === 'source'} onClick={() => { previewKind.value = 'source'; }}>Video gốc</button>
          <button type="button" class={kind === 'final' ? 'is-active' : ''} aria-pressed={kind === 'final'} onClick={() => { previewKind.value = 'final'; }}>Bản dựng</button>
        </div>
      )}
      <video
        key={src}
        class="vs-player"
        src={src}
        poster={kind === 'source' ? mediaUrl(p.id, 'thumb', p.source.sizeBytes) : undefined}
        controls
        preload="metadata"
        playsInline
      />
      <MediaTable p={p} />
      <TimelineBar plan={p.plan} />
    </div>
  );
}

function MediaTable({ p }: { p: VideoProject }) {
  const s = p.source!;
  const rows: [string, string][] = [
    ['File', s.fileName],
    ['Thời lượng', formatClock(s.durationSec)],
    ['Độ phân giải', `${s.width}×${s.height}`],
    ['Khung hình', `${Math.round(s.fps * 100) / 100} fps`],
    ['Codec', `${s.videoCodec}${s.hasAudio ? ` / ${s.audioCodec ?? 'âm thanh'}` : ' · không có tiếng'}`],
    ...(s.rotation ? [['Xoay', `${s.rotation}°`] as [string, string]] : []),
    ['Dung lượng', formatBytes(s.sizeBytes)],
  ];
  return (
    <dl class="vs-info">
      {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd title={v}>{v}</dd></div>)}
    </dl>
  );
}

const KIND_ORDER: RemovedKind[] = ['silence', 'filler', 'retake', 'offtopic'];

function TimelineBar({ plan }: { plan?: EditPlan }) {
  if (!plan || plan.sourceDurationSec <= 0) {
    return (
      <section class="vs-timeline" aria-label="Dòng thời gian">
        <div class="vs-eyebrow">Dòng thời gian</div>
        <div class="vs-tl-bar vs-tl-empty" />
        <p class="vs-faint vs-tl-note">Chưa có kế hoạch cắt</p>
      </section>
    );
  }
  const total = plan.sourceDurationSec;
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / total) * 100))}%`;
  const used = KIND_ORDER.filter((k) => plan.removed.some((r) => r.kind === k));
  return (
    <section class="vs-timeline" aria-label="Dòng thời gian cắt">
      <div class="vs-eyebrow">Dòng thời gian · {formatClock(plan.sourceDurationSec)} → {formatClock(plan.outputDurationSec)}</div>
      <div class="vs-tl-bar" role="img" aria-label={`Giữ ${plan.keep.length} đoạn, bỏ ${plan.removed.length} đoạn`}>
        {plan.keep.map((k, i) => <span key={`k${i}`} class="vs-tl-seg vs-tl-keep" style={{ left: pct(k.start), width: pct(k.end - k.start) }} />)}
        {plan.removed.map((r, i) => <span key={`r${i}`} class={`vs-tl-seg vs-tl-rm vs-tl-${r.kind}`} style={{ left: pct(r.start), width: pct(r.end - r.start) }} title={`${REMOVED_LABEL[r.kind]}${r.text ? `: ${r.text}` : ''}`} />)}
      </div>
      <ul class="vs-tl-legend">
        <li><i class="vs-tl-keep" /> Giữ</li>
        {used.map((k) => <li key={k}><i class={`vs-tl-${k}`} /> {REMOVED_LABEL[k]}</li>)}
      </ul>
    </section>
  );
}
