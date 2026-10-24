import { Pencil, Play, Plus, Trash2 } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import type { Schedule } from '@core/types';
import { ConfirmModal } from '@/components/ConfirmModal';
import { Modal } from '@/components/Modal';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { Toggle } from '@/components/Toggle';
import { Field } from '@/components/ui';
import { apiDelete, apiPost, apiPut, errorText } from '@/lib/api';
import { useAgents } from '@/lib/agents';
import { formatDateTime, formatRelativeTime, resolveAgentName } from '@/lib/format';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';

const PRESETS: { label: string; cron: string }[] = [
  { label: 'Mỗi giờ', cron: '0 * * * *' },
  { label: 'Mỗi 30 phút', cron: '*/30 * * * *' },
  { label: 'Hằng ngày 8:00', cron: '0 8 * * *' },
  { label: 'Hằng ngày 21:00', cron: '0 21 * * *' },
  { label: 'Các ngày trong tuần 8:00', cron: '0 8 * * 1-5' },
  { label: 'Thứ Hai 8:00', cron: '0 8 * * 1' },
  { label: 'Ngày 1 hằng tháng 9:00', cron: '0 9 1 * *' },
];
const ZONES = ['Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'Europe/London', 'America/New_York', 'UTC'];

function describe(cron: string): string {
  return PRESETS.find((p) => p.cron === cron.trim())?.label ?? 'Tuỳ chỉnh';
}

interface Draft {
  id?: number;
  name: string;
  agentId: string;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
}
const EMPTY: Draft = { name: '', agentId: '', cron: '0 8 * * *', timezone: 'Asia/Ho_Chi_Minh', prompt: '', enabled: true };

export default function SchedulesPage() {
  const f = useFetch<{ items: Schedule[] }>('/schedules');
  const { agents } = useAgents();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState<Schedule | null>(null);
  const items = f.data?.items ?? [];
  const enabledAgents = agents.filter((a) => a.enabled);

  async function save() {
    if (!draft) return;
    if (!draft.name.trim() || !draft.prompt.trim()) return setErr('Nhập tên và nội dung việc cần làm.');
    if (draft.cron.trim().split(/\s+/).length !== 5) return setErr('Cron cần đúng 5 trường: phút giờ ngày tháng thứ.');
    setBusy(true);
    setErr(null);
    const body = { name: draft.name.trim(), agentId: draft.agentId || enabledAgents[0]?.id, cron: draft.cron.trim(), timezone: draft.timezone, prompt: draft.prompt.trim(), enabled: draft.enabled };
    try {
      if (draft.id) await apiPut(`/schedules/${draft.id}`, body);
      else await apiPost('/schedules', body);
      pushToast({ tone: 'success', title: 'Đã lưu lịch' });
      setDraft(null);
      f.refresh();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(s: Schedule) {
    try {
      await apiPut(`/schedules/${s.id}`, { enabled: !s.enabled });
      f.refresh();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không đổi được trạng thái', description: errorText(e) });
    }
  }

  async function runNow(s: Schedule) {
    try {
      const t = await apiPost<{ id: number }>(`/schedules/${s.id}/run`);
      pushToast({ tone: 'success', title: `Đã tạo việc #${t.id} từ lịch “${s.name}”` });
      f.refresh();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không chạy được', description: errorText(e) });
    }
  }

  async function remove() {
    if (!del) return;
    setBusy(true);
    try {
      await apiDelete(`/schedules/${del.id}`);
      setDel(null);
      f.refresh();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không xoá được', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="page">
      <PageHeader title="Lịch định kỳ" actions={<button type="button" class="control-button control-accent" onClick={() => { setErr(null); setDraft({ ...EMPTY, agentId: enabledAgents[0]?.id ?? '' }); }}><Plus size={12} /> Tạo lịch</button>} />
      <PageState loading={f.loading && !f.data} error={f.error} empty={!!f.data && items.length === 0} emptyTitle="Chưa có lịch nào" emptyDescription="Lịch tạo công việc cho agent theo giờ cố định, ví dụ báo cáo mỗi sáng thứ Hai." action={<button type="button" class="control-button control-accent" onClick={() => setDraft({ ...EMPTY, agentId: enabledAgents[0]?.id ?? '' })}><Plus size={12} /> Tạo lịch đầu tiên</button>} />
      {items.length > 0 && (
        <div class="card overflow-x-auto">
          <table class="table">
            <thead><tr><th>Bật</th><th>Tên</th><th>Agent</th><th>Khi nào</th><th>Lần tới</th><th>Lần gần nhất</th><th /></tr></thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td><Toggle size="sm" on={s.enabled} onChange={() => void toggle(s)} ariaLabel={`Bật lịch ${s.name}`} /></td>
                  <td><div class="font-medium">{s.name}</div><div class="hint line-clamp-1 max-w-xs">{s.prompt}</div></td>
                  <td>{resolveAgentName(s.agentId)}</td>
                  <td><div>{describe(s.cron)}</div><div class="hint mono">{s.cron} · {s.timezone}</div></td>
                  <td>{s.enabled && s.nextRunAt ? <span title={formatDateTime(s.nextRunAt)}>{formatRelativeTime(s.nextRunAt)}</span> : <Pill>{s.enabled ? 'chưa tính' : 'đang tắt'}</Pill>}</td>
                  <td>{s.lastRunAt ? <>{formatRelativeTime(s.lastRunAt)} {s.lastTaskId && <Link href={`/tasks/${s.lastTaskId}`}>#{s.lastTaskId}</Link>}</> : <span class="hint">chưa chạy</span>}</td>
                  <td class="whitespace-nowrap text-right">
                    <button type="button" class="control-button control-sm" onClick={() => void runNow(s)}><Play size={11} /> Chạy ngay</button>{' '}
                    <button type="button" class="control-button control-sm" aria-label="Sửa" onClick={() => { setErr(null); setDraft({ id: s.id, name: s.name, agentId: s.agentId, cron: s.cron, timezone: s.timezone, prompt: s.prompt, enabled: s.enabled }); }}><Pencil size={11} /></button>{' '}
                    <button type="button" class="control-button control-sm control-danger" aria-label="Xoá" onClick={() => setDel(s)}><Trash2 size={11} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? 'Sửa lịch' : 'Tạo lịch'}
        width={560}
        closeDisabled={busy}
        footer={<>{err && <span class="mr-auto text-[12px] text-[var(--color-status-failed)]">{err}</span>}<button type="button" class="control-button" onClick={() => setDraft(null)} disabled={busy}>Huỷ</button><button type="button" class="control-button control-accent" disabled={busy} onClick={() => void save()}>{busy ? 'Đang lưu…' : 'Lưu'}</button></>}
      >
        {draft && (
          <div class="flex flex-col gap-3">
            <Field label="Tên lịch"><input class="field" value={draft.name} onInput={(e) => setDraft({ ...draft, name: (e.target as HTMLInputElement).value })} placeholder="Báo cáo sáng thứ Hai" /></Field>
            <div class="grid grid-cols-2 gap-3">
              <Field label="Agent làm việc">
                <select class="field" value={draft.agentId} onChange={(e) => setDraft({ ...draft, agentId: (e.target as HTMLSelectElement).value })}>
                  {enabledAgents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
              <Field label="Múi giờ">
                <input class="field" list="tz-list" value={draft.timezone} onInput={(e) => setDraft({ ...draft, timezone: (e.target as HTMLInputElement).value })} />
                <datalist id="tz-list">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
              </Field>
            </div>
            <div>
              <span class="label">Chạy khi nào</span>
              <div class="mb-2 flex flex-wrap gap-1.5">
                {PRESETS.map((p) => <button key={p.cron} type="button" class={`toolbar-control control-sm ${draft.cron === p.cron ? 'is-active' : ''}`} onClick={() => setDraft({ ...draft, cron: p.cron })}>{p.label}</button>)}
              </div>
              <input class="field mono" value={draft.cron} onInput={(e) => setDraft({ ...draft, cron: (e.target as HTMLInputElement).value })} aria-label="Biểu thức cron" />
              <div class="hint mt-1">5 trường: phút · giờ · ngày trong tháng · tháng · thứ (0 = Chủ nhật).</div>
            </div>
            <Field label="Việc cần làm mỗi lần"><textarea class="field" rows={4} value={draft.prompt} onInput={(e) => setDraft({ ...draft, prompt: (e.target as HTMLTextAreaElement).value })} /></Field>
            <label class="flex items-center gap-2 text-[12px]"><Toggle size="sm" on={draft.enabled} onChange={() => setDraft({ ...draft, enabled: !draft.enabled })} ariaLabel="Bật" /> Bật lịch này</label>
          </div>
        )}
      </Modal>
      <ConfirmModal open={del !== null} onClose={() => setDel(null)} onConfirm={() => void remove()} destructive loading={busy} title="Xoá lịch?" body={del ? `Lịch “${del.name}” sẽ bị xoá. Các việc đã tạo từ lịch vẫn còn.` : ''} confirmLabel="Xoá" />
    </div>
  );
}
