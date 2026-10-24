import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Brain, Folder, Maximize2, Network, ZoomIn, ZoomOut } from 'lucide-preact';

type Note = { id: string; title: string; folder: string };
type Edge = { source: string; target: string };
type View = { k: number; x: number; y: number };
type Pt = { x: number; y: number };

const colors = ['#a74e78', '#427caf', '#8b65b1', '#b08036', '#3a8c7c', '#b85b50'];
const MIN_K = .25;
const MAX_K = 12;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const short = (s: string, n = 28) => s.length > n ? `${s.slice(0, n - 1)}…` : s;

export function BrainVaultGraph({ notes, edges, selected, matched, showFiles, onToggleFiles, onSelect }: {
  notes: Note[]; edges: Edge[]; selected: string | null; matched: Set<string> | null;
  showFiles: boolean; onToggleFiles: () => void; onSelect: (id: string | null) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const [depth, setDepth] = useState(1);
  const viewRef = useRef(view);
  viewRef.current = view;
  const touched = useRef(false);
  const lastKey = useRef('');
  const pointers = useRef(new Map<number, Pt>());
  const drag = useRef<{ sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);
  const pinch = useRef<{ d: number; k: number; x: number; y: number; mx: number; my: number } | null>(null);
  const suppressClick = useRef(false);

  // Global layout: one cluster per top-level folder.
  const layout = useMemo(() => {
    const groups = [...new Set(notes.map(n => n.folder.split('/')[0] || 'Ghi chú gốc'))];
    const positions = new Map<string, Pt & { color: string }>();
    const clusters = groups.map((name, i) => {
      const angle = i / Math.max(groups.length, 1) * Math.PI * 2 - Math.PI / 2;
      const x = 500 + (groups.length > 1 ? Math.cos(angle) * 265 : 0);
      const y = 340 + (groups.length > 1 ? Math.sin(angle) * 200 : 0);
      const members = notes.filter(n => (n.folder.split('/')[0] || 'Ghi chú gốc') === name);
      const color = colors[i % colors.length];
      const spread = Math.min(145, 35 + Math.sqrt(members.length) * 8);
      members.forEach((n, j) => {
        const radius = Math.sqrt((j + .5) / members.length) * spread;
        positions.set(n.id, { x: x + Math.cos(j * 2.39996) * radius, y: y + Math.sin(j * 2.39996) * radius, color });
      });
      return { name, x, y: Math.max(32, y - spread - 30), count: members.length };
    });
    return { positions, clusters };
  }, [notes]);

  const titles = useMemo(() => new Map(notes.map(n => [n.id, n.title])), [notes]);
  const validEdges = useMemo(() => edges.filter(e => e.source !== e.target && layout.positions.has(e.source) && layout.positions.has(e.target)), [edges, layout]);
  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of validEdges) {
      (m.get(e.source) || m.set(e.source, new Set()).get(e.source)!).add(e.target);
      (m.get(e.target) || m.set(e.target, new Set()).get(e.target)!).add(e.source);
    }
    return m;
  }, [validEdges]);

  // Focus mode (Obsidian-style local graph): selected note + neighbours up to `depth`, laid out in rings.
  const focus = useMemo(() => {
    if (!selected || !layout.positions.has(selected)) return null;
    const level = new Map<string, number>([[selected, 0]]);
    const parent = new Map<string, string>();
    let frontier = [selected];
    for (let d = 1; d <= depth; d++) {
      const next: string[] = [];
      for (const id of frontier) for (const nb of adj.get(id) || []) if (!level.has(nb)) { level.set(nb, d); parent.set(nb, id); next.push(nb); }
      frontier = next;
    }
    const pos = new Map<string, Pt>([[selected, { x: 500, y: 340 }]]);
    const angle = new Map<string, number>([[selected, 0]]);
    let prevRadius = 0;
    for (let d = 1; d <= depth; d++) {
      const ring = [...level].filter(([, l]) => l === d).map(([id]) => id);
      if (!ring.length) break;
      ring.sort((a, b) => (angle.get(parent.get(a)!) ?? 0) - (angle.get(parent.get(b)!) ?? 0) || (titles.get(a) || '').localeCompare(titles.get(b) || ''));
      const radius = Math.max(prevRadius + 150, ring.length * 36 / (2 * Math.PI));
      ring.forEach((id, i) => {
        const a = -Math.PI / 2 + i / ring.length * Math.PI * 2;
        angle.set(id, a);
        pos.set(id, { x: 500 + Math.cos(a) * radius, y: 340 + Math.sin(a) * radius });
      });
      prevRadius = radius;
    }
    return { pos, level, edges: validEdges.filter(e => pos.has(e.source) && pos.has(e.target)) };
  }, [selected, depth, adj, layout, titles, validEdges]);

  const shownNotes = focus ? notes.filter(n => focus.pos.has(n.id)) : notes;
  const shownEdges = focus ? focus.edges : validEdges;
  const pos = (id: string): Pt => (focus ? focus.pos.get(id) : layout.positions.get(id))!;
  const emph = hover ? new Set([hover, ...(adj.get(hover) || [])]) : null;

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      const r = entries[0].contentRect;
      setSize(s => (Math.abs(s.w - r.width) < 1 && Math.abs(s.h - r.height) < 1) ? s : { w: r.width, h: r.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [notes.length > 0]);

  function fit() {
    const pts = focus ? [...focus.pos.values()] : [...layout.positions.values()];
    if (!pts.length || !size.w || !size.h) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const pad = focus ? 90 : 70;
    const k = clamp(Math.min((size.w - 2 * pad) / Math.max(maxX - minX, 1), (size.h - 2 * pad) / Math.max(maxY - minY, 1)), MIN_K, focus ? 2.2 : 3);
    setView({ k, x: size.w / 2 - k * (minX + maxX) / 2, y: size.h / 2 - k * (minY + maxY) / 2 });
  }
  const fitKey = `${focus ? selected : ''}|${depth}`;
  useEffect(() => {
    if (lastKey.current !== fitKey) { lastKey.current = fitKey; touched.current = false; }
    if (!touched.current) fit();
  }, [fitKey, size.w, size.h, layout]);

  function zoomAt(factor: number, mx: number, my: number) {
    touched.current = true;
    setView(v => { const k = clamp(v.k * factor, MIN_K, MAX_K); return { k, x: mx - (mx - v.x) * k / v.k, y: my - (my - v.y) * k / v.k }; });
  }
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? .01 : .0018)), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [notes.length > 0]);

  function local(e: PointerEvent): Pt { const r = svgRef.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function onPointerDown(e: PointerEvent) {
    suppressClick.current = false;
    pointers.current.set(e.pointerId, local(e));
    const v = viewRef.current;
    if (pointers.current.size === 1) drag.current = { sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y, moved: false };
    else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: v.k, x: v.x, y: v.y, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      if (drag.current) drag.current.moved = true;
    }
  }
  function onPointerMove(e: PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const p = pinch.current;
      const k = clamp(p.k * (Math.hypot(a.x - b.x, a.y - b.y) || 1) / p.d, MIN_K, MAX_K);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      touched.current = true; suppressClick.current = true;
      setView({ k, x: mx - (p.mx - p.x) * k / p.k, y: my - (p.my - p.y) * k / p.k });
      return;
    }
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) > 4) { d.moved = true; svgRef.current?.setPointerCapture(e.pointerId); }
    if (d.moved) { touched.current = true; suppressClick.current = true; setView(v => ({ ...v, x: d.vx + dx, y: d.vy + dy })); }
  }
  function onPointerUp(e: PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (!pointers.current.size) drag.current = null;
  }
  function choose(id: string) { if (!suppressClick.current && id !== selected) onSelect(id); }

  const { k } = view;
  const labelOf = (id: string) => short(titles.get(id) || id, focus ? 30 : 24);
  const inView = (p: Pt) => { const sx = view.x + p.x * k, sy = view.y + p.y * k; return sx > -20 && sx < size.w + 20 && sy > -20 && sy < size.h + 20; };
  const zoomCenter = (f: number) => zoomAt(f, size.w / 2, size.h / 2);

  return <section class="sb-graph" aria-label="Đồ thị ghi chú">
    <div class="sb-graph-tools">
      <div>
        <button class="sb-button" aria-pressed={showFiles} onClick={onToggleFiles}><Folder size={16} />Thư mục</button>
        {focus && <>
          <button class="sb-button" onClick={() => onSelect(null)}><Network size={16} />Hiện toàn bộ</button>
          <div class="sb-depth" role="group" aria-label="Độ sâu liên kết">
            {[1, 2, 3].map(d => <button key={d} class="sb-button" aria-pressed={depth === d} onClick={() => setDepth(d)} title={`Hiện liên kết ${d} bước`}>{d} bước</button>)}
          </div>
        </>}
      </div>
      <div>
        <button class="sb-button" aria-label="Thu nhỏ đồ thị" onClick={() => zoomCenter(1 / 1.4)}><ZoomOut size={16} /></button>
        <span class="sb-zoom-level" aria-live="off">{Math.round(k * 100)}%</span>
        <button class="sb-button" aria-label="Phóng to đồ thị" onClick={() => zoomCenter(1.4)}><ZoomIn size={16} /></button>
        <button class="sb-button" aria-label="Đặt lại đồ thị" onClick={() => { touched.current = false; fit(); }}><Maximize2 size={16} /></button>
      </div>
    </div>
    {!notes.length ? <div class="sb-empty"><Brain size={40} /><h2>Thư mục chưa có ghi chú</h2><p>Thêm tệp Markdown (.md), rồi nhấn Làm mới.</p></div> : <>
      <svg ref={svgRef} class="sb-network" aria-label="Mạng liên kết giữa các ghi chú" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <g transform={`translate(${view.x} ${view.y}) scale(${k})`}>
          {shownEdges.map(e => {
            const a = pos(e.source), b = pos(e.target);
            const hot = selected === e.source || selected === e.target || (emph ? hover === e.source || hover === e.target : false);
            const dim = emph && !hot;
            return <line key={`${e.source}:${e.target}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" opacity={hot ? .7 : dim ? .04 : focus ? .4 : .12} />;
          })}
          {shownNotes.map(n => {
            const p = pos(n.id);
            const isSel = selected === n.id;
            const deg = adj.get(n.id)?.size || 0;
            const r = (isSel ? 7 : 3.2 + Math.min(Math.sqrt(deg), 6) * .7) / k;
            const searchDim = matched && !matched.has(n.id);
            const hoverDim = emph && !emph.has(n.id);
            const showLabel = !!focus || isSel || (emph?.has(n.id) ?? false) || (k >= 2.5 && inView(p));
            return <g key={n.id} role="button" tabIndex={0} aria-label={`Đọc ${n.title}`} class="sb-node" opacity={searchDim ? .12 : hoverDim ? .15 : 1}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(n.id); } }}
              onClick={() => choose(n.id)} onPointerEnter={() => setHover(n.id)} onPointerLeave={() => setHover(h => h === n.id ? null : h)}>
              <title>{n.title} — {n.id}</title>
              <circle cx={p.x} cy={p.y} r={Math.max(r, 12 / k)} fill="transparent" />
              <circle cx={p.x} cy={p.y} r={r} fill={layout.positions.get(n.id)!.color} stroke={isSel ? 'currentColor' : 'none'} stroke-width={2 / k} />
              {showLabel && <text class="sb-node-label" x={p.x} y={p.y + r + 13 / k} text-anchor="middle" font-size={12 / k} stroke-width={3 / k}>{labelOf(n.id)}</text>}
            </g>;
          })}
          {!focus && layout.clusters.map(c => <g key={c.name} class="sb-cluster" opacity={k > 2.5 ? .35 : 1}>
            <text x={c.x} y={c.y} text-anchor="middle" font-size={14 / k}>{c.name}</text>
            <text x={c.x} y={c.y + 19 / k} text-anchor="middle" class="sb-cluster-count" font-size={11 / k}>{c.count} ghi chú · {Math.round(c.count / notes.length * 100)}% vault</text>
          </g>)}
        </g>
      </svg>
      <div class="sb-graph-caption"><span class="sb-live-dot" />
        {focus ? `${shownNotes.length} ghi chú trong ${depth} bước quanh “${titles.get(selected!)}”` : matched ? `${matched.size} ghi chú phù hợp` : 'Các liên kết trong vault'}
        <span>{focus ? 'Chọn điểm khác để chuyển · “Hiện toàn bộ” để quay lại' : 'Chọn một điểm để xem ghi chú và các liên kết · cuộn để thu phóng · kéo để di chuyển'}</span>
      </div>
    </>}
  </section>;
}
