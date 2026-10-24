import { CornerDownLeft, Search } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { BOTTOM_NAV, CORE_NAV, GROUP_LABEL } from '@/lib/nav';
import { paletteOpen } from '@/lib/palette';
import { navItems } from '@/module-host/host';

interface Entry {
  label: string;
  path: string;
  section: string;
}

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase();
}

export function CommandPalette() {
  const [, navigate] = useLocation();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const open = paletteOpen.value;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        paletteOpen.value = !paletteOpen.value;
      } else if (e.key === 'Escape' && paletteOpen.value) paletteOpen.value = false;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQ('');
      setSel(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  const mods = navItems.value;
  const entries = useMemo<Entry[]>(() => [
    ...CORE_NAV.map((i) => ({ label: i.label, path: i.path, section: 'Workspace' })),
    ...mods.map((i) => ({ label: i.label, path: i.path, section: GROUP_LABEL[i.group] ?? 'Module' })),
    ...BOTTOM_NAV.map((i) => ({ label: i.label, path: i.path, section: 'Hệ thống' })),
  ], [mods]);

  const hits = useMemo(() => {
    const n = normalize(q.trim());
    return n ? entries.filter((e) => normalize(`${e.label} ${e.section}`).includes(n)) : entries;
  }, [q, entries]);

  if (!open) return null;
  const go = (e: Entry | undefined) => {
    if (!e) return;
    paletteOpen.value = false;
    navigate(e.path);
  };
  return (
    <div class="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 px-4 pt-[12vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) paletteOpen.value = false; }}>
      <div class="card w-full max-w-[520px] overflow-hidden shadow-2xl" role="dialog" aria-label="Tìm nhanh trang">
        <div class="flex items-center gap-2 border-b border-[var(--color-border)] px-3">
          <Search size={15} class="shrink-0 text-[var(--color-text-faint)]" />
          <input
            ref={input}
            class="h-11 min-w-0 flex-1 border-0 bg-transparent text-[14px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)]"
            placeholder="Nhảy tới trang…"
            value={q}
            onInput={(e) => { setQ((e.target as HTMLInputElement).value); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, hits.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              else if (e.key === 'Enter') { e.preventDefault(); go(hits[sel]); }
            }}
          />
        </div>
        <ul class="m-0 max-h-[50vh] list-none overflow-y-auto p-1.5">
          {hits.length === 0 && <li class="hint px-3 py-4 text-center">Không có trang nào khớp “{q}”.</li>}
          {hits.map((h, i) => (
            <li key={h.path}>
              <button
                type="button"
                class={`flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border-0 px-3 py-2 text-left text-[13px] ${i === sel ? 'bg-[var(--color-accent-soft)] text-[var(--color-text)]' : 'bg-transparent text-[var(--color-text-muted)]'}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => go(h)}
              >
                <span class="min-w-0 flex-1 truncate">{h.label}</span>
                <span class="text-[10.5px] tracking-wider text-[var(--color-text-faint)] uppercase">{h.section}</span>
                {i === sel && <CornerDownLeft size={12} class="text-[var(--color-text-faint)]" />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
