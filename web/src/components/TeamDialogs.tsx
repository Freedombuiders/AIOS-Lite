import { useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import type { Task } from '@core/types';
import { Modal } from '@/components/Modal';
import { Field } from '@/components/ui';
import { apiPost, errorText } from '@/lib/api';
import type { AgentSummary } from '@/lib/api-types';
import { pushToast } from '@/lib/toasts';

interface Props {
  open: boolean;
  mode: 'parallel' | 'relay';
  agents: AgentSummary[];
  onClose: () => void;
}

/** "Hỏi cả nhóm" (parallel + merge) and "Relay" (agent after agent) share one dialog. */
export function TeamDialog({ open, mode, agents, onClose }: Props) {
  const [, nav] = useLocation();
  const enabled = agents.filter((a) => a.enabled);
  const [prompt, setPrompt] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [mergeBy, setMergeBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const parallel = mode === 'parallel';

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  async function submit() {
    if (!prompt.trim()) return setErr('Hãy nhập câu hỏi hoặc yêu cầu.');
    if (picked.length < 2) return setErr('Chọn ít nhất 2 agent.');
    setBusy(true);
    setErr(null);
    try {
      const t = await apiPost<Task>('/tasks/team', { prompt: prompt.trim(), agentIds: picked, mode, mergeBy: parallel ? mergeBy || picked[0] : undefined });
      pushToast({ tone: 'success', title: parallel ? 'Đã hỏi cả nhóm' : 'Đã bắt đầu relay', description: `Việc #${t.id}` });
      setPrompt('');
      setPicked([]);
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
      title={parallel ? 'Hỏi cả nhóm' : 'Relay giữa các agent'}
      width={560}
      closeDisabled={busy}
      footer={
        <>
          {err && <span class="mr-auto text-[12px] text-[var(--color-status-failed)]">{err}</span>}
          <button type="button" class="control-button" disabled={busy} onClick={onClose}>Huỷ</button>
          <button type="button" class="control-button control-accent" disabled={busy} onClick={() => void submit()}>{busy ? 'Đang gửi…' : parallel ? 'Hỏi cả nhóm' : 'Bắt đầu relay'}</button>
        </>
      }
    >
      <div class="flex flex-col gap-3">
        <p class="hint m-0">
          {parallel ? 'Các agent được chọn trả lời cùng lúc, rồi một agent tổng hợp các câu trả lời.' : 'Agent đầu làm trước, kết quả được chuyển cho agent kế tiếp theo thứ tự bạn chọn.'}
        </p>
        <Field label="Yêu cầu">
          <textarea class="field" rows={4} value={prompt} onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)} placeholder="Ví dụ: Nên giảm giá gói Starter không?" />
        </Field>
        <div>
          <span class="label">{parallel ? 'Agent tham gia' : 'Agent theo thứ tự (bấm để thêm vào chuỗi)'}</span>
          <div class="grid gap-1 sm:grid-cols-2">
            {enabled.map((a) => {
              const i = picked.indexOf(a.id);
              return (
                <label key={a.id} class="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] px-2 py-1.5 text-[12px]">
                  <input type="checkbox" checked={i >= 0} onChange={() => toggle(a.id)} />
                  <span class="flex-1 truncate">{a.name}</span>
                  {!parallel && i >= 0 && <span class="pill pill-accent">{i + 1}</span>}
                </label>
              );
            })}
          </div>
        </div>
        {parallel && (
          <Field label="Agent tổng hợp" hint="Mặc định là agent đầu tiên trong danh sách chọn.">
            <select class="field" value={mergeBy} onChange={(e) => setMergeBy((e.target as HTMLSelectElement).value)}>
              <option value="">Tự chọn (agent đầu tiên)</option>
              {enabled.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        )}
      </div>
    </Modal>
  );
}
