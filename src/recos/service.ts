// Improvement suggestions "cart": findings are computed live; the owner's decisions live in kv.
import type { AuditService } from '../access/contracts.js';
import type { AgentRegistry } from '../agents/contracts.js';
import { nowIso, type DB } from '../core/db.js';
import type { ModuleManager } from '../modules/contracts.js';
import type { BrainService, SkillLibrary } from '../shared/contracts.js';
import type { TaskService } from '../work/contracts.js';
import { computeRecos, type RecoAction, type RecoCandidate } from './rules.js';

export type RecoStatus = 'new' | 'cart' | 'done' | 'skipped';
export interface RecoView extends Omit<RecoCandidate, 'action'> {
  status: RecoStatus;
  actionKind: RecoAction['kind'];
  result: string | null;
  decidedAt: string | null;
}

interface Decision {
  status: Exclude<RecoStatus, 'new'>;
  result?: string | null;
  at: string;
}

export class RecoError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 | 422 = 400,
  ) {
    super(message);
  }
}

export interface RecosDeps {
  db: DB;
  agents: AgentRegistry;
  tasks: Pick<TaskService, 'create' | 'list'>;
  runs: { monthCost(agentId: string): number };
  skills: Pick<SkillLibrary, 'list'>;
  brain: Pick<BrainService, 'folders'>;
  modules: Pick<ModuleManager, 'discover' | 'add'>;
  audit?: AuditService;
}

const KEY = 'recos:decisions';

export function createRecosService(deps: RecosDeps) {
  const load = (): Record<string, Decision> => {
    const row = deps.db.prepare('SELECT value FROM kv WHERE key = ?').get(KEY) as { value: string } | undefined;
    try {
      return row ? (JSON.parse(row.value) as Record<string, Decision>) : {};
    } catch {
      return {};
    }
  };
  const save = (d: Record<string, Decision>) => {
    deps.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(d));
  };

  function candidates(): RecoCandidate[] {
    return computeRecos({
      agents: deps.agents.list(),
      failedTasks: deps.tasks.list({ status: 'failed', limit: 300 }),
      monthCost: (id) => deps.runs.monthCost(id),
      skills: deps.skills.list(),
      brainFolders: deps.brain.folders(),
      modules: deps.modules.discover(),
    });
  }

  function view(c: RecoCandidate, d: Record<string, Decision>): RecoView {
    const { action, ...rest } = c;
    const dec = d[c.id];
    return { ...rest, actionKind: action.kind, status: dec?.status ?? 'new', result: dec?.result ?? null, decidedAt: dec?.at ?? null };
  }

  function find(id: string): RecoCandidate {
    const c = candidates().find((x) => x.id === id);
    if (!c) throw new RecoError('Đề xuất này không còn nữa (tình hình đã thay đổi).', 404);
    return c;
  }

  async function run(c: RecoCandidate): Promise<string> {
    const a = c.action;
    if (a.kind === 'task') {
      if (!deps.agents.get(a.agentId)) throw new RecoError(`Không có agent "${a.agentId}" để giao việc. Tạo agent main trước.`, 422);
      const t = deps.tasks.create({ agentId: a.agentId, title: a.title, prompt: a.prompt, source: 'api', priority: 5 });
      return `Đã giao việc #${t.id} cho ${a.agentId}.`;
    }
    if (a.kind === 'grant-brain') {
      const ag = deps.agents.get(a.agentId);
      if (!ag) throw new RecoError(`Không tìm thấy agent "${a.agentId}".`, 422);
      if (!deps.brain.folders().some((f) => f.id === a.folderId)) throw new RecoError('Thư mục Second Brain không còn.', 422);
      deps.agents.update(a.agentId, { access: { ...ag.access, brain: { ...ag.access.brain, [a.folderId]: { read: ['**'], write: [] } } } });
      return `Đã cấp quyền đọc "${a.folderId}" cho ${a.agentId}.`;
    }
    const res = await deps.modules.add(a.moduleId);
    return `Đã thêm module "${res.module.manifest.name}".`;
  }

  const service = {
    list(opts: { status?: RecoStatus | 'open' | 'all'; arm?: string } = {}): { items: RecoView[]; counts: Record<string, number> } {
      const d = load();
      let items = candidates().map((c) => view(c, d));
      const status = opts.status ?? 'open';
      const counts: Record<string, number> = { total: 0, cart: 0 };
      for (const i of items) {
        if (i.status === 'new' || i.status === 'cart') {
          counts.total!++;
          counts[i.arm] = (counts[i.arm] ?? 0) + 1;
          if (i.status === 'cart') counts.cart!++;
        }
      }
      if (status === 'open') items = items.filter((i) => i.status === 'new' || i.status === 'cart');
      else if (status !== 'all') items = items.filter((i) => i.status === status);
      if (opts.arm) items = items.filter((i) => i.arm === opts.arm);
      items.sort((a, b) => (a.status === 'cart' ? 0 : 1) - (b.status === 'cart' ? 0 : 1) || a.priority - b.priority);
      return { items, counts };
    },

    setStatus(id: string, status: RecoStatus): RecoView {
      const c = find(id);
      const d = load();
      if (d[id]?.status === 'done') throw new RecoError('Đề xuất đã áp dụng, không đổi trạng thái được.', 409);
      if (status === 'done') throw new RecoError('Dùng "Áp dụng" để hoàn tất đề xuất.', 400);
      if (status === 'new') delete d[id];
      else d[id] = { status, at: nowIso() };
      save(d);
      return view(c, d);
    },

    /** Run one suggestion's action now. */
    async apply(id: string): Promise<RecoView> {
      const c = find(id);
      const d = load();
      if (d[id]?.status === 'done') throw new RecoError('Đề xuất này đã được áp dụng.', 409);
      const result = await run(c);
      d[id] = { status: 'done', result, at: nowIso() };
      save(d);
      deps.audit?.log({ actor: 'user', action: 'reco.apply', target: id, detail: { kind: c.action.kind, result } });
      return view(c, d);
    },

    /** Apply every suggestion in the cart, one by one; a failure does not stop the rest. */
    async applyCart(): Promise<{ results: Array<{ id: string; ok: boolean; message: string }> }> {
      const results: Array<{ id: string; ok: boolean; message: string }> = [];
      const ids = Object.entries(load()).filter(([, v]) => v.status === 'cart').map(([k]) => k);
      for (const id of ids) {
        try {
          const v = await service.apply(id);
          results.push({ id, ok: true, message: v.result ?? 'Đã áp dụng.' });
        } catch (e) {
          results.push({ id, ok: false, message: (e as Error).message });
        }
      }
      return { results };
    },
  };
  return service;
}

export type RecosService = ReturnType<typeof createRecosService>;
