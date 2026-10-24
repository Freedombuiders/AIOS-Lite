// Rules that turn the current state of AIOS into improvement suggestions. Pure: no writes.
import type { AgentConfig, Skill, Task } from '../core/types.js';
import type { ModuleInfo } from '../modules/contracts.js';

export type RecoArm = 'agents' | 'work' | 'skills' | 'brain' | 'modules';
export type RecoEffort = 'xs' | 's' | 'm' | 'l';
export type RecoAction =
  | { kind: 'task'; agentId: string; title: string; prompt: string }
  | { kind: 'grant-brain'; folderId: string; agentId: string }
  | { kind: 'add-module'; moduleId: string };

export interface RecoCandidate {
  /** stable: the same finding gets the same id, so decisions survive recomputation */
  id: string;
  arm: RecoArm;
  title: string;
  benefit: string;
  /** what "Áp dụng" will do, in plain Vietnamese */
  actionText: string;
  action: RecoAction;
  effort: RecoEffort;
  /** 1 = high */
  priority: 1 | 2 | 3;
  evidence: string[];
}

export interface RuleInput {
  agents: AgentConfig[];
  failedTasks: Task[];
  monthCost: (agentId: string) => number;
  skills: Skill[];
  brainFolders: Array<{ id: string; name: string }>;
  modules: ModuleInfo[];
  now?: Date;
}

const WEEK_MS = 7 * 86_400_000;

export function computeRecos(input: RuleInput): RecoCandidate[] {
  const out: RecoCandidate[] = [];
  const now = (input.now ?? new Date()).getTime();
  const enabled = input.agents.filter((a) => a.enabled);

  // failed tasks in the last 7 days, grouped by agent
  const byAgent = new Map<string, Task[]>();
  for (const t of input.failedTasks) {
    if (now - Date.parse(t.updatedAt) > WEEK_MS) continue;
    byAgent.set(t.agentId, [...(byAgent.get(t.agentId) ?? []), t]);
  }
  for (const [agentId, list] of byAgent) {
    if (list.length < 2) continue;
    const errors = [...new Set(list.map((t) => (t.error ?? 'không rõ lỗi').slice(0, 120)))].slice(0, 3);
    out.push({
      id: `failed-tasks:${agentId}`,
      arm: 'work',
      title: `Agent "${agentId}" có ${list.length} việc thất bại trong 7 ngày`,
      benefit: 'Tìm nguyên nhân chung (quyền, runtime, prompt) để việc không thất bại lặp lại.',
      actionText: `Giao cho agent main xem các việc thất bại của "${agentId}" và đề xuất cách sửa. Không tự đổi cấu hình.`,
      action: {
        kind: 'task',
        agentId: 'main',
        title: `Xem lại việc thất bại của ${agentId}`,
        prompt: `Agent "${agentId}" có ${list.length} việc thất bại trong 7 ngày qua (mã việc: ${list.map((t) => `#${t.id}`).join(', ')}). Đọc lỗi từng việc, tìm nguyên nhân chung và đề xuất cách sửa bằng văn bản. Không thay đổi cấu hình khi chưa được chủ hệ thống đồng ý.`,
      },
      effort: 's',
      priority: list.length >= 4 ? 1 : 2,
      evidence: errors,
    });
  }

  // agents near or over their monthly budget
  for (const a of input.agents) {
    if (!a.budgetUsdMonth || a.budgetUsdMonth <= 0) continue;
    const cost = input.monthCost(a.id);
    const ratio = cost / a.budgetUsdMonth;
    if (ratio < 0.8) continue;
    const over = ratio >= 1;
    out.push({
      id: `budget:${a.id}`,
      arm: 'agents',
      title: over ? `Agent "${a.id}" đã vượt ngân sách tháng` : `Agent "${a.id}" sắp hết ngân sách tháng (${Math.round(ratio * 100)}%)`,
      benefit: 'Tránh agent bị dừng giữa chừng hoặc chi phí vượt dự kiến.',
      actionText: `Giao cho agent main phân tích chi phí của "${a.id}" và đề xuất nâng ngân sách hoặc đổi sang runtime rẻ hơn. Bạn quyết định.`,
      action: {
        kind: 'task',
        agentId: 'main',
        title: `Rà chi phí của ${a.id}`,
        prompt: `Agent "${a.id}" đã dùng $${cost.toFixed(2)} trên ngân sách $${a.budgetUsdMonth.toFixed(2)} tháng này. Xem các lần chạy gần đây, chỉ ra việc nào tốn nhất và đề xuất: nâng ngân sách, đổi runtime hay rút gọn prompt. Chỉ đề xuất, không tự sửa agent.yaml.`,
      },
      effort: 'xs',
      priority: over ? 1 : 2,
      evidence: [`Đã dùng $${cost.toFixed(2)} / $${a.budgetUsdMonth.toFixed(2)}`],
    });
  }

  // skills nobody can use
  const granted = new Set<string>();
  let anyAll = false;
  for (const a of input.agents) {
    if (a.access.skills === 'all') anyAll = true;
    else for (const s of a.access.skills) granted.add(s);
  }
  if (!anyAll) {
    for (const s of input.skills) {
      if (granted.has(s.id) || s.source.startsWith('module:')) continue;
      out.push({
        id: `unused-skill:${s.id}`,
        arm: 'skills',
        title: `Skill "${s.name || s.id}" chưa được agent nào dùng`,
        benefit: 'Skill có sẵn nhưng không agent nào được cấp thì không giúp được việc.',
        actionText: 'Giao cho agent main xem skill này hợp với agent nào và đề xuất cấp, hoặc gợi ý xoá nếu đã lỗi thời.',
        action: {
          kind: 'task',
          agentId: 'main',
          title: `Xem skill chưa dùng: ${s.id}`,
          prompt: `Skill "${s.id}" (${s.description || 'không có mô tả'}) chưa được cấp cho agent nào. Đọc SKILL.md, nêu agent nào nên dùng và vì sao, hoặc đề xuất xoá nếu đã lỗi thời. Chỉ đề xuất, không sửa quyền.`,
        },
        effort: 'xs',
        priority: 3,
        evidence: [s.path],
      });
    }
  }

  // second-brain folders no agent can read
  for (const f of input.brainFolders) {
    const readable = input.agents.some((a) => {
      const g = a.access.brain[f.id];
      return !!g && (g.read.length > 0 || g.write.length > 0);
    });
    if (readable) continue;
    const target = enabled.find((a) => a.id === 'main') ?? enabled[0];
    if (!target) continue;
    out.push({
      id: `brain-ungranted:${f.id}`,
      arm: 'brain',
      title: `Second Brain "${f.name}" chưa cấp cho agent nào`,
      benefit: 'Agent chỉ trả lời dựa trên tri thức của bạn khi được cấp quyền đọc.',
      actionText: `Cấp quyền ĐỌC (không ghi) thư mục "${f.name}" cho agent "${target.id}".`,
      action: { kind: 'grant-brain', folderId: f.id, agentId: target.id },
      effort: 'xs',
      priority: 2,
      evidence: [],
    });
  }

  // modules present on disk but not added
  for (const m of input.modules) {
    if (m.state.enabled || !m.ready) continue;
    out.push({
      id: `module:${m.manifest.id}`,
      arm: 'modules',
      title: `Module "${m.manifest.name}" chưa được thêm`,
      benefit: m.manifest.description,
      actionText: `Thêm module "${m.manifest.name}" (có thể gỡ lại bất cứ lúc nào, dữ liệu được giữ).`,
      action: { kind: 'add-module', moduleId: m.manifest.id },
      effort: 's',
      priority: 3,
      evidence: [],
    });
  }

  return out.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}
