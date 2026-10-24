import { ArrowUp, BookOpen, Folder, Sparkles } from 'lucide-preact';
import type { DirListing } from '@/lib/api-types';
import { useDebouncedValue } from '@/lib/useDebounce';
import { useFetch } from '@/lib/useFetch';

/** Directory browser over GET /fs/dirs (folders only, inside the home directory). `path` is the single source of truth. */
export function FolderBrowser({ path, onPathChange }: { path: string; onPathChange: (path: string) => void }) {
  const wanted = useDebouncedValue(path.trim(), 300);
  const f = useFetch<DirListing>(`/fs/dirs${wanted ? `?path=${encodeURIComponent(wanted)}` : ''}`);
  const listing = f.data;

  return (
    <div class="rounded-[var(--radius-md)] border border-[var(--color-border)]">
      <div class="flex items-center gap-2 border-b border-[var(--color-border)] px-2.5 py-1.5">
        <button type="button" class="control-button control-sm" disabled={!listing?.parent} onClick={() => listing?.parent && onPathChange(listing.parent)} aria-label="Lên thư mục cha">
          <ArrowUp size={12} /> Lên
        </button>
        <span class="hint mono min-w-0 flex-1 truncate" title={listing?.path}>{listing?.path ?? '…'}</span>
      </div>
      <div class="max-h-56 overflow-y-auto p-1" role="listbox" aria-label="Thư mục con">
        {f.error && <div class="px-2 py-2 text-[12px] text-[var(--color-status-failed)]">{f.error}</div>}
        {!f.error && listing && listing.dirs.length === 0 && <div class="hint px-2 py-2">Không có thư mục con.</div>}
        {!f.error && !listing && f.loading && <div class="hint px-2 py-2">Đang tải…</div>}
        {!f.error &&
          listing?.dirs.map((d) => (
            <button
              key={d.path}
              type="button"
              role="option"
              aria-selected={d.path === path}
              onClick={() => onPathChange(d.path)}
              class="flex w-full items-center gap-2 rounded-[var(--radius-md)] border-0 bg-transparent px-2 py-1.5 text-left text-[12px] hover:bg-[var(--color-control-hover)]"
            >
              <Folder size={14} class="shrink-0 text-[var(--color-accent)]" />
              <span class="min-w-0 flex-1 truncate">{d.name}</span>
              {d.isVault && <span class="pill pill-accent inline-flex items-center gap-1"><BookOpen size={10} />Obsidian</span>}
              {d.hasSkills && <span class="pill pill-info inline-flex items-center gap-1"><Sparkles size={10} />Có skill</span>}
            </button>
          ))}
      </div>
    </div>
  );
}
