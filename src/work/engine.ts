import fs from 'node:fs';
import { camelRow, nowIso } from '../core/db.js';
import type { AppDeps } from '../core/deps.js';
import type { AgentConfig, Conversation, ErrorFamily, Message, Run, Task } from '../core/types.js';
import type { ChildResult } from '../shared/contracts.js';
import type { Engine } from './contracts.js';
import { budgetKey } from './attention.js';
import { parseDirectives, validateDirectives, type Directive } from './directives.js';

const FAMILY_MESSAGE: Record<ErrorFamily, string> = {
  auth: 'Runtime chưa đăng nhập hoặc khoá không hợp lệ',
  quota: 'Đã hết hạn mức của runtime',
  transient: 'Lỗi tạm thời từ runtime, hãy thử lại',
  config: 'Cấu hình chưa đúng',
  refusal: 'Runtime từ chối thực hiện yêu cầu',
  timeout: 'Hết thời gian chạy',
  budget: 'Đã hết ngân sách tháng của agent',
  access: 'Không đủ quyền để chạy',
  cancelled: 'Đã huỷ',
  unknown: 'Lỗi không xác định',
};
const ATTENTION_FAMILIES: ErrorFamily[] = ['auth', 'quota', 'config'];
const HISTORY_LIMIT = 20;

export function createEngine(deps: AppDeps): Engine {
  const { db, bus, log } = deps;

  const summarize = (text: string, n = 200): string => (text.length > n ? text.slice(0, n - 1) + '…' : text);

  async function finalize(taskId: number, run: Run | null): Promise<void> {
    const task = deps.tasks.get(taskId);
    if (!task) return;
    if (task.status !== 'waiting') {
      try {
        deps.team.onTaskFinished(task);
      } catch (err) {
        log.error({ err, taskId }, 'team.onTaskFinished failed');
      }
    }
    if (task.status === 'waiting') return;
    for (const hook of [...deps.hooks.taskFinished]) {
      try {
        await hook(task, run);
      } catch (err) {
        log.error({ err, taskId }, 'taskFinished hook failed');
      }
    }
  }

  function failTask(task: Task, family: ErrorFamily, message: string): void {
    deps.tasks.update(task.id, { status: 'failed', error: message, meta: { ...task.meta, errorFamily: family } });
    deps.board.add({ agentId: task.agentId, taskId: task.id, kind: 'error', text: summarize(`Thất bại: ${message}`) });
    if (ATTENTION_FAMILIES.includes(family)) {
      deps.attention.raise({
        key: `task:${task.id}:${family}`,
        kind: 'failed',
        title: `Việc thất bại: ${task.title}`,
        detail: message,
        taskId: task.id,
        link: `/tasks/${task.id}`,
        severity: 'error',
      });
    }
    appendChatNote(task, `Lỗi: ${message}`, 'system');
  }

  function appendChatNote(task: Task, content: string, role: Message['role']): void {
    if (!task.conversationId || !content.trim()) return;
    const ts = nowIso();
    const info = db.prepare('INSERT INTO messages (conversation_id, role, content, task_id, created_at) VALUES (?,?,?,?,?)').run(task.conversationId, role, content, task.id, ts);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(ts, task.conversationId);
    const message = camelRow<Message>(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid) as Record<string, unknown>)!;
    bus.emit({ type: 'message', message });
  }

  function childResults(task: Task): ChildResult[] {
    return deps.tasks.children(task.id).map((c) => ({ taskId: c.id, agentId: c.agentId, status: c.status, result: c.result, error: c.error }));
  }

  const AGENT_CONTEXT_MAX = 3000;

  async function moduleContext(task: Task, agent: AgentConfig, moduleScopes: Record<string, string[]>): Promise<string | undefined> {
    const parts: string[] = [];
    for (const [moduleId, scopes] of Object.entries(moduleScopes)) {
      const provide = deps.hooks.agentContext?.get(moduleId);
      if (!provide || !scopes.length) continue;
      try {
        const s = await provide(agent, task, scopes);
        if (s?.trim()) parts.push(`### Module ${moduleId}\n${summarize(s.trim(), AGENT_CONTEXT_MAX)}`);
      } catch (err) {
        log.error({ err, taskId: task.id, moduleId }, 'agentContext provider failed');
      }
    }
    if (!task.source.startsWith('module:')) return parts.length ? parts.join('\n\n') : undefined;
    const provider = deps.hooks.moduleContext.get(task.source.slice('module:'.length));
    if (provider) {
      try {
        const s = await provider(task);
        if (s) parts.push(s);
      } catch (err) {
        log.error({ err, taskId: task.id }, 'moduleContext provider failed');
      }
    }
    if (typeof task.meta.moduleContext === 'string' && task.meta.moduleContext) parts.push(task.meta.moduleContext);
    return parts.length ? parts.join('\n\n') : undefined;
  }

  async function runAction(agent: AgentConfig, task: Task, run: Run, d: Extract<Directive, { kind: 'action' }>): Promise<void> {
    const action = deps.hooks.moduleActions?.get(`${d.module}:${d.name}`);
    const label = `${d.module}/${d.name}`;
    let body: string;
    try {
      const out = await action!.run(d.payload, { agentId: agent.id, taskId: task.id, runId: run.id });
      const detail = out === undefined ? '' : summarize(typeof out === 'string' ? out : JSON.stringify(out), 300);
      body = `Hành động ${label}: thành công${detail ? ` — ${detail}` : ''}`;
      deps.audit.log({ actor: `agent:${agent.id}`, action: 'module.action', target: label, runId: run.id, detail: { taskId: task.id, ok: true } });
    } catch (err) {
      body = `Hành động ${label}: lỗi — ${summarize((err as Error).message ?? String(err), 300)}`;
      deps.audit.log({ actor: `agent:${agent.id}`, action: 'module.action', target: label, runId: run.id, detail: { taskId: task.id, ok: false, error: (err as Error).message } });
    }
    deps.comments.add(task.id, 'system', body, { runId: run.id, requeue: false });
    deps.board.add({ agentId: agent.id, taskId: task.id, kind: 'action', text: summarize(body) });
  }

  async function applyDirectives(agent: AgentConfig, task: Task, run: Run, directives: Directive[], access: { memory: { team: boolean }; moduleScopes: Record<string, string[]> }) {
    const lean = task.contextProfile === 'lean';
    const usable = lean ? directives.filter((d) => d.kind === 'status') : directives;
    const { accepted, rejected } = validateDirectives(usable, {
      agent, task, agents: deps.agents, config: deps.config, teamMemory: access.memory.team,
      actionScope: (module, name) => deps.hooks.moduleActions?.get(`${module}:${name}`)?.scope,
      canModule: (module, scope) => {
        const granted = access.moduleScopes[module] ?? [];
        return granted.includes(scope) || granted.includes('*');
      },
    });
    const children: Task[] = [];
    let review = false;
    for (const d of accepted) {
      if (d.kind === 'status') review = true;
      else if (d.kind === 'action') await runAction(agent, task, run, d);
      else if (d.kind === 'memory') {
        deps.memory.add({ content: d.text, agentId: d.scope === 'team' ? null : agent.id, source: `agent:${agent.id}`, sourceTaskId: task.id, sourceRunId: run.id });
      } else {
        children.push(
          deps.tasks.create({
            parentId: task.id,
            agentId: d.to,
            prompt: d.body,
            ...(d.title ? { title: d.title } : {}),
            priority: task.priority,
            source: `agent:${agent.id}`,
            trigger: 'assigned',
            meta: { wait: d.wait },
          }),
        );
      }
    }
    const ignored = lean ? directives.filter((d) => d.kind !== 'status').length : 0;
    for (const r of rejected) {
      deps.board.add({ agentId: agent.id, taskId: task.id, kind: 'directive', text: summarize(`Chỉ thị bị từ chối (${r.directive.kind}): ${r.reason}`) });
      deps.audit.log({ actor: `agent:${agent.id}`, action: 'directive.rejected', target: `task:${task.id}`, runId: run.id, detail: { kind: r.directive.kind, reason: r.reason } });
    }
    if (ignored) {
      deps.audit.log({ actor: `agent:${agent.id}`, action: 'directive.ignored', target: `task:${task.id}`, runId: run.id, detail: { count: ignored, reason: 'lean' } });
    }
    return { children, review };
  }

  async function execute(task: Task, signal: AbortSignal): Promise<void> {
    let run: Run | null = null;
    try {
      // 1) agent + budget
      const agent = deps.agents.get(task.agentId);
      if (!agent || !agent.enabled) {
        failTask(task, 'config', agent ? `Agent "${agent.name}" đang tắt` : `Không tìm thấy agent "${task.agentId}"`);
        return await finalize(task.id, null);
      }
      if (agent.budgetUsdMonth && deps.runs.monthCost(agent.id) >= agent.budgetUsdMonth) {
        failTask(task, 'budget', `${FAMILY_MESSAGE.budget} ($${agent.budgetUsdMonth})`);
        deps.attention.raise({
          key: budgetKey(agent.id), kind: 'budget', title: `${agent.name} đã dùng hết ngân sách tháng`, detail: `Ngân sách $${agent.budgetUsdMonth}`,
          link: `/agents/${agent.id}`, severity: 'warn',
        });
        return await finalize(task.id, null);
      }

      // 2) access
      const access = deps.access.resolve(agent, task);
      fs.mkdirSync(agent.workspace, { recursive: true });
      if (agent.runtime === 'claude' || agent.runtime === 'grok') deps.skills.linkIntoWorkspace(agent.workspace, access.skills);

      // 3) context inputs
      const conv = task.conversationId
        ? camelRow<Conversation>(db.prepare('SELECT * FROM conversations WHERE id = ?').get(task.conversationId) as Record<string, unknown> | undefined)
        : undefined;
      const lastRun = deps.runs.list({ taskId: task.id, limit: 1 })[0];
      const comments = lastRun ? deps.comments.since(task.id, lastRun.startedAt) : [];
      const modCtx = await moduleContext(task, agent, access.moduleScopes);
      const images = Array.isArray(task.meta.images) ? (task.meta.images as unknown[]).filter((x): x is string => typeof x === 'string') : undefined;

      // 4) runtime + prompt
      const runtime = deps.runtimes.get(agent.runtime);
      const resuming = !!(conv && runtime.capabilities.resume && conv.sessionRuntime === agent.runtime && conv.sessionId);
      let history: Message[] | undefined;
      if (conv && !resuming) {
        const cur = db.prepare('SELECT MAX(id) AS id FROM messages WHERE task_id = ? AND role = ?').get(task.id, 'user') as { id: number | null };
        const rows = db
          .prepare("SELECT * FROM messages WHERE conversation_id = ? AND role IN ('user','agent') AND id < ? ORDER BY id DESC LIMIT ?")
          .all(conv.id, cur.id ?? Number.MAX_SAFE_INTEGER, HISTORY_LIMIT) as Record<string, unknown>[];
        history = rows.reverse().map((r) => camelRow<Message>(r)!);
      }
      const built = deps.context.build({
        agent, task, access, profile: task.contextProfile,
        ...(modCtx ? { moduleContext: modCtx } : {}),
        ...(task.trigger === 'children_done' ? { childResults: childResults(task) } : {}),
        ...(comments.length ? { comments } : {}),
        ...(history ? { history } : {}),
        resuming,
      });

      // 5) run
      run = deps.runs.start({
        taskId: task.id, agentId: agent.id, runtime: agent.runtime, model: agent.model ?? null, trigger: task.trigger,
        accessJson: JSON.stringify(deps.access.snapshot(access)), skillsJson: JSON.stringify(built.skillIds),
      });
      deps.audit.log({ actor: `agent:${agent.id}`, action: 'run.start', target: `task:${task.id}`, runId: run.id });
      const runId = run.id;
      const result = await runtime.run({
        agent, access, prompt: built.prompt, systemPrompt: built.systemPrompt, cwd: agent.workspace,
        ...(resuming && conv?.sessionId ? { sessionId: conv.sessionId } : {}),
        tools: access.tools, ...(images?.length ? { images } : {}), signal, timeoutMs: deps.config.runTimeoutMs,
        onEvent: (e) => deps.runs.addEvent(runId, task.id, e),
      });

      if (conv && result.clearSession) db.prepare('UPDATE conversations SET session_id = NULL, session_runtime = NULL WHERE id = ?').run(conv.id);

      const latest = deps.tasks.get(task.id);
      const cancelled = signal.aborted || latest?.status === 'cancelled' || (!result.ok && result.error?.family === 'cancelled');

      // 6) failure / cancel
      if (cancelled) {
        run = deps.runs.finish(run.id, { status: 'cancelled', output: result.output || null, errorFamily: 'cancelled', error: FAMILY_MESSAGE.cancelled, usage: result.usage ?? {} });
        if (latest?.status !== 'cancelled') deps.tasks.update(task.id, { status: 'cancelled', error: null });
        return await finalize(task.id, run);
      }
      if (!result.ok) {
        const family = result.error?.family ?? 'unknown';
        const detail = result.error?.message ?? '';
        const message = `${FAMILY_MESSAGE[family]}${detail ? `: ${detail}` : ''}`;
        run = deps.runs.finish(run.id, { status: 'failed', output: result.output || null, errorFamily: family, error: message, usage: result.usage ?? {}, ...(result.sessionId ? { sessionId: result.sessionId } : {}) });
        failTask(task, family, message);
        return await finalize(task.id, run);
      }

      // 7) directives
      const parsed = parseDirectives(result.output);
      run = deps.runs.finish(run.id, { status: 'done', output: parsed.cleanOutput, sessionId: result.sessionId ?? null, usage: result.usage ?? {}, ...(result.model ? { model: result.model } : {}) });
      if (parsed.malformed.length) {
        deps.board.add({ agentId: agent.id, taskId: task.id, kind: 'directive', text: summarize(`Có ${parsed.malformed.length} chỉ thị sai cú pháp, đã bỏ qua`) });
      }
      const { children, review } = await applyDirectives(agent, task, run, parsed.directives, access);
      deps.board.add({ agentId: agent.id, taskId: task.id, kind: 'run', text: summarize(parsed.cleanOutput || '(không có nội dung)') });

      // 8) task + chat state
      const waits = children.some((c) => c.meta.wait !== false);
      const status = waits ? 'waiting' : review ? 'review' : 'done';
      const meta = { ...(deps.tasks.get(task.id)?.meta ?? task.meta) };
      if (task.trigger === 'children_done') meta.round = (Number(meta.round ?? 0) || 0) + 1;
      deps.tasks.update(task.id, { status, result: parsed.cleanOutput, error: null, meta });
      if (conv) {
        appendChatNote(task, parsed.cleanOutput, 'agent');
        if (result.sessionId && runtime.capabilities.resume && !result.clearSession) {
          db.prepare('UPDATE conversations SET session_id = ?, session_runtime = ? WHERE id = ?').run(result.sessionId, agent.runtime, conv.id);
        }
      }
      // 9) hooks
      await finalize(task.id, run);
    } catch (err) {
      log.error({ err, taskId: task.id }, 'engine.execute failed');
      const message = `Lỗi nội bộ: ${(err as Error).message}`;
      if (run && deps.runs.get(run.id)?.status === 'running') run = deps.runs.finish(run.id, { status: 'failed', errorFamily: 'unknown', error: message });
      const cur = deps.tasks.get(task.id);
      if (cur && cur.status === 'running') failTask(cur, 'unknown', message);
      await finalize(task.id, run);
    }
  }

  return { execute };
}
