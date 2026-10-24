import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Hand, MousePointer2, Minus, Plus, Scan } from 'lucide-preact';

interface Camera { x: number; y: number; scale: number }
interface Point { x: number; y: number }
const MIN_SCALE = 0.08;
const MAX_SCALE = 2;
const CONTROL = 'inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-[12px] hover:bg-[var(--color-control-hover)] focus-visible:outline focus-visible:outline-[var(--color-accent)]';
const isEditor = (target: EventTarget | null) => target instanceof Element && !!target.closest('input, textarea, select, button, a, [contenteditable="true"], [data-canvas-controls]');

/** An unbounded camera over regular DOM content, so forms stay accessible. */
export function InfiniteCanvas({ children, width = 2100 }: { children: ComponentChildren; width?: number }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const camera = useRef<Camera>({ x: 48, y: 48, scale: 0.5 });
  const [view, setView] = useState(camera.current);
  const [hand, setHand] = useState(false);
  const [dragging, setDragging] = useState(false);
  const space = useRef(false);
  const pointers = useRef(new Map<number, Point>());
  const initialized = useRef(false);

  function move(next: Camera) { camera.current = next; setView(next); }
  function zoom(scale: number, anchor?: Point) {
    const box = viewport.current?.getBoundingClientRect();
    if (!box) return;
    const point = anchor ?? { x: box.width / 2, y: box.height / 2 };
    const old = camera.current;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    move({ x: point.x - (point.x - old.x) * next / old.scale, y: point.y - (point.y - old.y) * next / old.scale, scale: next });
  }
  function fit() {
    const box = viewport.current;
    const board = content.current;
    if (!box || !board) return;
    const scale = Math.max(MIN_SCALE, Math.min(1, (box.clientWidth - 64) / width, (box.clientHeight - 110) / board.offsetHeight));
    move({ x: (box.clientWidth - width * scale) / 2, y: Math.max(24, (box.clientHeight - board.offsetHeight * scale - 54) / 2), scale });
  }

  useEffect(() => {
    const box = viewport.current;
    const board = content.current;
    if (!box || !board) return;
    const observer = new ResizeObserver(() => {
      if (!initialized.current && box.clientHeight > 0 && board.offsetHeight > 0) {
        initialized.current = true;
        fit();
      }
    });
    observer.observe(box);
    observer.observe(board);
    // Non-passive: Ctrl+wheel must zoom the board instead of the browser.
    function wheel(event: WheelEvent) {
      if (isEditor(event.target) && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = box!.getBoundingClientRect();
      if (event.shiftKey) {
        move({ ...camera.current, x: camera.current.x - event.deltaY, y: camera.current.y - event.deltaX });
      } else {
        const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
        zoom(camera.current.scale * Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.008), { x: event.clientX - rect.left, y: event.clientY - rect.top });
      }
    }
    box.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); box.removeEventListener('wheel', wheel); };
  }, [width]);

  function endPointer(id: number) {
    pointers.current.delete(id);
    if (!pointers.current.size) setDragging(false);
  }

  return (
    <div ref={viewport} role="region" aria-label="Canvas vô hạn" tabIndex={0}
      class="relative flex-1 min-h-0 overflow-hidden outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
      style={{ touchAction: 'none', cursor: dragging ? 'grabbing' : hand ? 'grab' : 'default', backgroundColor: 'var(--color-bg)', backgroundImage: 'radial-gradient(circle, var(--color-border) 1px, transparent 1px)', backgroundSize: `${32 * view.scale}px ${32 * view.scale}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
      onPointerDown={event => {
        if (isEditor(event.target) || (event.button !== 0 && event.button !== 1)) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={event => {
        const previous = pointers.current.get(event.pointerId);
        if (!previous) return;
        const next = { x: event.clientX, y: event.clientY };
        const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
        if (other) {
          const before = Math.hypot(previous.x - other.x, previous.y - other.y);
          const after = Math.hypot(next.x - other.x, next.y - other.y);
          const rect = event.currentTarget.getBoundingClientRect();
          if (before > 0) zoom(camera.current.scale * after / before, { x: (previous.x + other.x) / 2 - rect.left, y: (previous.y + other.y) / 2 - rect.top });
          move({ ...camera.current, x: camera.current.x + (next.x - previous.x) / 2, y: camera.current.y + (next.y - previous.y) / 2 });
        } else {
          move({ ...camera.current, x: camera.current.x + next.x - previous.x, y: camera.current.y + next.y - previous.y });
        }
        pointers.current.set(event.pointerId, next);
      }}
      onPointerUp={event => endPointer(event.pointerId)}
      onPointerCancel={event => endPointer(event.pointerId)}
      onLostPointerCapture={event => endPointer(event.pointerId)}
      onKeyDown={event => {
        if (isEditor(event.target)) return;
        if (event.key === ' ') { event.preventDefault(); space.current = true; setHand(true); }
        else if (['+', '=', '-', '0', 'f', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault();
          if (event.key === 'f') fit();
          else if (event.key === '0') zoom(1);
          else if (event.key === '-') zoom(camera.current.scale / 1.2);
          else if (event.key === '+' || event.key === '=') zoom(camera.current.scale * 1.2);
          else move({ ...camera.current, x: camera.current.x + (event.key === 'ArrowLeft' ? 80 : event.key === 'ArrowRight' ? -80 : 0), y: camera.current.y + (event.key === 'ArrowUp' ? 80 : event.key === 'ArrowDown' ? -80 : 0) });
        }
      }}
      onKeyUp={event => { if (event.key === ' ' && space.current) { space.current = false; setHand(false); } }}
      onBlur={() => { if (space.current) { space.current = false; setHand(false); } }}
    >
      <div ref={content} data-canvas-board style={{ width, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: '0 0', position: 'absolute', left: 0, top: 0 }}>
        <div style={{ pointerEvents: hand || space.current ? 'none' : 'auto' }}>{children}</div>
      </div>
      <div data-canvas-controls class="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-1.5 shadow-xl whitespace-nowrap max-w-[calc(100%-16px)]">
        <button type="button" class={CONTROL} aria-label="Chế độ chỉnh sửa" aria-pressed={!hand} onClick={() => setHand(false)}><MousePointer2 size={16} /></button>
        <button type="button" class={CONTROL} aria-label="Chế độ kéo canvas" aria-pressed={hand} onClick={() => setHand(true)}><Hand size={16} /></button>
        <span class="h-5 border-l border-[var(--color-border)] mx-1" />
        <button type="button" class={CONTROL} aria-label="Thu nhỏ" disabled={view.scale <= MIN_SCALE} onClick={() => zoom(camera.current.scale / 1.2)}><Minus size={16} /></button>
        <button type="button" class={`${CONTROL} min-w-16 tabular-nums`} aria-label="Zoom 100%" onClick={() => zoom(1)}>{Math.round(view.scale * 100)}%</button>
        <button type="button" class={CONTROL} aria-label="Phóng to" disabled={view.scale >= MAX_SCALE} onClick={() => zoom(camera.current.scale * 1.2)}><Plus size={16} /></button>
        <button type="button" class={CONTROL} aria-label="Vừa khung" onClick={fit}><Scan size={16} /><span class="hidden sm:inline">Vừa khung</span></button>
      </div>
      <p data-canvas-controls class="absolute top-3 left-4 text-[11px] text-[var(--color-text-muted)] rounded-md bg-[var(--color-bg)]/90 px-2 py-1 pointer-events-none">Kéo nền để di chuyển · Cuộn để zoom · Space để kéo trên ô · F vừa khung</p>
    </div>
  );
}
