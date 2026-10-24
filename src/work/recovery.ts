import type { AppDeps } from '../core/deps.js';

/** Tasks left 'running' by a previous process: re-queue once, then fail and raise attention. */
export function recoverOnBoot(deps: Pick<AppDeps, 'runs' | 'tasks' | 'attention' | 'log'>): { requeued: number; failed: number } {
  deps.runs.failOrphans('Bị ngắt khi khởi động lại');
  let requeued = 0;
  let failed = 0;
  for (const t of deps.tasks.list({ status: 'running', limit: 500 })) {
    if (t.recoverCount < 1) {
      deps.tasks.update(t.id, { status: 'queued', recoverCount: t.recoverCount + 1 });
      requeued++;
    } else {
      deps.tasks.update(t.id, { status: 'failed', error: 'Bị ngắt nhiều lần khi khởi động lại' });
      deps.attention.raise({
        key: `task:${t.id}:recover`, kind: 'failed', title: `Việc thất bại: ${t.title}`, detail: 'Bị ngắt nhiều lần khi khởi động lại',
        taskId: t.id, link: `/tasks/${t.id}`, severity: 'error',
      });
      failed++;
    }
  }
  if (requeued || failed) deps.log.warn({ requeued, failed }, 'boot recovery');
  return { requeued, failed };
}
