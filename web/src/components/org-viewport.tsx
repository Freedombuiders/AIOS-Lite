import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Maximize2, Minus, Plus } from 'lucide-preact';
import { clampZoom, fitToViewport, initialView, zoomAround, type Bounds, type Point, type View } from '@/lib/org-layout';

const MOVE_THRESHOLD = 6;

interface Gesture {
  kind: 'pan' | 'pinch';
  startPoint: Point;
  startView: View;
  startDistance: number;
  startCenter: Point;
  moved: boolean;
}

interface Props {
  bounds: Bounds;
  /** Chart x the first view centers on when the chart is too wide to fit readably. */
  anchorX: number;
  /** Connector lines, drawn in chart coordinates under the cards. */
  edges: ComponentChildren;
  /** Cards, positioned absolutely in chart coordinates. */
  children: ComponentChildren;
}

const CONTROL = 'flex size-9 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-text-muted)] hover:bg-[var(--color-elevated)] hover:text-[var(--color-text)] touch-manipulation';

/**
 * Pan and zoom surface for the org chart: drag to pan, wheel or pinch to zoom,
 * buttons for zoom and "vừa màn hình". Pointer events cover mouse, touch and pen
 * with one code path; a drag never counts as a click on a card.
 */
export function OrgViewport({ bounds, anchorX, edges, children }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setViewState] = useState<View>({ zoom: 1, pan: { x: 0, y: 0 } });
  const viewRef = useRef(view);
  const [dragging, setDragging] = useState(false);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const suppressTimer = useRef<number | null>(null);
  const initialized = useRef(false);

  const setView = (next: View) => { viewRef.current = next; setViewState(next); };
  const local = (clientX: number, clientY: number): Point => {
    const r = box.current!.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };

  // First view once the box has a size.
  useEffect(() => {
    if (initialized.current) return;
    let frame = 0;
    const apply = () => {
      const el = box.current;
      if (!el || initialized.current) return;
      const next = initialView(el.clientWidth, el.clientHeight, bounds, anchorX);
      if (next) { initialized.current = true; setView(next); } else frame = requestAnimationFrame(apply);
    };
    apply();
    return () => cancelAnimationFrame(frame);
  }, [bounds.width, bounds.height, anchorX]);

  // Re-fit after a real size change (window resize, phone rotation) unless the user has
  // panned or zoomed since the last automatic fit.
  const fittedWidth = useRef(0);
  const autoView = useRef<View | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!initialized.current) return;
      const w = el.clientWidth;
      if (fittedWidth.current === 0) { fittedWidth.current = w; autoView.current = viewRef.current; return; }
      if (Math.abs(w - fittedWidth.current) / fittedWidth.current < 0.15) return;
      if (autoView.current !== viewRef.current) { fittedWidth.current = w; return; }
      const next = initialView(w, el.clientHeight, bounds, anchorX);
      if (next) { fittedWidth.current = w; autoView.current = next; setView(next); }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [bounds.width, bounds.height, anchorX]);

  // Wheel must be non-passive to stop the page scrolling under the chart.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const factor = Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0016));
      const r = el.getBoundingClientRect();
      setView(zoomAround(viewRef.current, viewRef.current.zoom * factor, { x: e.clientX - r.left, y: e.clientY - r.top }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => () => { if (suppressTimer.current !== null) window.clearTimeout(suppressTimer.current); }, []);

  const startPan = (p: Point, moved: boolean) => {
    gesture.current = { kind: 'pan', startPoint: p, startView: viewRef.current, startDistance: 0, startCenter: p, moved };
  };
  const startPinch = () => {
    const [a, b] = [...pointers.current.values()];
    gesture.current = {
      kind: 'pinch', startPoint: a, startView: viewRef.current, startDistance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      startCenter: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, moved: true,
    };
  };

  const onPointerDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-org-control]')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.current.set(e.pointerId, local(e.clientX, e.clientY));
    if (pointers.current.size === 1) startPan(local(e.clientX, e.clientY), false);
    else if (pointers.current.size === 2) startPinch();
  };

  const onPointerMove = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId)) return;
    const p = local(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, p);
    if (g.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const zoom = clampZoom(g.startView.zoom * (dist / g.startDistance));
      const k = zoom / g.startView.zoom;
      setView({
        zoom,
        pan: { x: center.x - k * (g.startCenter.x - g.startView.pan.x), y: center.y - k * (g.startCenter.y - g.startView.pan.y) },
      });
      return;
    }
    if (g.kind !== 'pan') return;
    const dx = p.x - g.startPoint.x;
    const dy = p.y - g.startPoint.y;
    if (!g.moved && Math.hypot(dx, dy) > MOVE_THRESHOLD) {
      g.moved = true;
      setDragging(true);
      try { box.current?.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    }
    if (g.moved) setView({ zoom: g.startView.zoom, pan: { x: g.startView.pan.x + dx, y: g.startView.pan.y + dy } });
  };

  const onPointerEnd = (e: PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (pointers.current.size === 1) {
      // One finger left after a pinch: keep panning from where it is, never as a tap.
      startPan([...pointers.current.values()][0], true);
      return;
    }
    if (pointers.current.size === 0) {
      if (g?.moved) {
        suppressClick.current = true;
        if (suppressTimer.current !== null) window.clearTimeout(suppressTimer.current);
        suppressTimer.current = window.setTimeout(() => { suppressClick.current = false; suppressTimer.current = null; }, 350);
      }
      gesture.current = null;
      setDragging(false);
    }
  };

  const onClickCapture = (e: MouseEvent) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  const center = (): Point => ({ x: (box.current?.clientWidth ?? 0) / 2, y: (box.current?.clientHeight ?? 0) / 2 });
  const zoomBy = (factor: number) => setView(zoomAround(viewRef.current, viewRef.current.zoom * factor, center()));
  const fit = () => {
    const el = box.current;
    const next = el && fitToViewport(el.clientWidth, el.clientHeight, bounds);
    if (next) setView(next);
  };

  const { zoom, pan } = view;
  return <div
    ref={box}
    data-testid="org-chart-viewport"
    class="relative min-h-[420px] w-full flex-1 min-w-0 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] select-none"
    style={{ cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none', overscrollBehavior: 'contain' }}
    onPointerDown={onPointerDown as never}
    onPointerMove={onPointerMove as never}
    onPointerUp={onPointerEnd as never}
    onPointerCancel={onPointerEnd as never}
    onClickCapture={onClickCapture as never}
  >
    <div data-org-control class="absolute right-3 top-3 z-10 flex flex-col gap-1.5">
      <button type="button" class={CONTROL} onClick={() => zoomBy(1.2)} aria-label="Phóng to" title="Phóng to"><Plus size={16} /></button>
      <button type="button" class={CONTROL} onClick={() => zoomBy(1 / 1.2)} aria-label="Thu nhỏ" title="Thu nhỏ"><Minus size={16} /></button>
      <button type="button" class={CONTROL} onClick={fit} aria-label="Vừa màn hình" title="Vừa màn hình"><Maximize2 size={15} /></button>
    </div>
    <svg class="pointer-events-none absolute inset-0" width="100%" height="100%" aria-hidden="true">
      <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>{edges}</g>
    </svg>
    <div class="absolute inset-0" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}>
      {children}
    </div>
  </div>;
}
