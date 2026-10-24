import { Clock, Plus } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { careApi } from '@modules/care/web/lib/care/client';
import type { CustomerTask } from '@modules/care/web/lib/care/customer/model';
import { toCareFailure } from '@modules/care/web/lib/care/failure';
import { ct } from '@modules/care/web/lib/care/i18n';
import { pushToast } from '@/lib/toasts';

/** Tasks are saved one by one with their own revision (not part of the form's dirty state). */
export function CustomerTasks({ customerId, conversationId, tasks, readOnly, onChanged }: {
  customerId: string;
  conversationId: string | null;
  tasks: CustomerTask[];
  readOnly: boolean;
  onChanged: () => void;
}) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const now = Date.now();
  const sorted = [...tasks].sort((a, b) => Number(a.done) - Number(b.done) || a.dueAtMs - b.dueAtMs);

  async function run(key: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      const f = toCareFailure(e);
      pushToast({ tone: 'error', title: f.code === 'STALE_REVISION' ? ct('customer.taskStale') : ct('customer.taskFailed'), description: f.code === 'STALE_REVISION' ? undefined : f.message });
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  const dueMs = due ? new Date(due).getTime() : NaN;
  const canAdd = !readOnly && title.trim().length > 0 && Number.isFinite(dueMs) && dueMs > 0;

  return (
    <section class="care-tasks" aria-label={ct('customer.tasks')}>
      <h3 class="care-subtitle">{ct('customer.tasks')} <span class="care-chip">{tasks.filter((t) => !t.done).length}</span></h3>
      {sorted.length === 0 && <p class="care-faint">{ct('customer.noTasks')}</p>}
      <ul class="care-task-list">
        {sorted.map((t) => {
          const overdue = !t.done && t.dueAtMs < now;
          return (
            <li key={t.id} class={`cc-task${overdue ? ' is-overdue' : ''}`} data-testid="care-task">
              <label>
                <input type="checkbox" checked={t.done} disabled={readOnly || busy === t.id} aria-label={ct('customer.taskDone', { title: t.title })} onChange={() => void run(t.id, () => careApi.patchTask(t.id, { expectedRevision: t.revision, done: !t.done }))} />
                <span class={t.done ? 'is-done' : ''}>{t.title}</span>
              </label>
              <span class="care-faint"><Clock size={10} aria-hidden="true" /> {overdue ? `${ct('customer.overdue')} · ` : ''}{new Date(t.dueAtMs).toLocaleString('vi-VN')}</span>
            </li>
          );
        })}
      </ul>
      {!readOnly && (
        <form class="care-task-add" onSubmit={(e) => { e.preventDefault(); if (canAdd) void run('new', async () => { await careApi.createTask({ customerId, conversationId, title: title.trim(), dueAtMs: dueMs }); setTitle(''); setDue(''); }); }}>
          <input type="text" aria-label={ct('customer.taskTitle')} placeholder={ct('customer.taskTitle')} value={title} maxLength={300} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} data-testid="care-task-title" />
          <input type="datetime-local" aria-label={ct('customer.taskDue')} value={due} onInput={(e) => setDue((e.target as HTMLInputElement).value)} data-testid="care-task-due" />
          <button type="submit" class="cc-button" disabled={!canAdd || busy === 'new'} data-testid="care-task-add"><Plus size={12} aria-hidden="true" /> {ct('customer.addTask')}</button>
        </form>
      )}
    </section>
  );
}
