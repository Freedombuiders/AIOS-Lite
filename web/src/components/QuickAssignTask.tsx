import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { Send } from 'lucide-preact';
import { errMessage, inputClass } from '@/components/mission-detail-shared';
import { apiPost } from '@/lib/api';
import { useFetch } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';

interface AgentOption { id: string; name: string }

const TITLE_MAX = 80;

/** Top of the dashboard: pick an agent, write the job, send. Creates a Mission Control task. */
export function QuickAssignTask() {
  const agents = useFetch<{ items: AgentOption[] }>('/agents', 60_000);
  const [agent, setAgent] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const text = prompt.trim();

  async function submit() {
    if (!text || busy) return;
    const firstLine = text.split('\n')[0].trim();
    const title = firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX - 1)}…` : firstLine;
    setBusy(true);
    try {
      const res = await apiPost<{ id: number }>('/tasks', {
        title, prompt: text, ...(agent ? { agentId: agent } : {}),
      });
      setPrompt('');
      pushToast({ tone: 'success', title: agent ? 'Đã giao việc cho agent' : 'Đã tạo task (chưa gán agent)', description: `Task #${res.id}` });
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không giao được việc', description: errMessage(err) });
    } finally { setBusy(false); }
  }

  return (
    <section aria-label="Giao việc cho agent" class="os-chart-panel">
      <div class="os-section-heading">
        <h2>Giao việc cho agent<span>.</span></h2>
        <Link href="/tasks">Xem task ↗</Link>
      </div>
      <div class="flex flex-wrap items-start gap-2">
        <select class={`${inputClass} !w-auto min-w-[180px]`} aria-label="Agent nhận việc" value={agent}
          onChange={(e) => setAgent((e.target as HTMLSelectElement).value)}>
          <option value="">Chưa gán agent</option>
          {(agents.data?.items ?? []).map((a: AgentOption) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <textarea class={`${inputClass} flex-1 min-w-[240px] resize-y`} rows={2} aria-label="Nội dung giao việc"
          placeholder="Việc cần làm… (⌘/Ctrl+Enter để gửi)" value={prompt}
          onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }} />
        <button type="button" class="os-button" disabled={!text || busy} onClick={() => void submit()}>
          <Send size={14} />{busy ? 'Đang giao…' : 'Giao việc'}
        </button>
      </div>
    </section>
  );
}
