import { Ban, Check, ChevronDown, ChevronRight, RotateCcw, Send } from 'lucide-preact';
import { splitDirectives, stripDirectives } from '@/lib/directives';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import type { Run, RunEvent, StoredRunEvent, Task, TaskComment } from '@core/types';
import { AgentAvatar } from '@/components/AgentAvatar';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { StatusPill } from '@/components/TaskBits';
import { Card, Markdown } from '@/components/ui';
import { apiGet, apiPost, errorText } from '@/lib/api';
import type { AccessSnapshot } from '@/lib/api-types';
import { formatCost, formatDateTime, formatDuration, formatNumber, formatRelativeTime, resolveAgentName } from '@/lib/format';
import { ERROR_FAMILY_LABEL, SOURCE_LABEL, TRIGGER_LABEL } from '@/lib/labels';
import { renderMarkdown } from '@/lib/markdown';
import { useEvents } from '@/lib/sse';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';

interface TaskDetailDto {
  task: Task;
  runs: Run[];
  children: Task[];
  comments: TaskComment[];
  parent: Task | null;
}

function AccessSummary({ a }: { a: AccessSnapshot }) {
  const brain = a.readDirs.map((d) => `${d.folderId} (${d.globs.join(', ')})`);
  const write = a.writeDirs.map((d) => `${d.folderId} (${d.globs.join(', ')})`);
  const rows: [string, string][] = [
    ['Đọc brain', brain.join('; ') || 'không'],
    ['Ghi brain', write.join('; ') || 'không'],
    ['Bộ nhớ', [a.memory.team && 'đội', a.memory.private && 'riêng'].filter(Boolean).join(', ') || 'không'],
    ['Kết nối', a.mcpServers.map((m) => `${m.id}: ${m.allowedTools.join(', ')}`).join('; ') || 'không'],
    ['Skills', a.skills.join(', ') || 'không'],
    ['Module', Object.entries(a.moduleScopes).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ') || 'không'],
    ['Công cụ', a.tools === 'none' ? 'không (lean)' : 'mặc định'],
  ];
  return (
    <table class="table">
      <tbody>{rows.map(([k, v]) => <tr key={k}><td class="w-28 text-[var(--color-text-faint)]">{k}</td><td>{v}</td></tr>)}</tbody>
    </table>
  );
}

function RunRow({ run, selected, onSelect }: { run: Run; selected: boolean; onSelect: () => void }) {
  const [open, setOpen] = useState(false);
  const detail = useFetch<{ run: Run; events: StoredRunEvent[]; access: AccessSnapshot | null }>(open ? `/runs/${run.id}` : null);
  return (
    <>
      <tr class={selected ? 'bg-[var(--color-accent-soft)]' : ''}>
        <td>
          <button type="button" class="flex items-center gap-1 border-0 bg-transparent p-0 text-[var(--color-text)] cursor-pointer" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} <span class="mono">#{run.id}</span>
          </button>
        </td>
        <td>{resolveAgentName(run.agentId)} <span class="hint">· {run.runtime}{run.model ? ` / ${run.model}` : ''}</span></td>
        <td><Pill tone={run.status === 'done' ? 'success' : run.status === 'failed' ? 'error' : run.status === 'running' ? 'info' : 'neutral'}>{run.status === 'running' ? 'Đang chạy' : run.status === 'done' ? 'Xong' : run.status === 'failed' ? 'Lỗi' : 'Đã huỷ'}</Pill>{run.errorFamily && <span class="hint ml-1">{ERROR_FAMILY_LABEL[run.errorFamily]}</span>}</td>
        <td>{formatNumber(run.inputTokens)} / {formatNumber(run.outputTokens)}</td>
        <td>{formatCost(run.costUsd)}</td>
        <td>{formatDuration(run.durationMs)}</td>
        <td><button type="button" class="control-button control-sm" onClick={onSelect} disabled={selected}>{selected ? 'Đang xem' : 'Xem luồng'}</button></td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} class="bg-[var(--color-bg)]">
            <PageState loading={detail.loading && !detail.data} error={detail.error} />
            {run.error && <div class="mb-2 text-[12px] text-[var(--color-status-failed)]">{run.error}</div>}
            {detail.data?.access ? <><div class="section-title mb-1">Quyền lúc chạy (ảnh chụp)</div><AccessSummary a={detail.data.access} /></> : detail.data && <div class="hint">Lượt chạy này không lưu ảnh chụp quyền.</div>}
          </td>
        </tr>
      )}
    </>
  );
}

function EventLine({ ev }: { ev: RunEvent }) {
  if (ev.type === 'tool') return <div class="my-0.5 text-[11.5px] text-[var(--color-status-running)]">▸ {ev.name}{ev.status === 'error' ? ' (lỗi)' : ''}</div>;
  if (ev.type === 'status') return <div class="my-0.5 text-[11.5px] text-[var(--color-text-faint)]">— {ev.message}</div>;
  if (ev.type === 'thinking') return <span class="text-[var(--color-text-faint)] italic">{ev.text}</span>;
  return null;
}

type StreamGroup = { kind: 'text'; key: number; text: string } | { kind: 'event'; key: number; ev: StoredRunEvent['event'] };

// Consecutive text chunks are merged so a directive tag split across chunks is still recognised.
function groupEvents(events: StoredRunEvent[]): StreamGroup[] {
  const out: StreamGroup[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (e.event.type === 'text') {
      if (last?.kind === 'text') last.text += e.event.text;
      else out.push({ kind: 'text', key: e.id, text: e.event.text });
    } else out.push({ kind: 'event', key: e.id, ev: e.event });
  }
  return out;
}

export function LiveStream({ taskId, run }: { taskId: number; run: Run | undefined }) {
  const [events, setEvents] = useState<StoredRunEvent[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const runId = run?.id;

  useEffect(() => {
    setEvents([]);
    if (!runId) return;
    let alive = true;
    apiGet<{ events: StoredRunEvent[] }>(`/runs/${runId}`).then((r) => alive && setEvents(r.events)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [runId]);

  const onEvent = useCallback((e: import('@/lib/events').AppEvent) => {
    if (e.type === 'run-event' && e.taskId === taskId && e.runId === runId) {
      setEvents((prev) => [...prev, { id: -prev.length - 1, runId: e.runId, ts: new Date().toISOString(), event: e.event }]);
    }
  }, [taskId, runId]);
  useEvents(['run-event'], onEvent);

  useEffect(() => {
    const el = box.current;
    if (el && run?.status === 'running') el.scrollTop = el.scrollHeight;
  }, [events.length, run?.status]);

  if (!run) return <div class="hint">Chưa có lượt chạy nào. Khi agent bắt đầu, chữ sẽ hiện trực tiếp ở đây.</div>;
  return (
    <div ref={box} class="stream max-h-[360px] overflow-y-auto rounded-[var(--radius-md)] bg-[var(--color-bg)] p-3" aria-live="polite">
      {events.length === 0 && <span class="hint">{run.status === 'running' ? 'Đang chờ agent trả lời…' : 'Lượt chạy không ghi sự kiện.'}</span>}
      {groupEvents(events).map((g) => (g.kind === 'text'
        ? <span key={g.key}>{splitDirectives(g.text).map((s, i) => (s.kind === 'text' ? s.text : <span key={i} class="mx-0.5 inline-block rounded-full border border-[var(--color-border-strong)] bg-[var(--color-accent-soft)] px-2 py-px align-baseline font-sans text-[11px] text-[var(--color-accent)]">{s.label}</span>))}</span>
        : <EventLine key={g.key} ev={g.ev} />))}
      {run.status === 'running' && <span class="dot dot-info dot-pulse ml-1" />}
    </div>
  );
}

export default function TaskDetail({ id }: { id: number }) {
  const f = useFetch<TaskDetailDto>(`/tasks/${id}`);
  const [comment, setComment] = useState('');
  const [requeue, setRequeue] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selectedRun, setSelectedRun] = useState<number | null>(null);

  const refresh = f.refresh;
  const onEvent = useCallback((e: import('@/lib/events').AppEvent) => {
    if ((e.type === 'task' && (e.task.id === id || e.task.parentId === id)) || (e.type === 'run' && e.run.taskId === id)) refresh();
  }, [id, refresh]);
  useEvents(['task', 'run'], onEvent);

  async function act(path: string, ok: string) {
    setBusy(true);
    try {
      await apiPost(`/tasks/${id}/${path}`);
      pushToast({ tone: 'success', title: ok });
      refresh();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Thao tác không thành công', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!comment.trim()) return;
    setBusy(true);
    try {
      await apiPost(`/tasks/${id}/comments`, { body: comment.trim(), requeue });
      setComment('');
      refresh();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không gửi được bình luận', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const d = f.data;
  if (!d) return <div class="page"><PageState loading={f.loading} error={f.error} /></div>;
  const t = d.task;
  const runs = [...d.runs].sort((a, b) => b.id - a.id);
  const shown = runs.find((r) => r.id === selectedRun) ?? runs[0];
  const canApprove = t.status === 'review';
  const canRetry = ['failed', 'cancelled', 'done'].includes(t.status);
  const canCancel = ['queued', 'running', 'waiting', 'review'].includes(t.status);

  return (
    <div class="page">
      <PageHeader
        breadcrumb={d.parent ? `Công việc › #${d.parent.id} ${d.parent.title}` : 'Công việc'}
        title={`#${t.id} ${t.title}`}
        actions={
          <>
            {canApprove && <button type="button" class="control-button control-accent" disabled={busy} onClick={() => void act('approve', 'Đã duyệt')}><Check size={12} /> Duyệt</button>}
            {canRetry && <button type="button" class="control-button" disabled={busy} onClick={() => void act('retry', 'Đã xếp lại hàng chờ')}><RotateCcw size={12} /> Thử lại</button>}
            {canCancel && <button type="button" class="control-button control-danger" disabled={busy} onClick={() => void act('cancel', 'Đã huỷ việc')}><Ban size={12} /> Huỷ</button>}
          </>
        }
      />
      <div class="mb-3 flex flex-wrap items-center gap-2 text-[12px]">
        <StatusPill status={t.status} />
        <span class="flex items-center gap-1.5"><AgentAvatar agentId={t.agentId} name={resolveAgentName(t.agentId)} size={18} /><Link href={`/agents/${t.agentId}`}>{resolveAgentName(t.agentId)}</Link></span>
        <Pill>{SOURCE_LABEL(t.source)}</Pill>
        <Pill>{TRIGGER_LABEL[t.trigger] ?? t.trigger}</Pill>
        {t.contextProfile === 'lean' && <Pill>lean</Pill>}
        {t.kind === 'team' && <Pill tone="waiting">nhóm · {String(t.meta.mode ?? '')}</Pill>}
        <span class="hint">Tạo {formatRelativeTime(t.createdAt)}{t.finishedAt ? ` · xong ${formatDateTime(t.finishedAt)}` : ''}</span>
      </div>

      <div class="grid gap-3 lg:grid-cols-5">
        <div class="flex min-w-0 flex-col gap-3 lg:col-span-3">
          <Card title="Yêu cầu"><div class="whitespace-pre-wrap text-[12.5px]">{t.prompt}</div></Card>
          <Card title={shown ? `Luồng chạy · lượt #${shown.id}` : 'Luồng chạy'}><LiveStream taskId={t.id} run={shown} /></Card>
          {t.error && <Card title="Lỗi"><div class="text-[12.5px] text-[var(--color-status-failed)]">{t.error}</div></Card>}
          {t.result && <Card title="Kết quả"><Markdown html={renderMarkdown(stripDirectives(t.result))} /></Card>}
          <Card title={`Bình luận · ${d.comments.length}`}>
            {d.comments.length === 0 && <div class="hint mb-2">Chưa có bình luận. Góp ý ở đây để agent làm lại theo ý bạn.</div>}
            <ul class="m-0 mb-3 flex list-none flex-col gap-2 p-0">
              {d.comments.map((c) => (
                <li key={c.id} class={`rounded-[var(--radius-md)] px-3 py-2 ${c.author === 'user' ? 'bubble-user' : 'bubble-agent'}`}>
                  <div class="hint mb-0.5">{c.author === 'user' ? 'Bạn' : c.author === 'system' ? 'Hệ thống' : resolveAgentName(c.author.replace('agent:', ''))} · {formatRelativeTime(c.createdAt)}</div>
                  <div class="whitespace-pre-wrap text-[12.5px]">{c.body}</div>
                </li>
              ))}
            </ul>
            <textarea class="field" rows={3} placeholder="Viết bình luận…" value={comment} onInput={(e) => setComment((e.target as HTMLTextAreaElement).value)} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void send(); }} />
            <div class="mt-2 flex items-center gap-3">
              <label class="flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]"><input type="checkbox" checked={requeue} onChange={(e) => setRequeue((e.target as HTMLInputElement).checked)} /> Cho agent làm lại theo bình luận</label>
              <button type="button" class="control-button control-accent ml-auto" disabled={busy || !comment.trim()} onClick={() => void send()}><Send size={12} /> Gửi</button>
            </div>
          </Card>
        </div>

        <div class="flex min-w-0 flex-col gap-3 lg:col-span-2">
          <Card title={`Việc con · ${d.children.length}`}>
            {d.parent && <div class="mb-2 text-[12px]">Thuộc việc <Link href={`/tasks/${d.parent.id}`}>#{d.parent.id} {d.parent.title}</Link></div>}
            {d.children.length === 0 ? <div class="hint">Không có việc con.</div> : (
              <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
                {d.children.map((c) => (
                  <li key={c.id} class="flex items-center gap-2 text-[12px]">
                    <StatusPill status={c.status} />
                    <Link href={`/tasks/${c.id}`} class="min-w-0 flex-1 truncate">#{c.id} {c.title}</Link>
                    <span class="hint">{resolveAgentName(c.agentId)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={`Lượt chạy · ${runs.length}`}>
            {runs.length === 0 ? <div class="hint">Chưa có lượt chạy.</div> : (
              <div class="overflow-x-auto">
                <table class="table">
                  <thead><tr><th>Lượt</th><th>Agent</th><th>Trạng thái</th><th>Token</th><th>Chi phí</th><th>Thời gian</th><th /></tr></thead>
                  <tbody>{runs.map((r) => <RunRow key={r.id} run={r} selected={shown?.id === r.id} onSelect={() => setSelectedRun(r.id)} />)}</tbody>
                </table>
              </div>
            )}
            <div class="hint mt-2">“—” nghĩa là runtime không báo số liệu, không phải bằng 0.</div>
          </Card>
        </div>
      </div>
    </div>
  );
}
