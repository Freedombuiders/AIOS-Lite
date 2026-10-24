import { useEffect, useMemo, useState } from 'preact/hooks';
import { Link, useRoute } from 'wouter-preact';
import { ArrowLeft } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { markdownClass } from '@/components/mission-detail-shared';
import { MissionProperties } from '@/components/mission-detail-properties';
import { MissionSubtasks } from '@/components/mission-detail-subtasks';
import { MissionThread } from '@/components/mission-detail-thread';
import { useFetch } from '@/lib/useFetch';
import { renderMarkdown } from '@/lib/markdown';
import { seedAgentNames } from '@/lib/format';
import { apiPost } from '@/lib/api';
import { useEvents } from '@/lib/sse';
import { pushToast } from '@/lib/toasts';
import { LiveStream } from '@/pages/tasks/TaskDetail';
import { fromAiosDetail, statusLabel, statusTone, shouldCollapsePrompt, taskLabel, type AiosDetailDto } from '@/lib/mission-detail';
import type { Run } from '@core/types';

interface Agent { id: string; name: string }

/** /tasks/:id: one task with its prompt, sub-tasks, thread and the properties panel. */
export default function MissionTaskDetail() {
  const [, params] = useRoute('/tasks/:id');
  const id = params?.id ?? '';
  const raw = useFetch<AiosDetailDto & { runs: Run[] }>(id ? `/tasks/${encodeURIComponent(id)}` : null);
  const detail = { ...raw, data: useMemo(() => (raw.data ? fromAiosDetail(raw.data) : null), [raw.data]) };
  const refreshDetail = raw.refresh;
  useEvents(['task', 'run'], () => refreshDetail());
  const agentsFetch = useFetch<{ items: Agent[] }>('/agents', 60_000);
  const agents = useMemo(() => (agentsFetch.data?.items ?? []).map((a) => ({ id: a.id, name: a.name || a.id })), [agentsFetch.data]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => { if (agentsFetch.data?.items) seedAgentNames(agentsFetch.data.items); }, [agentsFetch.data]);
  useEffect(() => { setExpanded(false); }, [id]);

  const d = detail.data;
  async function act(path: string, ok: string) {
    try { await apiPost(`/tasks/${id}/${path}`); pushToast({ tone: 'success', title: ok }); refreshDetail(); } catch (e) { pushToast({ tone: 'error', title: 'Thao tác không thành công', description: e instanceof Error ? e.message : String(e) }); }
  }
  const notFound = !d && !detail.loading && !!detail.error;

  return <div class="flex h-full min-w-0 flex-col">
    <PageHeader title="Chi tiết task" actions={<>
      {d?.task.status === 'review' && <button type="button" class="control-button control-accent" onClick={() => void act('approve', 'Đã duyệt')}>Duyệt</button>}
      {d && ['completed', 'failed', 'cancelled'].includes(d.task.status) && <button type="button" class="control-button" onClick={() => void act('retry', 'Đã xếp lại hàng chờ')}>Thử lại</button>}
      <Link href="/tasks" class="inline-flex min-h-[36px] items-center gap-1.5 rounded px-2 text-[13px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
        <ArrowLeft size={14} aria-hidden="true" /> Danh sách việc
      </Link></>
    } />
    {!d
      ? <div class="flex-1 overflow-y-auto"><PageState loading={detail.loading} error={notFound ? 'Không tìm thấy task này, hoặc task đã bị xóa.' : null} /></div>
      : <div class="min-h-0 flex-1 overflow-y-auto lg:flex lg:overflow-hidden">
          <main class="min-w-0 px-4 pt-5 sm:px-6 lg:flex-1 lg:overflow-y-auto">
            <div class="mx-auto max-w-3xl">
              <nav aria-label="Đường dẫn" class="mb-3 flex flex-wrap items-center gap-1.5 text-[12.5px] text-[var(--color-text-muted)]">
                <Link href="/tasks" class="hover:text-[var(--color-text)]">Công việc</Link>
                {d.parent && <>
                  <span aria-hidden="true">›</span>
                  <Link href={`/tasks/${d.parent.id}`} class="max-w-[16rem] truncate hover:text-[var(--color-text)]">{d.parent.title}</Link>
                </>}
                <span aria-hidden="true">›</span>
                <span class="max-w-[16rem] truncate text-[var(--color-text)]">{d.task.title}</span>
              </nav>
              <div class="mb-2 flex flex-wrap items-center gap-2">
                <span class="tabular-nums text-[13px] font-medium text-[var(--color-text-muted)]">{taskLabel(d.task)}</span>
                <Pill tone={statusTone(d.task.status, d.blocked)}>{statusLabel(d.task.status, d.blocked)}</Pill>
              </div>
              <h1 class="mb-5 break-words text-[22px] font-semibold leading-snug tracking-[-0.02em]">{d.task.title}</h1>

              <section aria-label="Nội dung giao việc">
                <div class={markdownClass + ' text-[14px] ' + (shouldCollapsePrompt(d.task.prompt) && !expanded ? 'max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]' : '')}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(d.task.prompt) }} />
                {shouldCollapsePrompt(d.task.prompt) && (
                  <button type="button" onClick={() => setExpanded(!expanded)}
                    class="mt-1 min-h-[36px] text-[13px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                    {expanded ? 'Thu gọn' : 'Xem thêm'}
                  </button>
                )}
              </section>

              <section aria-label="Luồng chạy" class="mt-8"><LiveStream taskId={Number(d.task.id)} run={[...(raw.data?.runs ?? [])].sort((a, b) => b.id - a.id)[0]} /></section>
              <MissionSubtasks detail={d} agents={agents} onChange={detail.refresh} />
              <MissionThread detail={d} onChange={detail.refresh} />
            </div>
          </main>
          <aside class="mt-2 border-t border-[var(--color-border)] bg-[var(--color-card)] lg:mt-0 lg:w-[320px] lg:shrink-0 lg:overflow-y-auto lg:border-l lg:border-t-0">
            <MissionProperties detail={d} agents={agents} onChange={detail.refresh} />
          </aside>
        </div>}
  </div>;
}
