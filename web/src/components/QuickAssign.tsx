import { Send } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import type { Task } from '@core/types';
import type { AgentSummary } from '@/lib/api-types';
import { apiPost, errorText } from '@/lib/api';
import { pushToast } from '@/lib/toasts';

/** Agent picker + prompt → POST /api/tasks. */
export function QuickAssign({ agents, defaultAgentId }: { agents: AgentSummary[]; defaultAgentId?: string }) {
  const [, nav] = useLocation();
  const enabled = agents.filter((a) => a.enabled);
  const [agentId, setAgentId] = useState(defaultAgentId ?? '');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = agentId || enabled.find((a) => a.id === 'main')?.id || enabled[0]?.id || '';

  async function submit() {
    if (!prompt.trim() || !chosen) return;
    setBusy(true);
    try {
      const t = await apiPost<Task>('/tasks', { prompt: prompt.trim(), agentId: chosen });
      pushToast({ tone: 'success', title: `Đã giao việc #${t.id}` });
      setPrompt('');
      nav(`/tasks/${t.id}`);
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không giao được việc', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!enabled.length) return <div class="hint">Chưa có agent nào đang bật. Tạo agent ở trang Agents trước.</div>;
  return (
    <div class="flex flex-col gap-2">
      <textarea
        class="field"
        rows={3}
        placeholder="Việc cần làm, ví dụ: Tóm tắt phản hồi khách tuần này…"
        value={prompt}
        onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit();
        }}
      />
      <div class="flex items-center gap-2">
        <select class="field" style={{ width: 'auto', minWidth: 160 }} value={chosen} onChange={(e) => setAgentId((e.target as HTMLSelectElement).value)} aria-label="Agent nhận việc">
          {enabled.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button type="button" class="control-button control-accent ml-auto" disabled={busy || !prompt.trim()} onClick={() => void submit()}>
          <Send size={12} /> Giao việc
        </button>
      </div>
    </div>
  );
}
