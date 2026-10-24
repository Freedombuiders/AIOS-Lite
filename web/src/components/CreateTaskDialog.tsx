import { useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import type { Task } from '@core/types';
import { Modal } from '@/components/Modal';
import { Field } from '@/components/ui';
import { apiPost, errorText } from '@/lib/api';
import type { AgentSummary } from '@/lib/api-types';
import { pushToast } from '@/lib/toasts';

export function CreateTaskDialog({ open, agents, onClose }: { open: boolean; agents: AgentSummary[]; onClose: () => void }) {
  const [, nav] = useLocation();
  const enabled = agents.filter((a) => a.enabled);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [agentId, setAgentId] = useState('');
  const [priority, setPriority] = useState(5);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const chosen = agentId || enabled.find((a) => a.id === 'main')?.id || enabled[0]?.id || '';

  async function submit() {
    if (!prompt.trim()) return setErr('Hãy mô tả việc cần làm.');
    setBusy(true);
    setErr(null);
    try {
      const t = await apiPost<Task>('/tasks', { prompt: prompt.trim(), title: title.trim() || undefined, agentId: chosen, priority });
      pushToast({ tone: 'success', title: `Đã tạo việc #${t.id}` });
      setTitle('');
      setPrompt('');
      onClose();
      nav(`/tasks/${t.id}`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Tạo công việc"
      width={560}
      closeDisabled={busy}
      footer={
        <>
          {err && <span class="mr-auto text-[12px] text-[var(--color-status-failed)]">{err}</span>}
          <button type="button" class="control-button" disabled={busy} onClick={onClose}>Huỷ</button>
          <button type="button" class="control-button control-accent" disabled={busy} onClick={() => void submit()}>{busy ? 'Đang tạo…' : 'Tạo việc'}</button>
        </>
      }
    >
      <div class="flex flex-col gap-3">
        <Field label="Tiêu đề" hint="Để trống: lấy 80 ký tự đầu của yêu cầu.">
          <input class="field" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Yêu cầu cho agent">
          <textarea class="field" rows={5} value={prompt} onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)} />
        </Field>
        <div class="grid grid-cols-2 gap-3">
          <Field label="Agent">
            <select class="field" value={chosen} onChange={(e) => setAgentId((e.target as HTMLSelectElement).value)}>
              {enabled.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Ưu tiên">
            <select class="field" value={priority} onChange={(e) => setPriority(Number((e.target as HTMLSelectElement).value))}>
              <option value={10}>Cao</option>
              <option value={5}>Thường</option>
              <option value={1}>Thấp</option>
            </select>
          </Field>
        </div>
      </div>
    </Modal>
  );
}
