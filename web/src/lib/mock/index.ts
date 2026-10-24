// In-memory fake of docs/dev/API.md for reviewing the UI without the backend.
// Enabled by VITE_MOCK=1 or ?mock=1 (remembered for the tab session).
import type { Memory, Message, Schedule, Task, TaskStatus } from '@core/types';
import type { AppEvent } from '../events';
import { ApiError } from '../errors';
import type { SkillRootView } from '../api-types';
import * as d from './data';
import { costRoutes } from './costs';
import { teamsMockRoutes, TeamsMockError } from './teams';
import * as ig from './integrations';

export function mockEnabled(): boolean {
  try {
    if (import.meta.env?.VITE_MOCK === '1') return true;
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('mock') === '1') {
      sessionStorage.setItem('aios.mock', '1');
      return true;
    }
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem('aios.mock') === '1';
  } catch {
    return false;
  }
}

let emit: (e: AppEvent) => void = () => undefined;
export function mockSubscribe(dispatch: (e: AppEvent) => void): void {
  emit = dispatch;
}

class MockError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const num = (s: string) => Number(s);

function taskStats(): Record<TaskStatus, number> {
  const c: Record<TaskStatus, number> = { queued: 0, running: 0, waiting: 0, review: 0, done: 0, failed: 0, cancelled: 0 };
  for (const t of d.tasks) c[t.status]++;
  return c;
}

function patchTask(t: Task, patch: Partial<Task>): Task {
  Object.assign(t, patch, { updatedAt: d.NOW() });
  emit({ type: 'task', task: clone(t) });
  return t;
}

/** Pretend an agent works on the task and streams text. */
function simulate(t: Task): void {
  const run = {
    id: d.nextId(d.runs), taskId: t.id, agentId: t.agentId, runtime: d.agents.find((a) => a.id === t.agentId)?.runtime ?? 'mock', model: null, status: 'running' as const,
    trigger: t.trigger, sessionId: null, output: null, errorFamily: null, error: null, inputTokens: null, outputTokens: null, costUsd: null, accessJson: '1', skillsJson: '[]',
    startedAt: d.NOW(), finishedAt: null, durationMs: null,
  };
  const chunks = ['Đã nhận việc. ', 'Đang đọc ngữ cảnh liên quan… ', 'Soạn kết quả: ', 'đây là bản nháp ngắn gọn cho yêu cầu của bạn.'];
  setTimeout(() => {
    d.runs.push(run);
    patchTask(t, { status: 'running', startedAt: d.NOW() });
    emit({ type: 'run', run: clone(run) });
    chunks.forEach((text, i) =>
      setTimeout(() => {
        d.runEvents.push({ id: d.nextId(d.runEvents), runId: run.id, ts: d.NOW(), event: { type: 'text', text } });
        emit({ type: 'run-event', runId: run.id, taskId: t.id, event: { type: 'text', text } });
      }, 600 * (i + 1)),
    );
    setTimeout(() => {
      const output = chunks.join('');
      Object.assign(run, { status: 'done', output, finishedAt: d.NOW(), durationMs: 2600, inputTokens: 1200, outputTokens: 90 });
      emit({ type: 'run', run: clone(run) });
      if (t.conversationId) {
        const m: Message = { id: d.nextId(d.messages), conversationId: t.conversationId, role: 'agent', content: output, taskId: t.id, createdAt: d.NOW() };
        d.messages.push(m);
        emit({ type: 'message', message: clone(m) });
        patchTask(t, { status: 'done', result: output, finishedAt: d.NOW() });
      } else patchTask(t, { status: 'review', result: output, finishedAt: d.NOW() });
    }, 600 * (chunks.length + 1) + 200);
  }, 700);
}

function createTask(body: Partial<Task> & { prompt: string }): Task {
  const t: Task = {
    id: d.nextId(d.tasks), title: body.title || body.prompt.slice(0, 80), prompt: body.prompt, agentId: body.agentId || 'main', status: 'queued', kind: body.kind ?? 'task',
    priority: body.priority ?? 5, parentId: body.parentId ?? null, conversationId: body.conversationId ?? null, source: 'user', trigger: body.trigger ?? 'assigned',
    contextProfile: body.contextProfile ?? 'standard', depth: 0, runAfter: null, result: null, error: null, recoverCount: 0, meta: body.meta ?? {},
    createdAt: d.NOW(), updatedAt: d.NOW(), startedAt: null, finishedAt: null,
  };
  d.tasks.unshift(t);
  emit({ type: 'task', task: clone(t) });
  if (t.kind !== 'team') simulate(t);
  return t;
}

function agentSummary(a: (typeof d.agents)[number]) {
  const { persona: _p, ...rest } = a;
  void _p;
  return rest;
}

type Route = (params: string[], q: URLSearchParams, body: any) => unknown;
const routes: [string, RegExp, Route][] = [];
const on = (method: string, pattern: string, fn: Route) =>
  routes.push([method, new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, '([^/]+)')}$`), fn]);

on('GET', '/health', () => ({ ok: true, version: '0.1.0-mock', uptimeSec: 1234 }));
on('GET', '/runtimes', (_p, q) => ({ items: q.get('probe') ? d.runtimes.map((r) => ({ ...r, testedAt: d.NOW() })) : d.runtimes }));
on('GET', '/stats', () => ({
  agents: { total: d.agents.length, enabled: d.agents.filter((a) => a.enabled).length, running: d.tasks.filter((t) => t.status === 'running').length },
  tasks: taskStats(), runsToday: 6, costMonthUsd: d.agents.reduce((s, a) => s + a.stats.costMonthUsd, 0),
  costByAgent: d.agents.filter((a) => a.stats.costMonthUsd > 0).map((a) => ({ agentId: a.id, costUsd: a.stats.costMonthUsd, runs: a.stats.runsMonth })), recentRuns: [...d.runs].reverse().slice(0, 6),
}));
on('GET', '/attention', () => ({ items: d.attention }));
on('POST', '/attention/:key/resolve', ([key]) => {
  const i = d.attention.findIndex((a) => a.key === decodeURIComponent(key!));
  if (i >= 0) emit({ type: 'attention', item: d.attention.splice(i, 1)[0]!, resolved: true });
  return { ok: true };
});
let settings = { timezone: 'Asia/Ho_Chi_Minh', maxParallel: 3, emergencyStop: false, version: '0.1.0-mock' };
on('GET', '/settings', () => settings);
on('PUT', '/settings', (_p, _q, b) => (settings = { ...settings, ...b }));

on('GET', '/agents', () => ({ items: d.agents.map(agentSummary), errors: [{ id: 'cu-chi', file: 'agents/cu-chi/agent.yaml', message: 'runtime: giá trị "gpt" không hợp lệ' }] }));
on('GET', '/agents/:id', ([id]) => {
  const a = d.agents.find((x) => x.id === id);
  if (!a) throw new MockError(404, 'not_found', 'Không tìm thấy agent');
  return a;
});
on('GET', '/agents/:id/access', ([id]) => {
  const a = d.agents.find((x) => x.id === id);
  if (!a) throw new MockError(404, 'not_found', 'Không tìm thấy agent');
  const rt = d.runtimes.find((r) => r.runtime === a.runtime)!;
  return { access: d.accessSnapshot(a.id), enforcement: rt.capabilities.enforces, runtime: a.runtime };
});
on('POST', '/agents', (_p, _q, b) => {
  if (d.agents.some((a) => a.id === b.id)) throw new MockError(409, 'conflict', 'Mã agent đã tồn tại');
  const a = { description: '', runtimeOptions: {}, permission: 'safe', context: 'standard', canDelegate: false, maxConcurrent: 1, enabled: true, access: { brain: {}, memory: { team: true, private: true }, skills: [], connections: {}, modules: {} }, persona: '', dir: `/agents/${b.id}`, workspace: `/workspaces/${b.id}`, stats: { running: 0, queued: 0, lastRunAt: null, costMonthUsd: 0, runsMonth: 0 }, ...b };
  d.agents.push(a);
  return a;
});
on('PUT', '/agents/:id', ([id], _q, b) => {
  const a = d.agents.find((x) => x.id === id);
  if (!a) throw new MockError(404, 'not_found', 'Không tìm thấy agent');
  Object.assign(a, b);
  return a;
});
on('DELETE', '/agents/:id', ([id]) => {
  const i = d.agents.findIndex((x) => x.id === id);
  if (i >= 0) d.agents.splice(i, 1);
  return { ok: true };
});
on('POST', '/agents/reload', () => ({ items: d.agents.map(agentSummary), errors: [] }));

on('GET', '/connections', () => ({ items: d.connections }));
on('POST', '/connections/:id/test', ([id]) => (id === 'web-search' ? { ok: true, message: 'Kết nối được, 12 công cụ.' } : { ok: false, message: 'Thiếu khoá: hãy nhập khoá API.' }));
on('PUT', '/connections/composio-key', () => {
  const c = d.connections.find((x) => x.id === 'composio');
  if (c) c.ready = true;
  return { ok: true };
});

on('GET', '/tasks/counts', () => taskStats());
on('GET', '/tasks', (_p, q) => {
  const status = q.get('status')?.split(',');
  const src = q.get('source');
  const qq = q.get('q')?.toLowerCase();
  let items = d.tasks.filter((t) => (!status || status.includes(t.status)) && (!q.get('agentId') || t.agentId === q.get('agentId')) && (!q.get('kind') || t.kind === q.get('kind')));
  if (src) items = items.filter((t) => (src.endsWith('*') ? t.source.startsWith(src.slice(0, -1)) : t.source === src));
  if (q.get('parentId')) items = items.filter((t) => String(t.parentId) === q.get('parentId'));
  if (qq) items = items.filter((t) => t.title.toLowerCase().includes(qq));
  return { items };
});
on('POST', '/tasks', (_p, _q, b) => createTask(b));
on('POST', '/tasks/team', (_p, _q, b) => {
  const parent = createTask({ prompt: b.prompt, title: b.title || `Hỏi cả nhóm: ${b.prompt.slice(0, 60)}`, agentId: b.mergeBy || b.agentIds[0], kind: 'team', meta: { mode: b.mode, agentIds: b.agentIds, mergeBy: b.mergeBy } });
  patchTask(parent, { status: 'waiting' });
  (b.agentIds as string[]).forEach((id, i) => {
    const c = createTask({ prompt: b.prompt, agentId: id, parentId: parent.id });
    c.depth = 1;
    c.source = `agent:${b.mergeBy || b.agentIds[0]}`;
    void i;
  });
  return parent;
});
on('GET', '/tasks/:id', ([id]) => {
  const t = d.tasks.find((x) => x.id === num(id!));
  if (!t) throw new MockError(404, 'not_found', 'Không tìm thấy công việc');
  return { task: t, runs: d.runs.filter((r) => r.taskId === t.id), children: d.tasks.filter((c) => c.parentId === t.id), comments: d.comments.filter((c) => c.taskId === t.id), parent: d.tasks.find((p) => p.id === t.parentId) ?? null };
});
const act = (fn: (t: Task) => void): Route => ([id]) => {
  const t = d.tasks.find((x) => x.id === num(id!));
  if (!t) throw new MockError(404, 'not_found', 'Không tìm thấy công việc');
  fn(t);
  return t;
};
on('POST', '/tasks/:id/cancel', act((t) => patchTask(t, { status: 'cancelled', finishedAt: d.NOW() })));
on('POST', '/tasks/:id/approve', act((t) => patchTask(t, { status: 'done' })));
on('POST', '/tasks/:id/retry', act((t) => {
  patchTask(t, { status: 'queued', trigger: 'retry', error: null });
  simulate(t);
}));
on('GET', '/tasks/:id/comments', ([id]) => ({ items: d.comments.filter((c) => c.taskId === num(id!)) }));
on('POST', '/tasks/:id/comments', ([id], _q, b) => {
  const c = { id: d.nextId(d.comments), taskId: num(id!), author: 'user', body: b.body, runId: null, createdAt: d.NOW() };
  d.comments.push(c);
  const t = d.tasks.find((x) => x.id === c.taskId);
  if (t && b.requeue !== false && ['done', 'review', 'failed'].includes(t.status)) {
    patchTask(t, { status: 'queued', trigger: 'commented' });
    simulate(t);
  }
  return c;
});

on('GET', '/runs', (_p, q) => ({ items: d.runs.filter((r) => (!q.get('taskId') || r.taskId === num(q.get('taskId')!)) && (!q.get('agentId') || r.agentId === q.get('agentId'))).reverse() }));
on('GET', '/runs/:id', ([id]) => {
  const run = d.runs.find((r) => r.id === num(id!));
  if (!run) throw new MockError(404, 'not_found', 'Không tìm thấy lượt chạy');
  return { run, events: d.runEvents.filter((e) => e.runId === run.id), access: d.accessSnapshot(run.agentId) };
});

on('GET', '/schedules', () => ({ items: d.schedules }));
on('POST', '/schedules', (_p, _q, b) => {
  if (b.cron.trim().split(/\s+/).length !== 5) throw new MockError(400, 'bad_request', 'Biểu thức cron không hợp lệ');
  const s: Schedule = { id: d.nextId(d.schedules), enabled: true, timezone: 'Asia/Ho_Chi_Minh', lastRunAt: null, nextRunAt: null, lastTaskId: null, createdAt: d.NOW(), updatedAt: d.NOW(), ...b };
  d.schedules.push(s);
  return s;
});
on('PUT', '/schedules/:id', ([id], _q, b) => {
  const s = d.schedules.find((x) => x.id === num(id!));
  if (!s) throw new MockError(404, 'not_found', 'Không tìm thấy lịch');
  if (b.cron && b.cron.trim().split(/\s+/).length !== 5) throw new MockError(400, 'bad_request', 'Biểu thức cron không hợp lệ');
  Object.assign(s, b, { updatedAt: d.NOW() });
  return s;
});
on('DELETE', '/schedules/:id', ([id]) => {
  const i = d.schedules.findIndex((x) => x.id === num(id!));
  if (i >= 0) d.schedules.splice(i, 1);
  return { ok: true };
});
on('POST', '/schedules/:id/run', ([id]) => {
  const s = d.schedules.find((x) => x.id === num(id!));
  if (!s) throw new MockError(404, 'not_found', 'Không tìm thấy lịch');
  const t = createTask({ prompt: s.prompt, title: s.name, agentId: s.agentId, trigger: 'schedule' });
  t.source = `schedule:${s.id}`;
  Object.assign(s, { lastRunAt: d.NOW(), lastTaskId: t.id });
  return t;
});

on('GET', '/conversations', (_p, q) => ({ items: d.conversations.filter((c) => !q.get('agentId') || c.agentId === q.get('agentId')).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }));
on('POST', '/conversations', (_p, _q, b) => {
  const c = { id: d.nextId(d.conversations), agentId: b.agentId, title: b.title || 'Cuộc trò chuyện mới', sessionId: null, sessionRuntime: null, createdAt: d.NOW(), updatedAt: d.NOW() };
  d.conversations.push(c);
  return c;
});
on('GET', '/conversations/:id', ([id]) => {
  const c = d.conversations.find((x) => x.id === num(id!));
  if (!c) throw new MockError(404, 'not_found', 'Không tìm thấy cuộc trò chuyện');
  return { conversation: c, messages: d.messages.filter((m) => m.conversationId === c.id) };
});
on('PATCH', '/conversations/:id', ([id], _q, b) => {
  const c = d.conversations.find((x) => x.id === num(id!));
  if (!c) throw new MockError(404, 'not_found', 'Không tìm thấy cuộc trò chuyện');
  c.title = b.title;
  return c;
});
on('DELETE', '/conversations/:id', ([id]) => {
  const i = d.conversations.findIndex((x) => x.id === num(id!));
  if (i >= 0) d.conversations.splice(i, 1);
  return { ok: true };
});
on('POST', '/conversations/:id/messages', ([id], _q, b) => {
  const c = d.conversations.find((x) => x.id === num(id!))!;
  const m: Message = { id: d.nextId(d.messages), conversationId: c.id, role: 'user', content: b.content, taskId: null, createdAt: d.NOW() };
  d.messages.push(m);
  c.updatedAt = d.NOW();
  const task = createTask({ prompt: b.content, agentId: c.agentId, kind: 'chat', conversationId: c.id, trigger: 'chat' });
  return { message: m, task };
});

const brainView = () =>
  d.brainFolders.map((f) => ({
    ...f,
    isVault: f.isVault ?? false,
    mdCount: f.mdCount ?? f.docs,
    readers: d.agents.filter((a) => (a.access.brain[f.id]?.read.length ?? 0) > 0).map((a) => a.id),
    writers: d.agents.filter((a) => (a.access.brain[f.id]?.write.length ?? 0) > 0).map((a) => a.id),
  }));
on('GET', '/brain/folders', () => ({ items: brainView() }));
on('POST', '/brain/folders', (_p, _q, b) => {
  if (!b.name?.trim() || !b.path?.trim()) throw new MockError(400, 'bad_request', 'Cần nhập tên và đường dẫn.');
  if (d.brainFolders.some((f) => f.path === b.path)) throw new MockError(409, 'conflict', 'Thư mục này đã được thêm.');
  const base = foldAscii(b.name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'brain';
  let id = base;
  for (let i = 2; d.brainFolders.some((f) => f.id === id); i++) id = `${base}-${i}`;
  const f = { id, name: b.name.trim(), path: b.path.trim(), ...(b.description ? { description: b.description } : {}), docs: 3, exists: true, isVault: /obsidian/i.test(b.path), mdCount: 3 };
  d.brainFolders.push(f);
  return f;
});
on('PUT', '/brain/folders/:id', ([id], _q, b) => {
  const f = d.brainFolders.find((x) => x.id === id);
  if (!f) throw new MockError(404, 'not_found', 'Không tìm thấy Second Brain');
  Object.assign(f, b);
  return f;
});
on('DELETE', '/brain/folders/:id', ([id]) => {
  const i = d.brainFolders.findIndex((x) => x.id === id);
  if (i < 0) throw new MockError(404, 'not_found', 'Không tìm thấy Second Brain');
  d.brainFolders.splice(i, 1);
  const agentsUpdated: string[] = [];
  for (const a of d.agents) {
    if (id! in a.access.brain) {
      delete a.access.brain[id!];
      agentsUpdated.push(a.id);
    }
  }
  return { ok: true, agentsUpdated };
});
const FS: Record<string, { name: string; isVault?: boolean; hasSkills?: boolean }[]> = {
  '/Users/demo': [{ name: '.claude', hasSkills: true }, { name: 'Documents' }, { name: 'Obsidian', isVault: false }, { name: 'Projects' }],
  '/Users/demo/Documents': [{ name: 'CongTyA', isVault: true }, { name: 'CongTyB', isVault: true }, { name: 'Ghi-chu' }],
  '/Users/demo/Obsidian': [{ name: 'Ca-nhan', isVault: true }],
  '/Users/demo/Projects': [{ name: 'skills-cua-toi', hasSkills: true }],
  '/Users/demo/.claude': [{ name: 'skills', hasSkills: true }],
};
on('GET', '/fs/dirs', (_p, q) => {
  const raw = (q.get('path') ?? '').replace(/^~/, '/Users/demo') || '/Users/demo';
  const cur = raw.replace(/\/+$/, '') || '/Users/demo';
  if (!cur.startsWith('/Users/demo')) throw new MockError(400, 'bad_request', 'Chỉ được duyệt thư mục bên trong thư mục người dùng.');
  const dirs = (FS[cur] ?? []).map((e) => ({ name: e.name, path: `${cur}/${e.name}`, isVault: !!e.isVault, hasSkills: !!e.hasSkills }));
  return { path: cur, parent: cur === '/Users/demo' ? null : cur.slice(0, cur.lastIndexOf('/')), dirs };
});
on('GET', '/brain/tree', (_p, q) => ({ items: d.brainTree[q.get('folder') ?? ''] ?? [] }));
on('GET', '/brain/file', (_p, q) => {
  const content = d.brainFiles[`${q.get('folder')}:${q.get('path')}`];
  if (content === undefined) return { title: q.get('path'), content: `# ${q.get('path')}\n\n(Nội dung mẫu)`, mtimeMs: Date.now() };
  return { title: q.get('path'), content, mtimeMs: Date.now() };
});
const foldAscii = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase();
on('GET', '/brain/search', (_p, q) => {
  const needle = foldAscii(q.get('q') ?? '');
  const items = Object.entries(d.brainFiles)
    .filter(([, c]) => needle && foldAscii(c).includes(needle))
    .map(([k, c]) => {
      const [folderId, path] = k.split(':') as [string, string];
      const at = foldAscii(c).indexOf(needle);
      return { folderId, path, title: path.split('/').pop()!, snippet: c.slice(Math.max(0, at - 30), at + 80).replace(/\n/g, ' '), score: 1 };
    });
  return { items };
});
on('POST', '/brain/reindex', () => ({ indexed: 9, removed: 0, durationMs: 120 }));

on('GET', '/memory', (_p, q) => {
  const scope = q.get('scope') ?? 'all';
  const text = foldAscii(q.get('q') ?? '');
  return { items: d.memories.filter((m) => (scope === 'all' || (scope === 'team' ? m.agentId === null : m.agentId !== null)) && (!q.get('agentId') || m.agentId === q.get('agentId')) && (!text || foldAscii(m.content).includes(text))) };
});
on('POST', '/memory', (_p, _q, b) => {
  const m: Memory = { id: d.nextId(d.memories), agentId: b.agentId, content: b.content, source: 'user', sourceTaskId: null, sourceRunId: null, pinned: !!b.pinned, useCount: 0, lastUsedAt: null, createdAt: d.NOW() };
  d.memories.unshift(m);
  return m;
});
on('PATCH', '/memory/:id', ([id], _q, b) => {
  const m = d.memories.find((x) => x.id === num(id!));
  if (!m) throw new MockError(404, 'not_found', 'Không tìm thấy ghi nhớ');
  Object.assign(m, b);
  return m;
});
on('DELETE', '/memory/:id', ([id]) => {
  const i = d.memories.findIndex((x) => x.id === num(id!));
  if (i >= 0) d.memories.splice(i, 1);
  return { ok: true };
});

const skillViews = () =>
  d.skills.map((sk) => ({ ...sk, usedBy: d.agents.filter((a) => a.access.skills === 'all' || a.access.skills.includes(sk.id)).map((a) => a.id) }));
on('GET', '/skills', () => ({ items: skillViews() }));
const skillRoots: SkillRootView[] = [
  { path: '/Users/demo/aios/skills', label: 'Thư viện của AIOS', kind: 'env', readOnly: true, exists: true, skills: 2, clashes: [] as string[] },
  { path: '/Users/demo/aios/modules/care/skills', label: 'module:care', kind: 'module', readOnly: true, exists: true, skills: 1, clashes: [] as string[] },
];
on('GET', '/skills/roots', () => ({
  items: skillRoots,
  suggestions: [
    { path: '/Users/demo/.claude/skills', label: 'Claude Code (~/.claude/skills)', skills: 12 },
    { path: '/Users/demo/Documents/CongTyA/.claude/skills', label: 'Công ty A (.claude/skills)', skills: 4 },
  ].filter((sg) => !skillRoots.some((r) => r.path === sg.path)),
}));
on('POST', '/skills/roots', (_p, _q, b) => {
  if (skillRoots.some((r) => r.path === b.path)) throw new MockError(409, 'conflict', 'Nguồn skill này đã có trong danh sách.');
  const r: SkillRootView = { path: b.path as string, label: (b.label as string) || b.path.split('/').pop(), kind: 'user', readOnly: false, exists: true, skills: 3, clashes: [] as string[] };
  skillRoots.push(r);
  return r;
});
on('DELETE', '/skills/roots', (_p, _q, b) => {
  const i = skillRoots.findIndex((r) => r.path === b.path && !r.readOnly);
  if (i < 0) throw new MockError(404, 'not_found', 'Không có nguồn skill này trong cấu hình.');
  skillRoots.splice(i, 1);
  return { ok: true };
});
on('PUT', '/skills/:id/agents', ([id], _q, b) => {
  if (!d.skills.some((sk) => sk.id === id)) throw new MockError(404, 'not_found', 'Không tìm thấy skill');
  for (const a of d.agents) {
    if (a.access.skills === 'all') continue;
    const has = a.access.skills.includes(id!);
    const want = (b.agentIds as string[]).includes(a.id);
    if (want && !has) a.access.skills = [...a.access.skills, id!];
    if (!want && has) a.access.skills = a.access.skills.filter((x: string) => x !== id);
  }
  return { usedBy: skillViews().find((sk) => sk.id === id)!.usedBy };
});
on('GET', '/skills/:id', ([id]) => {
  const skill = d.skills.find((s) => s.id === id);
  if (!skill) throw new MockError(404, 'not_found', 'Không tìm thấy skill');
  return { skill, content: d.skillContent[skill.id] ?? '# (chưa có nội dung mẫu)' };
});
on('GET', '/board', () => ({ items: d.board }));
on('GET', '/audit', (_p, q) => ({ items: d.audit.filter((a) => (!q.get('actor') || a.actor.includes(q.get('actor')!)) && (!q.get('action') || a.action.includes(q.get('action')!))) }));

on('GET', '/modules', () => ({ items: d.modules }));
on('GET', '/modules/:id', ([id]) => d.modules.find((m) => m.manifest.id === id));
on('POST', '/modules/:id/add', ([id], _q, b) => {
  const m = d.modules.find((x) => x.manifest.id === id);
  if (!m) throw new MockError(404, 'not_found', 'Không tìm thấy module');
  const missing = m.requirements.filter((r) => !r.ok);
  if (missing.length) throw new MockError(412, 'requirements_missing', `Còn thiếu điều kiện: ${missing.map((r) => r.message).join('; ')}`);
  m.state.enabled = true;
  m.state.installedAt = d.NOW();
  m.error = undefined;
  emit({ type: 'module', module: clone(m.state) });
  return { module: m, migrationsApplied: ['001_init.sql'], agentsInstalled: b?.installAgents ? m.agentTemplates : [] };
});
on('POST', '/modules/:id/remove', ([id]) => {
  const m = d.modules.find((x) => x.manifest.id === id)!;
  m.state.enabled = false;
  emit({ type: 'module', module: clone(m.state) });
  return m;
});
on('POST', '/modules/:id/purge', ([id], _q, b) => {
  const m = d.modules.find((x) => x.manifest.id === id)!;
  if (b.confirm !== id) throw new MockError(400, 'bad_request', 'Mã xác nhận không khớp');
  m.state.installedAt = null;
  return { ok: true };
});
on('GET', '/m/_template/notes', () => ({ items: [{ id: 1, text: 'Ghi chú mẫu đầu tiên', answer: null, created_at: d.NOW() }] }));
on('GET', '/modules/:id/settings', () => ({}));
on('PUT', '/modules/:id/settings', (_p, _q, b) => b);

// ---- integrations (docs/dev/INTEGRATIONS-PLAN.md)
if (!d.attention.some((a) => a.key.startsWith('integration:approval:'))) d.attention.push(ig.approvalAttention());
const findIntegration = (id: string) => {
  const i = ig.integrations.find((x) => x.id === id);
  if (!i) throw new MockError(404, 'not_found', 'Không tìm thấy integration');
  return i;
};
on('GET', '/integrations', () => ({ items: ig.integrations }));
on('GET', '/integrations/approvals', (_p, q) => ({ items: ig.approvals.filter((a) => !q.get('status') || a.status === q.get('status')) }));
const decide = (status: 'approved' | 'rejected'): Route => ([id], _q, b) => {
  const a = ig.approvals.find((x) => String(x.id) === id);
  if (!a || a.status !== 'pending') throw new MockError(404, 'not_found', 'Không tìm thấy lệnh đang chờ duyệt');
  a.status = status;
  a.decidedAt = d.NOW();
  if (status === 'approved') a.result = { ok: true, always: !!b?.always };
  const i = d.attention.findIndex((x) => x.key === `integration:approval:${a.id}`);
  if (i >= 0) emit({ type: 'attention', item: d.attention.splice(i, 1)[0]!, resolved: true });
  return a;
};
on('POST', '/integrations/approvals/:id/approve', decide('approved'));
on('POST', '/integrations/approvals/:id/reject', decide('rejected'));
on('PUT', '/integrations/:id', ([id], _q, b) => {
  const i = findIntegration(id!);
  const key = i.fields.find((f) => f.kind === 'secret');
  if (key && !b.values[key.key] && !key.value) throw new MockError(400, 'bad_request', 'Không kết nối được: thiếu khoá.');
  i.status = 'ok';
  i.accountLabel = i.accountLabel || 'Tài khoản mẫu';
  i.checkedAt = d.NOW();
  for (const f of i.fields) if (f.kind === 'secret' && b.values[f.key]) f.value = `••••${String(b.values[f.key]).slice(-4)}`;
  return i;
});
on('POST', '/integrations/:id/test', ([id]) => {
  const i = findIntegration(id!);
  return i.status === 'error' ? { ok: false, detail: i.statusDetail } : { ok: i.status !== 'not_configured', detail: i.status === 'not_configured' ? 'Chưa nhập khoá.' : 'Kết nối hoạt động.', accountLabel: i.accountLabel };
});
on('DELETE', '/integrations/:id', ([id]) => {
  const i = findIntegration(id!);
  Object.assign(i, { status: 'not_configured', accountLabel: '', statusDetail: '' });
  return { ok: true };
});
on('GET', '/agents/:id/integrations', ([id]) => ({ grants: ig.agentGrants[id!] ?? {} }));
on('PUT', '/agents/:id/integrations', ([id], _q, b) => ({ grants: (ig.agentGrants[id!] = b.grants) }));

for (const [m, p, fn] of costRoutes) on(m, p, fn);
for (const [m, p, fn] of teamsMockRoutes) on(m, p, (a, q, b) => { try { return fn(a, q, b); } catch (e) { throw e instanceof TeamsMockError ? new MockError(e.status, e.code, e.message) : e; } });

export async function mockRequest<T>(method: string, rawPath: string, body?: unknown): Promise<T> {
  await delay(120);
  const url = new URL(rawPath.replace(/^\/api/, ''), 'http://x');
  for (const [m, re, fn] of routes) {
    if (m !== method) continue;
    const hit = re.exec(url.pathname);
    if (!hit) continue;
    try {
      return clone(fn(hit.slice(1), url.searchParams, body)) as T;
    } catch (e) {
      if (e instanceof MockError) {
        throw new ApiError(e.status, { error: { code: e.code, message: e.message } }, e.message, e.code);
      }
      throw e;
    }
  }
  throw new ApiError(404, null, `Mock chưa có route ${method} ${url.pathname}`, 'not_found');
}
