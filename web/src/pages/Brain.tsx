import { ChevronDown, ChevronRight, FileText, Folder, RefreshCw, Search } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import type { BrainHit } from '@core/types';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { Markdown } from '@/components/ui';
import { apiPost, errorText, qs } from '@/lib/api';
import type { BrainFolderView, BrainTreeNode } from '@/lib/api-types';
import { useDebouncedValue } from '@/lib/useDebounce';
import { renderMarkdown } from '@/lib/markdown';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';

function Tree({ nodes, selected, onSelect, depth = 0 }: { nodes: BrainTreeNode[]; selected: string | null; onSelect: (path: string) => void; depth?: number }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <ul class="m-0 list-none p-0">
      {nodes.map((n) => (
        <li key={n.path}>
          {n.type === 'dir' ? (
            <>
              <button type="button" class="flex w-full items-center gap-1 border-0 bg-transparent py-1 text-left text-[12px] text-[var(--color-text-muted)] cursor-pointer hover:text-[var(--color-text)]" style={{ paddingLeft: depth * 12 + 4 }} onClick={() => setOpen({ ...open, [n.path]: !open[n.path] })}>
                {open[n.path] ? <ChevronDown size={12} /> : <ChevronRight size={12} />} <Folder size={12} /> {n.name}
              </button>
              {open[n.path] && n.children && <Tree nodes={n.children} selected={selected} onSelect={onSelect} depth={depth + 1} />}
            </>
          ) : (
            <button type="button" class={`flex w-full items-center gap-1 border-0 py-1 text-left text-[12px] cursor-pointer ${selected === n.path ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'bg-transparent text-[var(--color-text)] hover:bg-[var(--color-control-hover)]'}`} style={{ paddingLeft: depth * 12 + 20 }} onClick={() => onSelect(n.path)}>
              <FileText size={12} className="shrink-0" /> <span class="truncate">{n.name}</span>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function Viewer({ folder, path }: { folder: string; path: string }) {
  const f = useFetch<{ title: string; content: string; mtimeMs: number }>(`/brain/file${qs({ folder, path })}`);
  if (!f.data) return <PageState loading={f.loading} error={f.error} />;
  return (
    <div>
      <div class="mb-2 flex items-center gap-2"><span class="mono text-[12px]">{folder}/{path}</span><span class="hint">sửa {new Date(f.data.mtimeMs).toLocaleString('vi-VN')}</span></div>
      <Markdown html={renderMarkdown(f.data.content)} />
    </div>
  );
}

export default function BrainPage() {
  const folders = useFetch<{ items: BrainFolderView[] }>('/brain/folders');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q.trim(), 250);
  const [busy, setBusy] = useState(false);
  const list = folders.data?.items ?? [];
  const active = list.find((f) => f.id === folderId) ?? list.find((f) => f.exists);
  const tree = useFetch<{ items: BrainTreeNode[] }>(active && active.exists ? `/brain/tree${qs({ folder: active.id, depth: 6 })}` : null);
  const hits = useFetch<{ items: BrainHit[] }>(dq ? `/brain/search${qs({ q: dq, limit: 30 })}` : null);

  useEffect(() => {
    setPath(null);
  }, [active?.id]);

  async function reindex() {
    setBusy(true);
    try {
      const r = await apiPost<{ indexed: number; removed: number; durationMs: number }>('/brain/reindex', {});
      pushToast({ tone: 'success', title: 'Đã lập lại chỉ mục', description: `${r.indexed} tài liệu mới, ${r.removed} bị gỡ, ${r.durationMs}ms.` });
      folders.refresh();
      tree.refresh();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không lập được chỉ mục', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="page page-wide">
      <PageHeader
        title="Second Brain"
        actions={
          <>
            <div class="relative">
              <Search size={12} class="absolute top-2 left-2 text-[var(--color-text-faint)]" />
              <input class="field" style={{ width: 240, paddingLeft: 24 }} placeholder="Tìm trong brain (không cần gõ dấu)…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
            </div>
            <button type="button" class="control-button" disabled={busy} onClick={() => void reindex()}><RefreshCw size={12} class={busy ? 'animate-spin' : ''} /> Lập lại chỉ mục</button>
          </>
        }
      />
      <PageState loading={folders.loading && !folders.data} error={folders.error} empty={!!folders.data && list.length === 0} emptyTitle="Chưa khai báo thư mục nào" emptyDescription="Thêm thư mục ghi chú (ví dụ vault Obsidian) vào config/brain.yaml rồi tải lại." />

      {dq ? (
        <div class="card">
          <PageState loading={hits.loading && !hits.data} error={hits.error} empty={!!hits.data && hits.data.items.length === 0} emptyTitle={`Không có kết quả cho “${dq}”`} emptyDescription="Thử từ khoá ngắn hơn, hoặc lập lại chỉ mục nếu vừa thêm ghi chú." />
          <ul class="m-0 list-none p-0">
            {(hits.data?.items ?? []).map((h) => (
              <li key={`${h.folderId}:${h.path}`}>
                <button type="button" class="block w-full border-0 border-b border-[var(--color-border)] bg-transparent px-3 py-2 text-left cursor-pointer hover:bg-[var(--color-control-hover)]" onClick={() => { setFolderId(h.folderId); setPath(h.path); setQ(''); }}>
                  <div class="text-[12.5px] font-medium text-[var(--color-text)]">{h.title} <span class="hint mono">{h.folderId}/{h.path}</span></div>
                  <div class="hint line-clamp-2">{h.snippet}</div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        list.length > 0 && (
          <div class="grid gap-3 lg:grid-cols-[230px_260px_minmax(0,1fr)]">
            <div class="card p-1.5">
              {list.map((f) => (
                <button key={f.id} type="button" class={`flex w-full items-center gap-2 rounded-[var(--radius-md)] border-0 px-2 py-1.5 text-left cursor-pointer ${active?.id === f.id ? 'bg-[var(--color-accent-soft)]' : 'bg-transparent hover:bg-[var(--color-control-hover)]'}`} onClick={() => setFolderId(f.id)}>
                  <Folder size={13} class="shrink-0" />
                  <span class="min-w-0 flex-1"><span class="block truncate text-[12.5px] text-[var(--color-text)]">{f.name}</span><span class="hint block truncate">{f.description}</span></span>
                  {f.exists ? <Pill>{f.docs}</Pill> : <Pill tone="warn">thiếu</Pill>}
                </button>
              ))}
            </div>
            <div class="card max-h-[70vh] overflow-y-auto p-1.5">
              {active && !active.exists && <div class="hint p-2">Thư mục <span class="mono">{active.path}</span> chưa tồn tại trên máy. Tạo thư mục rồi bấm “Lập lại chỉ mục”.</div>}
              <PageState loading={tree.loading && !tree.data} error={tree.error} empty={!!tree.data && tree.data.items.length === 0} emptyTitle="Thư mục trống" emptyDescription="Thêm file .md vào thư mục này." />
              {tree.data && <Tree nodes={tree.data.items} selected={path} onSelect={setPath} />}
            </div>
            <div class="card card-pad min-h-[200px]">
              {active && path ? <Viewer key={`${active.id}:${path}`} folder={active.id} path={path} /> : <div class="hint">Chọn một ghi chú ở cột giữa để xem nội dung.</div>}
            </div>
          </div>
        )
      )}
    </div>
  );
}
