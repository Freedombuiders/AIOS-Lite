import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { BookOpen, ExternalLink, FolderOpen, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-preact';
import { ConfirmModal } from '@/components/ConfirmModal';
import { FolderBrowser } from '@/components/FolderBrowser';
import { Modal } from '@/components/Modal';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { Field } from '@/components/ui';
import { apiDelete, apiPost, apiPut, errorText } from '@/lib/api';
import type { BrainFolderView } from '@/lib/api-types';
import { resolveAgentName } from '@/lib/format';
import { pushToast } from '@/lib/toasts';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';

type Editing = { id: string | null; name: string; description: string; path: string };
const EMPTY: Editing = { id: null, name: '', description: '', path: '' };

function AgentList({ label, ids }: { label: string; ids: string[] }) {
  return (
    <div class="flex flex-wrap items-center gap-1 text-[12px]">
      <span class="hint">{label}:</span>
      {ids.length === 0 && <span class="hint">chưa agent nào</span>}
      {ids.map((a) => <Link key={a} href={`/agents/${a}`} class="pill pill-accent no-underline">{resolveAgentName(a)}</Link>)}
    </div>
  );
}

export default function SecondBrains() {
  const f = useFetch<{ items: BrainFolderView[] }>('/brain/folders', 30_000);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<BrainFolderView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const items = f.data?.items ?? [];

  const reload = () => {
    invalidateFetchCache('/brain');
    invalidateFetchCache('/agents');
    f.refresh();
  };

  async function save() {
    if (!editing) return;
    setBusy('save');
    try {
      const body = { name: editing.name.trim(), description: editing.description.trim(), path: editing.path.trim() };
      if (editing.id) await apiPut(`/brain/folders/${editing.id}`, body);
      else await apiPost('/brain/folders', body);
      pushToast({ tone: 'success', title: editing.id ? 'Đã lưu Second Brain' : 'Đã thêm Second Brain', description: 'Đã lập chỉ mục thư mục này.' });
      setEditing(null);
      reload();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không lưu được', description: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  async function reindex(id?: string) {
    setBusy(id ?? 'all');
    try {
      const r = await apiPost<{ indexed: number; removed: number; durationMs: number }>('/brain/reindex', { full: true, ...(id ? { folderId: id } : {}) });
      pushToast({ tone: 'success', title: 'Đã lập lại chỉ mục', description: `${r.indexed} tài liệu mới, ${r.removed} bị gỡ, ${r.durationMs}ms.` });
      reload();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không lập được chỉ mục', description: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!removing) return;
    setBusy('remove');
    try {
      const r = await apiDelete<{ agentsUpdated: string[] }>(`/brain/folders/${removing.id}`);
      pushToast({ tone: 'success', title: `Đã gỡ “${removing.name}”`, description: r.agentsUpdated.length ? `Đã bỏ quyền của ${r.agentsUpdated.length} agent. File trên máy vẫn còn nguyên.` : 'File trên máy vẫn còn nguyên.' });
      setRemoving(null);
      reload();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không gỡ được', description: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div class="page page-wide">
      <PageHeader
        title="Quản lý Second Brain"
        breadcrumb="Second Brain"
        actions={
          <>
            <Link href="/brain" class="control-button inline-flex items-center gap-1.5 no-underline"><BookOpen size={12} />Mở trình khám phá</Link>
            <button type="button" class="control-button" disabled={busy !== null} onClick={() => void reindex()}><RefreshCw size={12} class={busy === 'all' ? 'animate-spin' : ''} /> Lập chỉ mục lại tất cả</button>
            <button type="button" class="control-button control-accent" onClick={() => setEditing({ ...EMPTY })}><Plus size={12} /> Thêm brain</button>
          </>
        }
      />
      <p class="hint -mt-2 mb-3">Mỗi brain là một thư mục ghi chú (vault Obsidian hoặc thư mục thường), ví dụ một công ty hoặc một người. Chọn agent nào được đọc hay ghi ở tab Quyền của agent.</p>

      <PageState
        loading={f.loading && !f.data}
        error={f.error}
        empty={!!f.data && items.length === 0}
        emptyTitle="Chưa có Second Brain nào"
        emptyDescription="Bấm “Thêm brain” để chọn một thư mục ghi chú trên máy."
      />

      <div class="flex flex-col gap-2.5" aria-label="Danh sách Second Brain">
        {items.map((b) => (
          <section key={b.id} class="card card-pad" data-testid={`brain-${b.id}`}>
            <div class="flex flex-wrap items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-1.5">
                  <FolderOpen size={15} class="text-[var(--color-accent)]" aria-hidden="true" />
                  <h2 class="m-0 text-[14px] font-semibold">{b.name}</h2>
                  <span class="hint mono">{b.id}</span>
                  {b.isVault && <Pill tone="accent">Obsidian vault</Pill>}
                  {b.exists ? <Pill tone="success">Có trên máy</Pill> : <Pill tone="warn">Thiếu thư mục</Pill>}
                </div>
                {b.description && <div class="hint mt-0.5">{b.description}</div>}
                <div class="hint mono mt-1 break-all">{b.path}</div>
              </div>
              <div class="flex flex-wrap items-center gap-1.5">
                {b.exists && <Link href={`/brain?vault=${encodeURIComponent(b.id)}`} class="control-button control-sm inline-flex items-center gap-1 no-underline"><ExternalLink size={11} />Mở</Link>}
                <button type="button" class="control-button control-sm" onClick={() => setEditing({ id: b.id, name: b.name, description: b.description ?? '', path: b.path })}><Pencil size={11} /> Sửa</button>
                <button type="button" class="control-button control-sm" disabled={busy !== null || !b.exists} onClick={() => void reindex(b.id)}><RefreshCw size={11} class={busy === b.id ? 'animate-spin' : ''} /> Lập chỉ mục lại</button>
                <button type="button" class="control-button control-sm control-danger" onClick={() => setRemoving(b)}><Trash2 size={11} /> Gỡ</button>
              </div>
            </div>
            <div class="mt-2 flex flex-wrap gap-x-6 gap-y-1.5 text-[12px]">
              <span><b>{b.docs}</b> <span class="hint">ghi chú đã lập chỉ mục{b.mdCount !== undefined ? ` · ${b.mdCount} file .md` : ''}</span></span>
              <AgentList label="Được đọc bởi" ids={b.readers ?? []} />
              <AgentList label="Được ghi bởi" ids={b.writers ?? []} />
            </div>
          </section>
        ))}
      </div>

      <Modal
        open={!!editing}
        onClose={() => busy !== 'save' && setEditing(null)}
        title={editing?.id ? 'Sửa Second Brain' : 'Thêm Second Brain'}
        width={620}
        footer={
          <>
            <button type="button" class="control-button" disabled={busy === 'save'} onClick={() => setEditing(null)}>Huỷ</button>
            <button type="button" class="control-button control-accent" disabled={busy === 'save' || !editing?.name.trim() || !editing?.path.trim()} onClick={() => void save()}>{busy === 'save' ? 'Đang lưu…' : 'Lưu'}</button>
          </>
        }
      >
        {editing && (
          <div class="flex flex-col gap-3">
            <Field label="Tên"><input class="field" value={editing.name} placeholder="Ví dụ: Công ty Đại Phát" onInput={(e) => setEditing({ ...editing, name: (e.target as HTMLInputElement).value })} /></Field>
            <Field label="Mô tả (không bắt buộc)"><input class="field" value={editing.description} onInput={(e) => setEditing({ ...editing, description: (e.target as HTMLInputElement).value })} /></Field>
            <Field label="Thư mục trên máy" hint="Gõ đường dẫn (hỗ trợ ~) hoặc bấm vào thư mục bên dưới. Chỉ duyệt được trong thư mục người dùng.">
              <input class="field mono" value={editing.path} placeholder="~/Documents/Obsidian/CongTy" onInput={(e) => setEditing({ ...editing, path: (e.target as HTMLInputElement).value })} />
            </Field>
            <FolderBrowser path={editing.path} onPathChange={(path) => setEditing({ ...editing, path })} />
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={!!removing}
        onClose={() => busy !== 'remove' && setRemoving(null)}
        onConfirm={() => void remove()}
        title={`Gỡ “${removing?.name ?? ''}”?`}
        body="Chỉ gỡ khỏi AIOS, không xoá file."
        detail="Chỉ mục tìm kiếm và quyền đọc/ghi của mọi agent với brain này sẽ bị bỏ. Thư mục và ghi chú trên máy vẫn còn nguyên."
        confirmLabel="Gỡ khỏi AIOS"
        destructive
        loading={busy === 'remove'}
      />
    </div>
  );
}
