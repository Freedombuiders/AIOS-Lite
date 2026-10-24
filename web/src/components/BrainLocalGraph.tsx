import { brainNoteUrl } from '@/lib/brain-links';
import { useEffect, useRef, useState } from 'preact/hooks';

type Note = { id: string; title: string };
export function BrainLocalGraph({ selected, notes, edges, onNavigate }: {
  selected: string; notes: Note[]; edges: { source: string; target: string }[]; onNavigate: (id: string) => void;
}) {
  const container = useRef<HTMLDetailsElement>(null);
  const [width, setWidth] = useState(700);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(260, Math.min(700, entries[0].contentRect.width))));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const limit = width < 480 ? 6 : 12;
  const neighbors = new Set(edges.flatMap(e => e.source === selected ? [e.target] : e.target === selected ? [e.source] : []));
  const linked = notes.filter(n => neighbors.has(n.id));
  const points = linked.slice(0, limit).map((n, i, list) => {
    const angle = i / list.length * Math.PI * 2 - Math.PI / 2;
    return { ...n, x: width / 2 + Math.cos(angle) * (width / 2 - 72), y: 150 + Math.sin(angle) * 100 };
  });
  return <details ref={container} class="sb-local-graph" open>
    <summary>Graph của ghi chú · {linked.length} ghi chú liên quan</summary>
    {linked.length ? <svg viewBox={`0 0 ${width} 300`} aria-label="Graph của ghi chú đang mở">
      {points.map(p => <line key={`edge:${p.id}`} x1={width / 2} y1={150} x2={p.x} y2={p.y} />)}
      <circle cx={width / 2} cy={150} r={8} class="sb-local-center" />
      <text x={width / 2} y={178} text-anchor="middle">Ghi chú đang mở</text>
      {points.map(p => <a key={p.id} href={brainNoteUrl(p.id)} aria-label={`Mở ${p.title} từ graph`} onClick={e => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault(); onNavigate(p.id);
      }}>
        <title>{p.title} — {p.id}</title><circle cx={p.x} cy={p.y} r={22} class="sb-local-hit" /><circle cx={p.x} cy={p.y} r={6} />
        <text x={p.x} y={p.y + 25} text-anchor="middle">{p.title.length > (width < 480 ? 15 : 24) ? `${p.title.slice(0, width < 480 ? 13 : 22)}…` : p.title}</text>
      </a>)}
    </svg> : <p class="sb-message">Chưa có liên kết đến ghi chú khác. Thêm [[Tên ghi chú]] trong nội dung.</p>}
    {linked.length > limit && <p class="sb-message">Hiển thị {limit} kết nối trên graph; danh sách đầy đủ ở cuối ghi chú.</p>}
  </details>;
}
