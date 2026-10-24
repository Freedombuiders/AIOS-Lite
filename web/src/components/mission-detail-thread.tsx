import { stripDirectives } from '@/lib/directives';
import { useMemo, useState } from 'preact/hooks';
import { Send } from 'lucide-preact';
import { Pill } from '@/components/Pill';
import { SectionTitle, errMessage, inputClass, markdownClass } from '@/components/mission-detail-shared';
import { apiPost } from '@/lib/api';
import { renderMarkdown } from '@/lib/markdown';
import { resolveAgentName } from '@/lib/format';
import { pushToast } from '@/lib/toasts';
import {
  authorLabel, buildThread, formatDateTime, formatRunDuration, statusLabel, statusTone, timeAgoVi,
  type MissionDetail, type MissionRun, type MissionComment,
} from '@/lib/mission-detail';

function CommentRow({ c }: { c: MissionComment }) {
  if (c.author_kind === 'system') {
    return <li class="flex items-start gap-2 py-1 text-[12.5px] text-[var(--color-text-muted)]">
      <span aria-hidden="true" class="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[var(--color-text-faint)]" />
      <span class="min-w-0 flex-1 break-words">{c.body}</span>
      <time class="shrink-0 text-[11.5px] text-[var(--color-text-faint)]" title={formatDateTime(c.created_at)}>{timeAgoVi(c.created_at)}</time>
    </li>;
  }
  const mine = c.author_kind === 'owner';
  return <li class={'rounded-lg border px-3.5 py-3 ' + (mine
    ? 'border-[var(--color-border)] bg-[var(--color-card)]'
    : 'border-[var(--color-border)] bg-[var(--color-elevated)]')}>
    <div class="mb-1 flex items-center gap-2 text-[12px]">
      <span class="font-medium text-[var(--color-text)]">{authorLabel(c, resolveAgentName)}</span>
      {c.author_kind === 'agent' && <Pill tone="accent">Agent</Pill>}
      <time class="ml-auto text-[11.5px] text-[var(--color-text-faint)]" title={formatDateTime(c.created_at)}>{timeAgoVi(c.created_at)}</time>
    </div>
    <div class={markdownClass + ' text-[13.5px]'} dangerouslySetInnerHTML={{ __html: renderMarkdown(c.body) }} />
  </li>;
}

function RunRow({ run }: { run: MissionRun }) {
  const duration = formatRunDuration(run.startedAt, run.completedAt);
  const raw = run.status === 'completed' ? run.result : run.error || run.result;
  const text = raw ? stripDirectives(raw) : raw;
  return <li class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3.5 py-3">
    <div class="mb-1.5 flex flex-wrap items-center gap-2 text-[12px]">
      <span class="font-medium text-[var(--color-text)]">{run.agent ? resolveAgentName(run.agent) : 'Agent'}</span>
      <Pill tone={statusTone(run.status)}>Lần chạy: {statusLabel(run.status)}</Pill>
      {duration && <span class="text-[var(--color-text-muted)]">trong {duration}</span>}
      {run.completedAt && <time class="ml-auto text-[11.5px] text-[var(--color-text-faint)]" title={formatDateTime(run.completedAt)}>{timeAgoVi(run.completedAt)}</time>}
    </div>
    {text
      ? <div class={markdownClass + ' text-[13.5px] ' + (run.status === 'completed' ? '' : 'text-[var(--color-status-failed)]')}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
      : <p class="text-[12.5px] text-[var(--color-text-muted)]">Lần chạy kết thúc mà không có nội dung trả về.</p>}
  </li>;
}

/** Trao đổi: owner and agent comments, system notes and each run's outcome, plus the input box. */
export function MissionThread({ detail, onChange }: { detail: MissionDetail; onChange: () => void }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const thread = useMemo(() => buildThread(detail.comments, detail.runs), [detail.comments, detail.runs]);

  async function send() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await apiPost(`/tasks/${detail.task.id}/comments`, { body: text });
      setBody('');
      onChange();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không gửi được bình luận', description: errMessage(err) });
    } finally { setBusy(false); }
  }

  return <section aria-label="Trao đổi" class="mt-8 pb-8">
    <SectionTitle aside={thread.length > 0 ? `${thread.length} mục` : undefined}>Trao đổi</SectionTitle>
    {thread.length === 0
      ? <p class="mb-3 text-[12.5px] text-[var(--color-text-muted)]">Chưa có trao đổi nào. Kết quả của từng lần chạy và ghi chú sẽ hiện ở đây.</p>
      : <ol class="mb-4 space-y-2">
          {thread.map((e) => e.kind === 'comment' ? <CommentRow key={e.key} c={e.comment} /> : <RunRow key={e.key} run={e.run} />)}
        </ol>}
    <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-2">
      <textarea aria-label="Viết bình luận" class={inputClass + ' min-h-[84px] resize-y border-0 bg-transparent'} value={body}
        placeholder="Viết ghi chú hoặc chỉ dẫn cho task này…"
        onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
      <div class="flex items-center justify-between gap-2 px-1 pt-1">
        <span class="hidden text-[11.5px] text-[var(--color-text-faint)] sm:inline">Ctrl/⌘ + Enter để gửi</span>
        <button type="button" onClick={send} disabled={busy || !body.trim()}
          class="control-button control-accent ml-auto inline-flex min-h-[40px] items-center gap-1.5 rounded px-3 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-40">
          <Send size={13} aria-hidden="true" /> {busy ? 'Đang gửi…' : 'Gửi'}
        </button>
      </div>
    </div>
  </section>;
}
