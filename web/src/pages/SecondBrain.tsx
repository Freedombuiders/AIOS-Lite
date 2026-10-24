import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Link, useLocation, useSearch } from 'wouter-preact';
import { Brain, ChevronRight, FileText, Folder, RefreshCw, Search, X } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { useFetch } from '@/lib/useFetch';
import type { BrainFolderView, BrainTreeNode } from '@/lib/api-types';
import { BrainNoteEditor } from '@/components/BrainNoteEditor';
import { BrainLocalGraph } from '@/components/BrainLocalGraph';
import { BrainVaultGraph } from '@/components/BrainVaultGraph';
import '@/styles/second-brain.css';

const READER_KEY = 'claudeclaw.brain.readerWidth';
const READER_DEFAULT = 440;
const READER_MIN = 320;
const GRAPH_MIN = 260;
type Note = { id: string; title: string; folder: string; vault?: string; vaultName?: string };
type VaultSummary = { id: string; name: string; path: string };
type BrainData = {
  enabled: boolean;
  vaultId?: string;
  vaultName: string;
  vaults?: VaultSummary[];
  notes: Note[];
  folders: string[];
  edges: { source: string; target: string }[];
  truncated: boolean;
  skipped: number;
};

export default function SecondBrain() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const selected = params.get('note');
  const heading = params.get('heading') || '';
  const currentVault = params.get('vault') || '';

  // AIOS-Lite has folders + a tree endpoint, not a graph endpoint: build the explorer data from them (no link edges yet).
  const folders = useFetch<{ items: BrainFolderView[] }>('/brain/folders');
  const existing = (folders.data?.items ?? []).filter((f) => f.exists);
  const folder = existing.find((f) => f.id === currentVault) ?? existing[0];
  const treeFetch = useFetch<{ items: BrainTreeNode[] }>(folder ? `/brain/tree?folder=${encodeURIComponent(folder.id)}&depth=8` : null);
  const built = useMemo<BrainData | undefined>(() => {
    if (!folders.data) return undefined;
    if (!folder) return { enabled: false, vaultName: 'Second Brain', notes: [], folders: [], edges: [], truncated: false, skipped: 0 };
    if (!treeFetch.data) return undefined;
    const notes: Note[] = [];
    const dirs: string[] = [];
    const walk = (nodes: BrainTreeNode[], dir: string) => {
      for (const n of nodes) {
        if (n.type === 'dir') { dirs.push(n.path); walk(n.children ?? [], n.path); }
        else if (/\.md$/i.test(n.name)) notes.push({ id: n.path, title: n.name.replace(/\.md$/i, ''), folder: dir, vault: folder.id });
      }
    };
    walk(treeFetch.data.items, '');
    return { enabled: true, vaultId: folder.id, vaultName: folder.name, vaults: existing.map((f) => ({ id: f.id, name: f.name, path: f.path })), notes, folders: dirs, edges: [], truncated: false, skipped: 0 };
  }, [folders.data, treeFetch.data, folder?.id]);
  const brain = { data: built, loading: folders.loading || treeFetch.loading, error: folders.error || treeFetch.error, refresh: () => { folders.refresh(); treeFetch.refresh(); } };
  const [query, setQuery] = useState('');
  function setSelected(id: string | null, anchor = '') {
    const nextParams = new URLSearchParams(search);
    if (id) {
      nextParams.set('note', id);
      if (anchor) nextParams.set('heading', anchor);
      else nextParams.delete('heading');
    } else {
      nextParams.delete('note');
      nextParams.delete('heading');
    }
    navigate(`/brain?${nextParams.toString()}`);
  }
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [showFiles, setShowFiles] = useState(true);
  const workspace = useRef<HTMLDivElement>(null);
  const [readerW, setReaderW] = useState(() => { try { return Math.max(READER_MIN, Number(localStorage.getItem(READER_KEY)) || READER_DEFAULT); } catch { return READER_DEFAULT; } });
  function resizeReader(w: number, save = false) {
    const total = workspace.current?.getBoundingClientRect().width || 1200;
    const explorer = showFiles ? (workspace.current?.querySelector('.sb-explorer')?.getBoundingClientRect().width || 0) : 0;
    const next = Math.round(Math.min(Math.max(w, READER_MIN), Math.max(READER_MIN, total - explorer - GRAPH_MIN)));
    setReaderW(next);
    if (save) try { localStorage.setItem(READER_KEY, String(next)); } catch { /* storage unavailable */ }
    return next;
  }
  function startResize(e: PointerEvent) {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    let last = readerW;
    const move = (ev: PointerEvent) => { last = resizeReader((workspace.current?.getBoundingClientRect().right || 0) - ev.clientX); };
    const end = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); resizeReader(last, true); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
  }
  function resizeKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); resizeReader(readerW + (e.key === 'ArrowLeft' ? 24 : -24), true); }
    else if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); resizeReader(READER_DEFAULT, true); }
  }
  const data = brain.data;
  const notes = data?.notes || [];
  const noteIds = useMemo(() => new Set(notes.map(n => n.id)), [data]);
  useEffect(() => {
    if (!selected) return;
    const parts = selected.split('/').slice(0, -1);
    setOpened(prev => new Set([...prev, ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))]));
  }, [selected]);
  const filtered = useMemo(() => notes.filter(n => `${n.title} ${n.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [data, query]);
  const matched = useMemo(() => query ? new Set(filtered.map(n => n.id)) : null, [filtered, query]);
  function toggle(folder: string) { setOpened(prev => { const next = new Set(prev); next.has(folder) ? next.delete(folder) : next.add(folder); return next; }); }
  function tree(parent: string, depth = 0): ComponentChildren {
    const children = (data?.folders || []).filter(f => f.split('/').slice(0, -1).join('/') === parent);
    return <>
      {children.map(folder => <div key={folder}>
        <button class="sb-tree-row" style={{ paddingLeft: 14 + depth * 16 }} aria-expanded={opened.has(folder)} onClick={() => toggle(folder)}><ChevronRight size={13} style={{ transform: opened.has(folder) ? 'rotate(90deg)' : undefined }} /><Folder size={16} /><span>{folder.split('/').pop()}</span></button>
        {opened.has(folder) && tree(folder, depth + 1)}
      </div>)}
      {notes.filter(n => n.folder === parent).map(n => noteRow(n, depth))}
    </>;
  }
  function noteRow(n: Note, depth = 0) {
    return <button key={n.id} class={`sb-tree-row ${selected === n.id ? 'is-selected' : ''}`} style={{ paddingLeft: 22 + depth * 16 }} onClick={() => setSelected(n.id)} title={n.id} aria-pressed={selected === n.id}><FileText size={15} /><span>{n.title}</span></button>;
  }
  return <div class="sb-page">
    <PageHeader title={data?.vaultName || 'Second Brain'} breadcrumb="Second Brains" actions={<><Link class="sb-button" href="/brain/search">Tìm kiếm và lập chỉ mục</Link></>} />
    <div class="sb-toolbar">
      <div class="sb-vault-picker">
        <Brain size={20} class="text-[var(--color-accent)] shrink-0" />
        {data?.vaults && data.vaults.length > 1 ? (
          <select
            class="sb-vault-select"
            aria-label="Chọn Second Brain"
            value={currentVault || data.vaultId || data.vaults[0].id}
            onChange={e => {
              const val = e.currentTarget.value;
              const nextParams = new URLSearchParams(search);
              if (val) nextParams.set('vault', val);
              else nextParams.delete('vault');
              nextParams.delete('note');
              nextParams.delete('heading');
              navigate(`/brain?${nextParams.toString()}`);
            }}
          >
            {data.vaults.map(v => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        ) : (
          <strong>{data?.vaultName || 'Second Brain'}</strong>
        )}
      </div>
      <span>{notes.length} ghi chú · {data?.edges.length || 0} kết nối</span>
      <button class="sb-button" onClick={() => { brain.refresh(); }} disabled={brain.loading} aria-label="Làm mới Second Brain"><RefreshCw size={16} />{brain.loading ? 'Đang đọc…' : 'Làm mới'}</button>
    </div>
    {brain.error && <div class="sb-message" role="alert">{brain.error} <button onClick={brain.refresh}>Thử lại</button></div>}
    {!data && brain.loading && <div class="sb-empty" role="status">Đang đọc thư mục Second Brain…</div>}
    {data && !data.enabled && <div class="sb-empty"><Brain size={44} /><h2>Kết nối bộ não của bạn</h2><p>Chọn thư mục Second Brain và bật kết nối để khám phá ghi chú.</p><a class="sb-button" href="/brain/search">Chọn thư mục trong Cài đặt</a></div>}
    {data?.enabled && <>
      {(data.truncated || data.skipped > 0) && <div class="sb-message">{data.truncated && 'Đang hiển thị một phần vault (tối đa 2.000 ghi chú, 32 MB nội dung). '}{data.skipped > 0 && `${data.skipped} tệp quá lớn hoặc không đọc được đã được bỏ qua.`}</div>}
      <div ref={workspace} class={`sb-workspace ${selected ? 'has-note' : ''}`} style={{ '--sb-reader-w': `${readerW}px` }}>
        <aside class={`sb-explorer ${showFiles ? '' : 'is-hidden'}`} aria-label="Cây thư mục Second Brain"><div class="sb-explorer-heading">VAULT <span>{data.folders.length} thư mục</span></div><label class="sb-search"><Search size={16} /><input type="search" aria-label="Tìm ghi chú" placeholder="Tìm tên hoặc đường dẫn…" value={query} onInput={e => setQuery(e.currentTarget.value)} /></label><div class="sb-tree">{query ? filtered.map(n => noteRow(n)) : tree('')}{query && !filtered.length && <p class="sb-message">Không có ghi chú phù hợp.</p>}</div></aside>
        <BrainVaultGraph notes={notes} edges={data.edges} selected={selected} matched={matched} showFiles={showFiles} onToggleFiles={() => setShowFiles(!showFiles)} onSelect={id => setSelected(id)} />
        {selected && <div class="sb-resizer" role="separator" aria-orientation="vertical" aria-label="Kéo để đổi độ rộng phần đọc ghi chú" aria-valuemin={READER_MIN} aria-valuenow={readerW} tabIndex={0} title="Kéo để đổi độ rộng · nhấp đúp để đặt lại" onPointerDown={startResize} onKeyDown={resizeKey} onDblClick={() => resizeReader(READER_DEFAULT, true)} />}
        {selected && <aside class="sb-reader" aria-label="Nội dung ghi chú"><div class="sb-reader-heading"><div><strong>{notes.find(n => n.id === selected)?.title}</strong><small>{selected}</small></div><button class="sb-button" aria-label="Đóng ghi chú" onClick={() => setSelected(null)}><X size={17} /></button></div><div class="sb-note-navigation"><button class="sb-button" onClick={() => window.history.back()}>Quay lại</button><button class="sb-button" onClick={() => setSelected(null)}>Graph toàn vault</button></div><BrainLocalGraph selected={selected} notes={notes} edges={data.edges} onNavigate={setSelected} /><BrainNoteEditor key={`${data.vaultId || data.vaultName}:${selected}`} path={selected} vault={data.vaultName} vaultId={data.vaultId} onSaved={brain.refresh} noteIds={noteIds} onNavigate={setSelected} heading={heading} /><div class="sb-related"><strong>Ghi chú liên kết</strong>{[...new Set(data.edges.filter(e => e.source === selected || e.target === selected).map(e => e.source === selected ? e.target : e.source))].map(id => { return <button class="sb-tree-row" key={id} onClick={() => setSelected(id)}><FileText size={14} />{notes.find(n => n.id === id)?.title}</button>; })}</div></aside>}
      </div>
    </>}
  </div>;
}
