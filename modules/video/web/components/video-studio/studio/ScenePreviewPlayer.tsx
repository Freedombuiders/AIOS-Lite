/**
 * Plays the finished scenes back to back like one video (before assembly): two <video> elements,
 * the next one preloaded and swapped on "ended", one scrubber across the whole length.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Pause, Play, SkipBack } from 'lucide-preact';

import { productionApi } from '@modules/video/web/lib/video-production-api';
import { fmtSec, locateAt, previewPlaylist, type Production } from '@modules/video/web/lib/video-production';

const frame = (aspect: Production['aspect']) => (aspect === '16:9' ? '16 / 9' : aspect === '1:1' ? '1 / 1' : aspect === '4:5' ? '4 / 5' : '9 / 16');
const stageWidth = (aspect: Production['aspect']) => (aspect === '16:9' ? '860px' : aspect === '1:1' ? '560px' : aspect === '4:5' ? '480px' : '380px');

export function ScenePreviewPlayer({ p }: { p: Production }) {
  const { items, total } = useMemo(() => previewPlaylist(p.scenes), [p.scenes]);
  const refs = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];
  const [slot, setSlot] = useState(0);
  const [pos, setPos] = useState(0);
  const [cur, setCur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const missing = p.scenes.length - items.length;

  // The media fragment starts each take at its trim point; the end of the trimmed part is watched in onTimeUpdate.
  const src = (i: number) => {
    const it = items[i];
    if (!it) return '';
    const s = p.scenes.find((x) => x.id === it.sceneId)!;
    return `${productionApi.sceneMedia(p.id, it.sceneId, 'video', s.updatedAt)}#t=${it.trimStart}`;
  };

  // Load the current item in the active slot and preload the next one in the other.
  useEffect(() => {
    const a = refs[slot].current, b = refs[1 - slot].current;
    if (a && items[cur] && a.getAttribute('data-i') !== String(cur)) { a.src = src(cur); a.setAttribute('data-i', String(cur)); }
    if (b && items[cur + 1] && b.getAttribute('data-i') !== String(cur + 1)) { b.src = src(cur + 1); b.setAttribute('data-i', String(cur + 1)); b.load(); }
  }, [cur, slot, items]);

  const onEnded = () => {
    refs[slot].current?.pause();
    if (cur + 1 >= items.length) { setPlaying(false); return; }
    const next = 1 - slot;
    setSlot(next);
    setCur(cur + 1);
    const v = refs[next].current;
    if (v) { v.currentTime = items[cur + 1].trimStart; void v.play().catch(() => setPlaying(false)); }
  };

  const onTime = (el: HTMLVideoElement) => {
    const it = items[cur];
    if (!it) return;
    const inScene = el.currentTime - it.trimStart;
    setPos(it.start + Math.max(0, Math.min(it.durationSec, inScene)));
    if (!el.paused && inScene >= it.durationSec - 0.04) onEnded();
  };

  const toggle = () => {
    const v = refs[slot].current;
    if (!v) return;
    if (v.paused) { void v.play().then(() => setPlaying(true)).catch(() => setPlaying(false)); } else { v.pause(); setPlaying(false); }
  };

  const seek = (t: number) => {
    const hit = locateAt(items, t);
    if (!hit) return;
    const i = items.indexOf(hit.item);
    const v = refs[slot].current;
    if (i !== cur) { setCur(i); if (v) { v.src = src(i); v.setAttribute('data-i', String(i)); } }
    requestAnimationFrame(() => { const el = refs[slot].current; if (el) { el.currentTime = hit.item.trimStart + hit.offset; if (playing) void el.play(); } });
    setPos(t);
  };

  if (!items.length) {
    return <div class="vx-preview-empty"><p>Chưa có cảnh nào tạo xong để xem thử.</p><p class="vp-faint">Duyệt chi phí ở phần Phân cảnh, các cảnh xong sẽ phát nối tiếp ở đây.</p></div>;
  }

  return (
    <div class="vx-preview">
      <div class="vx-preview-stage" style={{ aspectRatio: frame(p.aspect), maxWidth: stageWidth(p.aspect) }}>
        {refs.map((r, i) => (
          <video
            key={i} ref={r} playsInline preload="auto" class={i === slot ? 'is-on' : ''}
            onTimeUpdate={(e) => { if (i === slot) onTime(e.currentTarget); }}
            onEnded={() => { if (i === slot) onEnded(); }}
            onPlay={() => { if (i === slot) setPlaying(true); }}
            onPause={() => { if (i === slot && !e_ended(r.current)) setPlaying(false); }}
          />
        ))}
        <span class="vx-preview-badge">Cảnh {items[cur] ? items[cur].index + 1 : '–'} / {p.scenes.length}</span>
      </div>
      <div class="vx-preview-bar">
        <button type="button" class="vp-icon-btn" aria-label="Về đầu" onClick={() => seek(0)}><SkipBack size={15} /></button>
        <button type="button" class="vx-play" aria-label={playing ? 'Dừng' : 'Phát'} onClick={toggle}>{playing ? <Pause size={16} /> : <Play size={16} />}</button>
        <div class="vx-scrub" role="slider" aria-label="Vị trí" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.round(pos)} tabIndex={0}
          onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * total); }}
          onKeyDown={(e) => { if (e.key === 'ArrowRight') seek(pos + 2); if (e.key === 'ArrowLeft') seek(pos - 2); }}>
          {items.map((it) => <i key={it.sceneId} class={it.index === items[cur]?.index ? 'is-on' : ''} style={{ left: `${(it.start / total) * 100}%`, width: `${(it.durationSec / total) * 100}%` }} />)}
          <b style={{ left: `${(pos / total) * 100}%` }} />
        </div>
        <span class="vp-faint vx-time">{fmtSec(pos)} / {fmtSec(total)}</span>
      </div>
      {missing > 0 && <p class="vp-faint" style={{ fontSize: '11.5px' }}>{missing} cảnh chưa tạo xong nên chưa có trong bản xem thử.</p>}
    </div>
  );
}

function e_ended(v: HTMLVideoElement | null): boolean {
  return Boolean(v?.ended);
}
