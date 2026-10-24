import { useEffect, useMemo, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { CareTabs } from '@modules/care/web/components/care/CareTabs';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { careApi } from '@modules/care/web/lib/care/client';
import type { CareTaskDto } from '@modules/care/web/lib/care/dto';
import { toCareFailure } from '@modules/care/web/lib/care/failure';
import { ct } from '@modules/care/web/lib/care/i18n';
import { channelsApi } from '@modules/care/web/lib/care-channels/api';
import { cc } from '@modules/care/web/lib/care-channels/i18n';
import { TASK_GROUP_ORDER, dayDistance, groupTasks, isLate, vnDate, vnTime, type TaskGroupId } from '@modules/care/web/lib/care-channels/tasks';
import { pushToast } from '@/lib/toasts';
import '@modules/care/web/styles/care.css';
import '@modules/care/web/styles/care-channels.css';

const MAX_PAGES = 3;

function dueText(t: CareTaskDto, group: TaskGroupId, now: number): string {
  if (group === 'today') return cc('tasks.dueToday', { time: vnTime(t.dueAtMs) });
  if (group === 'overdue') return cc('tasks.dueOverdue', { date: vnDate(t.dueAtMs), time: vnTime(t.dueAtMs) });
  if (group === 'upcoming' && dayDistance(t.dueAtMs, now) === 1) return cc('tasks.dueTomorrow', { time: vnTime(t.dueAtMs) });
  return cc('tasks.dueOn', { date: vnDate(t.dueAtMs), time: vnTime(t.dueAtMs) });
}

/** /care/tasks: Quá hạn / Hôm nay / Sắp tới / Xong (Asia/Ho_Chi_Minh days); the checkbox PATCHes `done` with the task revision. */
export function CareTasks() {
  const [tasks, setTasks] = useState<CareTaskDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const all: CareTaskDto[] = [];
        let cursor: string | null = null;
        for (let i = 0; i < MAX_PAGES; i += 1) {
          const page: { items: CareTaskDto[]; nextCursor: string | null } = await channelsApi.tasks({ limit: 200, cursor });
          all.push(...page.items);
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        if (live) { setTasks(all); setError(null); setNow(Date.now()); }
      } catch (e) {
        if (live) setError(toCareFailure(e).message);
      }
    })();
    return () => { live = false; };
  }, [reload]);

  const groups = useMemo(() => groupTasks(tasks ?? [], now), [tasks, now]);

  async function toggle(t: CareTaskDto): Promise<void> {
    if (busy) return;
    setBusy(t.id);
    // optimistic: the row moves at once; a refusal reloads the truth
    setTasks((cur) => (cur ?? []).map((x) => (x.id === t.id ? { ...x, done: !t.done, updatedAtMs: Date.now() } : x)));
    try {
      const saved = await careApi.patchTask(t.id, { expectedRevision: t.revision, done: !t.done });
      setTasks((cur) => (cur ?? []).map((x) => (x.id === t.id ? { ...x, ...saved } : x)));
      setNow(Date.now());
    } catch (e) {
      const f = toCareFailure(e);
      pushToast({ tone: 'error', title: f.code === 'STALE_REVISION' ? ct('customer.taskStale') : ct('customer.taskFailed'), description: f.code === 'STALE_REVISION' ? undefined : f.message });
      setReload((n) => n + 1);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div class="care-page module-fill" data-testid="care-tasks">
      <PageHeader compact breadcrumb={cc('breadcrumb')} title={cc('tasks.title')} tabs={<CareTabs current="tasks" />} />
      <div class="care-scroll-page">
        <div class="cch-page">
          <p class="cch-intro">{cc('tasks.intro')}</p>
          {error && <PageState error={error} />}
          {!tasks && !error && <PageState loading />}
          {tasks && tasks.length === 0 && <PageState empty emptyTitle={cc('tasks.empty')} emptyDescription={cc('tasks.emptyHint')} />}
          {tasks && tasks.length > 0 && TASK_GROUP_ORDER.map((g) => {
            const list = groups[g];
            if (list.length === 0 && g !== 'today') return null;
            return (
              <section key={g} class={`cch-task-group is-${g}`} aria-labelledby={`cch-tg-${g}`} data-testid={`cch-tasks-${g}`}>
                <h2 id={`cch-tg-${g}`}>{cc(`tasks.group.${g}`)} <span class="cch-count">{list.length}</span></h2>
                {list.length === 0 ? <p class="cch-note">{cc('tasks.todayEmpty')}</p> : (
                  <ul class="cch-task-list">
                    {list.map((t) => (
                      <li key={t.id} class={`cch-task${t.done ? ' is-done' : ''}`} data-testid="cch-task" data-task-id={t.id}>
                        <input type="checkbox" id={`cch-task-${t.id}`} checked={t.done} disabled={busy === t.id} onChange={() => void toggle(t)} />
                        <div class="cch-task-main">
                          <label for={`cch-task-${t.id}`}>{t.title}</label>
                          <span class={`cch-due${g === 'overdue' || isLate(t, now) ? ' is-late' : g === 'today' ? ' is-today' : ''}`}>{t.done ? cc('tasks.doneAt', { date: vnDate(t.updatedAtMs), time: vnTime(t.updatedAtMs) }) : dueText(t, g, now)}</span>
                        </div>
                        {t.conversationId && <Link href={`/m/care/inbox/${encodeURIComponent(t.conversationId)}`}>{cc('tasks.openConversation')}</Link>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
