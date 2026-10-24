import { Pencil, Pin, PinOff, Plus, Search, Trash2 } from 'lucide-preact';
import { useCallback, useState } from 'preact/hooks';
import type { Memory } from '@core/types';
import { ConfirmModal } from '@/components/ConfirmModal';
import { Modal } from '@/components/Modal';
import { PageHeader, Tab } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { Field } from '@/components/ui';
import { apiDelete, apiPatch, apiPost, errorText, qs } from '@/lib/api';
import { useAgents } from '@/lib/agents';
import { formatRelativeTime, resolveAgentName } from '@/lib/format';
import { useEvents } from '@/lib/sse';
import { pushToast } from '@/lib/toasts';
import { useDebouncedValue } from '@/lib/useDebounce';
import { useFetch } from '@/lib/useFetch';

type Scope = 'team' | 'private';

export default function MemoryPage() {
  const { agents } = useAgents();
  const [scope, setScope] = useState<Scope>('team');
  const [agentId, setAgentId] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q.trim(), 250);
  const f = useFetch<{ items: Memory[] }>(`/memory${qs({ scope, agentId: scope === 'private' ? agentId : '', q: dq, limit: 200 })}`);
  const [edit, setEdit] = useState<{ id?: number; content: string; agentId: string | null } | null>(null);
  const [del, setDel] = useState<Memory | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = f.refresh;
  useEvents(['memory'], useCallback(() => refresh(), [refresh]));
  const items = [...(f.data?.items ?? [])].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt));

  async function save() {
    if (!edit || !edit.content.trim()) return;
    setBusy(true);
    try {
      if (edit.id) await apiPatch(`/memory/${edit.id}`, { content: edit.content.trim() });
      else await apiPost('/memory', { content: edit.content.trim(), agentId: edit.agentId });
      setEdit(null);
      refresh();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không lưu được', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function pin(m: Memory) {
    try {
      await apiPatch(`/memory/${m.id}`, { pinned: !m.pinned });
      refresh();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không ghim được', description: errorText(e) });
    }
  }

  async function remove() {
    if (!del) return;
    setBusy(true);
    try {
      await apiDelete(`/memory/${del.id}`);
      setDel(null);
      refresh();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không xoá được', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const addTarget = scope === 'team' ? null : agentId || agents[0]?.id || null;
  return (
    <div class="page">
      <PageHeader
        title="Bộ nhớ"
        actions={<button type="button" class="control-button control-accent" onClick={() => setEdit({ content: '', agentId: addTarget })}><Plus size={12} /> Thêm ghi nhớ</button>}
        tabs={<><Tab label="Của cả đội" active={scope === 'team'} onClick={() => setScope('team')} /><Tab label="Riêng từng agent" active={scope === 'private'} onClick={() => setScope('private')} /></>}
      />
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <div class="relative">
          <Search size={12} class="absolute top-2 left-2 text-[var(--color-text-faint)]" />
          <input class="field" style={{ width: 240, paddingLeft: 24 }} placeholder="Tìm ghi nhớ…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </div>
        {scope === 'private' && (
          <select class="field" style={{ width: 'auto' }} value={agentId} onChange={(e) => setAgentId((e.target as HTMLSelectElement).value)} aria-label="Lọc theo agent">
            <option value="">Mọi agent</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
      </div>
      <PageState loading={f.loading && !f.data} error={f.error} empty={!!f.data && items.length === 0} emptyTitle={dq ? `Không có ghi nhớ khớp “${dq}”` : 'Chưa có ghi nhớ nào'} emptyDescription="Ghi nhớ là những điều ngắn mà agent cần nhớ lâu, ví dụ giờ làm việc hoặc sở thích của bạn." />
      <ul class="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((m) => (
          <li key={m.id} class="card flex items-start gap-3 px-3.5 py-2.5">
            <div class="min-w-0 flex-1">
              <div class="whitespace-pre-wrap text-[12.5px]">{m.content}</div>
              <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
                {m.pinned && <Pill tone="accent">Đã ghim</Pill>}
                {m.agentId && <Pill>{resolveAgentName(m.agentId)}</Pill>}
                <span class="hint">{m.source === 'user' ? 'Bạn thêm' : `Do ${resolveAgentName(m.source.replace('agent:', ''))} ghi`} · {formatRelativeTime(m.createdAt)} · dùng {m.useCount} lần</span>
              </div>
            </div>
            <div class="flex shrink-0 gap-1">
              <button type="button" class="control-button control-sm" aria-label={m.pinned ? 'Bỏ ghim' : 'Ghim'} onClick={() => void pin(m)}>{m.pinned ? <PinOff size={11} /> : <Pin size={11} />}</button>
              <button type="button" class="control-button control-sm" aria-label="Sửa" onClick={() => setEdit({ id: m.id, content: m.content, agentId: m.agentId })}><Pencil size={11} /></button>
              <button type="button" class="control-button control-sm control-danger" aria-label="Xoá" onClick={() => setDel(m)}><Trash2 size={11} /></button>
            </div>
          </li>
        ))}
      </ul>

      <Modal open={edit !== null} onClose={() => setEdit(null)} title={edit?.id ? 'Sửa ghi nhớ' : 'Thêm ghi nhớ'} width={520} closeDisabled={busy} footer={<><button type="button" class="control-button" disabled={busy} onClick={() => setEdit(null)}>Huỷ</button><button type="button" class="control-button control-accent" disabled={busy || !edit?.content.trim()} onClick={() => void save()}>Lưu</button></>}>
        {edit && (
          <div class="flex flex-col gap-3">
            {!edit.id && (
              <Field label="Thuộc về">
                <select class="field" value={edit.agentId ?? ''} onChange={(e) => setEdit({ ...edit, agentId: (e.target as HTMLSelectElement).value || null })}>
                  <option value="">Cả đội (mọi agent được cấp quyền đều thấy)</option>
                  {agents.map((a) => <option key={a.id} value={a.id}>Riêng {a.name}</option>)}
                </select>
              </Field>
            )}
            <Field label="Nội dung"><textarea class="field" rows={5} value={edit.content} onInput={(e) => setEdit({ ...edit, content: (e.target as HTMLTextAreaElement).value })} /></Field>
          </div>
        )}
      </Modal>
      <ConfirmModal open={del !== null} onClose={() => setDel(null)} onConfirm={() => void remove()} destructive loading={busy} title="Xoá ghi nhớ?" body={del?.content.slice(0, 160)} confirmLabel="Xoá" />
    </div>
  );
}
