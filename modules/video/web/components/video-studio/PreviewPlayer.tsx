// <hyperframes-player> wrapper: live preview of the plan's composition + simple transport controls.
// The composition is built server-side per plan version (…/composition/preview.html?v=N, proxy media).
import { useEffect, useRef, useState } from 'preact/hooks';
import { MapPin, Pause, Play, RefreshCw } from 'lucide-preact';
import { previewUrl } from '@modules/video/web/lib/video-edit/api';
import { aspectSize, formatTimeDec } from '@modules/video/web/lib/video-edit/format';
import { playerControls, playerPlaying, playerTime, startMark } from '@modules/video/web/lib/video-edit/editor';
import type { VideoAspect } from '@modules/video/web/lib/video-edit/types';

interface HFPlayer extends HTMLElement {
  play(): void;
  pause(): void;
  seek(t: number): void;
  readonly paused: boolean;
  readonly duration: number;
  currentTime: number;
}

let registered: Promise<unknown> | null = null;
function ensurePlayerLoaded() {
  // Code-split: the web component (@hyperframes/player, Apache-2.0) is only needed on the editor screen.
  if (!registered) registered = import('@hyperframes/player').catch((err) => { registered = null; throw err; });
  return registered;
}

export function PreviewPlayer({ projectId, version, aspect, total, readOnly }: {
  projectId: string;
  version: number;
  aspect: VideoAspect;
  /** Output duration the plan model expects (shown until the player reports its own). */
  total: number;
  readOnly?: boolean;
}) {
  const elRef = useRef<HFPlayer | null>(null);
  const lastT = useRef(0);
  const firstSrc = useRef(true);
  const [nonce, setNonce] = useState(0);
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);
  const [duration, setDuration] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const src = previewUrl(projectId, version, nonce);
  const { w, h } = aspectSize(aspect);

  useEffect(() => { void ensurePlayerLoaded().then(() => setLoaded(true)).catch(() => setSlow(true)); }, []);

  // Listeners + imperative hooks for the timeline/transcript.
  useEffect(() => {
    const el = elRef.current;
    if (!el || !loaded) return;
    const onTime = (e: Event) => {
      const t = (e as CustomEvent<{ currentTime: number }>).detail?.currentTime;
      if (typeof t === 'number') { lastT.current = t; playerTime.value = t; }
    };
    const onReady = () => { setReady(true); setSlow(false); try { setDuration(el.duration || 0); } catch { /* not ready */ } };
    const onPlay = () => { playerPlaying.value = true; };
    const onPause = () => { playerPlaying.value = false; };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('ready', onReady);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onPause);
    playerControls.seek = (t) => {
      const max = el.duration || total || t;
      const to = Math.max(0, Math.min(t, Math.max(0, max - 0.04)));
      lastT.current = to; playerTime.value = to;
      try { el.seek(to); } catch { /* player not ready */ }
    };
    playerControls.toggle = () => { try { if (el.paused) el.play(); else el.pause(); } catch { /* not ready */ } };
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('ready', onReady);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onPause);
      playerControls.seek = () => {};
      playerControls.toggle = () => {};
      playerPlaying.value = false;
    };
  }, [loaded]);

  // A new plan version / retry reloads the composition: come back to where the owner was.
  useEffect(() => {
    const el = elRef.current;
    setReady(false);
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), 20000);
    if (firstSrc.current) { firstSrc.current = false; return () => clearTimeout(timer); }
    const t = lastT.current;
    const restore = () => { try { el?.seek(Math.max(0, t)); } catch { /* ignore */ } };
    el?.addEventListener('ready', restore, { once: true });
    return () => { clearTimeout(timer); el?.removeEventListener('ready', restore); };
  }, [src]);

  const t = playerTime.value;
  const len = duration || total;
  const seekBy = (d: number) => playerControls.seek(playerTime.value + d);

  return (
    <div class="vs-pp">
      <div class={`vs-pp-stage${ready ? ' is-ready' : ''}`} style={{ aspectRatio: `${w} / ${h}`, ['--ar' as string]: (w / h).toFixed(4) }}>
        {loaded && <hyperframes-player ref={elRef as never} src={src} width={w} height={h} class="vs-pp-el" />}
        {!ready && (
          <div class="vs-pp-overlay" role="status">
            {slow ? (
              <>
                <span>Bản xem trước chưa sẵn sàng.</span>
                <button type="button" class="vs-btn" onClick={() => setNonce((n) => n + 1)}><RefreshCw size={14} aria-hidden="true" /> Thử lại</button>
              </>
            ) : <span>Đang dựng bản xem trước…</span>}
          </div>
        )}
      </div>
      <div class="vs-pp-controls">
        <button type="button" class="vs-btn vs-pp-btn" aria-label="Lùi 1 giây" onClick={() => seekBy(-1)}>−1s</button>
        <button type="button" class="vs-btn vs-btn-accent vs-pp-btn vs-pp-play" aria-label={playerPlaying.value ? 'Tạm dừng' : 'Phát'} onClick={() => playerControls.toggle()}>
          {playerPlaying.value ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" fill="currentColor" />}
        </button>
        <button type="button" class="vs-btn vs-pp-btn" aria-label="Tới 1 giây" onClick={() => seekBy(1)}>+1s</button>
        <span class="vs-pp-time" aria-label="Thời điểm hiện tại">{formatTimeDec(t)} <span class="vs-faint">/ {formatTimeDec(len)}</span></span>
      </div>
      <button type="button" class="vs-btn vs-pp-mark" disabled={readOnly} onClick={() => startMark({ start: playerTime.value, end: undefined })}>
        <MapPin size={15} aria-hidden="true" /> Đánh dấu chỗ này
      </button>
      <p class="vs-faint vs-pp-hint">Bản nháp v{version}: xem nhanh, chưa xuất. Sửa xong bản xem cập nhật ngay.</p>
    </div>
  );
}
