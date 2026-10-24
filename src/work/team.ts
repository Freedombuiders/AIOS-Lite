import type { Logger } from '../core/log.js';
import type { Task } from '../core/types.js';
import type { AgentRegistry } from '../agents/contracts.js';
import type { TaskService, TeamService, TeamTaskInput } from './contracts.js';
import { isTerminal } from './tasks.js';

interface RelayMeta {
  steps: string[];
  index: number;
}

export function createTeamService({ tasks, agents, log }: { tasks: TaskService; agents: AgentRegistry; log: Logger }): TeamService {
  const agentName = (id: string): string => agents.get(id)?.name ?? id;

  function createTeamTask(input: TeamTaskInput): Task {
    if (!input.agentIds.length) throw new Error('Cần chọn ít nhất một agent');
    if (new Set(input.agentIds).size !== input.agentIds.length) throw new Error('Danh sách agent bị trùng');
    for (const id of input.agentIds) if (!agents.get(id)) throw new Error(`Không tìm thấy agent "${id}"`);
    if (input.mergeBy && !agents.get(input.mergeBy)) throw new Error(`Không tìm thấy agent tổng hợp "${input.mergeBy}"`);
    if (input.mode === 'relay' && input.mergeBy) throw new Error('Chế độ relay không dùng agent tổng hợp');

    const source = input.source ?? 'user';
    const parent = tasks.create({
      prompt: input.prompt,
      ...(input.title ? { title: input.title } : {}),
      kind: 'team',
      status: 'waiting',
      agentId: input.mergeBy ?? input.agentIds[0]!,
      source,
      priority: input.priority ?? 0,
      meta: { mode: input.mode, agentIds: input.agentIds, mergeBy: input.mergeBy ?? null, round: 0 },
    });
    const child = (agentId: string, prompt: string, meta: Record<string, unknown>) =>
      tasks.create({ parentId: parent.id, agentId, prompt, title: `${parent.title} · ${agentName(agentId)}`, source, priority: parent.priority, meta });

    if (input.mode === 'parallel') {
      for (const id of input.agentIds) child(id, input.prompt, { team: true });
      return tasks.require(parent.id);
    }
    child(input.agentIds[0]!, input.prompt, { team: true, relayIndex: 0 });
    return tasks.update(parent.id, { meta: { ...parent.meta, relay: { steps: input.agentIds, index: 0 } satisfies RelayMeta } });
  }

  function section(c: Task): string {
    const body = c.status === 'done' || c.status === 'review' ? c.result ?? '' : `(không hoàn thành: ${c.error ?? c.status})`;
    return `### ${agentName(c.agentId)}\n${body}`;
  }

  function onTaskFinished(child: Task): void {
    const cur = tasks.get(child.id) ?? child;
    if (!isTerminal(cur.status) || cur.parentId == null) return;
    const parent = tasks.get(cur.parentId);
    if (!parent || parent.status !== 'waiting') return;

    const siblings = tasks.children(parent.id);
    const mode = parent.kind === 'team' ? (parent.meta.mode as string | undefined) : undefined;

    if (mode === 'relay') {
      const relay = parent.meta.relay as RelayMeta | undefined;
      if (!relay || cur.meta.relayIndex !== relay.index) return;
      if (cur.status !== 'done') {
        const why = cur.error ?? (cur.status === 'cancelled' ? 'đã huỷ' : 'thất bại');
        const failed = tasks.update(parent.id, { status: 'failed', error: `Bước ${relay.index + 1} (${agentName(cur.agentId)}) thất bại: ${why}`, meta: { ...parent.meta, errorFamily: 'unknown' } });
        log.info({ taskId: parent.id }, 'relay failed');
        return onTaskFinished(failed);
      }
      const next = relay.index + 1;
      if (next < relay.steps.length) {
        const agentId = relay.steps[next]!;
        const prompt = `${parent.prompt}\n\n## Kết quả bước trước (${agentName(cur.agentId)})\n${cur.result ?? ''}`;
        tasks.update(parent.id, { meta: { ...parent.meta, relay: { steps: relay.steps, index: next } } });
        tasks.create({ parentId: parent.id, agentId, prompt, title: `${parent.title} · ${agentName(agentId)}`, source: parent.source, priority: parent.priority, meta: { team: true, relayIndex: next } });
        return;
      }
      const done = tasks.update(parent.id, { status: 'done', result: cur.result ?? '', error: null });
      return onTaskFinished(done);
    }

    // parallel team or delegation: wait for the children that the parent waits on
    const waited = siblings.filter((c) => c.meta.wait !== false);
    if (!waited.every((c) => isTerminal(c.status))) return;

    if (parent.kind === 'team' && !parent.meta.mergeBy) {
      const ok = siblings.some((c) => c.status === 'done');
      const out = tasks.update(parent.id, {
        status: ok ? 'done' : 'failed',
        result: siblings.map(section).join('\n\n'),
        error: ok ? null : 'Tất cả agent đều không hoàn thành',
      });
      return onTaskFinished(out);
    }
    tasks.update(parent.id, { status: 'queued', trigger: 'children_done', error: null });
  }

  return { createTeamTask, onTaskFinished };
}
