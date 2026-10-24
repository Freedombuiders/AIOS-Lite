// Directives are read from the FINAL assistant output only (the engine never passes tool output).
import type { AppConfig } from '../core/config.js';
import type { AgentConfig, Task } from '../core/types.js';
import type { AgentRegistry } from '../agents/contracts.js';

export type Directive =
  | { kind: 'task'; to: string; title?: string; wait: boolean; body: string }
  | { kind: 'memory'; scope: 'team' | 'private'; text: string }
  | { kind: 'status'; status: 'review' }
  | { kind: 'action'; module: string; name: string; payload: unknown };

export interface ParsedDirectives {
  directives: Directive[];
  cleanOutput: string;
  /** tags that were removed but could not be understood (nested, unknown attributes, bad status) */
  malformed: string[];
}

export interface RejectedDirective {
  directive: Directive;
  reason: string;
}

const MAX_MEMORY_CHARS = 2000;
const MAX_PARSED = 50;
const MAX_ACTIONS_PER_RUN = 10;
const MAX_ACTION_PAYLOAD = 20_000;

function attrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? '';
  return out;
}

const hasNestedTag = (body: string): boolean => /<\/?aios-(task|memory|status|action)\b/i.test(body);

export function parseDirectives(output: string): ParsedDirectives {
  const directives: Directive[] = [];
  const malformed: string[] = [];
  const push = (d: Directive) => {
    if (directives.length < MAX_PARSED) directives.push(d);
  };

  let clean = output.replace(/<aios-task\b([^>]*)>([\s\S]*?)<\/aios-task>/gi, (whole, a: string, body: string) => {
    const at = attrs(a);
    if (!at.to || hasNestedTag(body)) {
      malformed.push(whole.slice(0, 120));
      return '';
    }
    const d: Directive = { kind: 'task', to: at.to.trim(), wait: at.wait?.toLowerCase() !== 'false', body: body.trim() };
    if (at.title?.trim()) d.title = at.title.trim();
    push(d);
    return '';
  });

  clean = clean.replace(/<aios-memory\b([^>]*)>([\s\S]*?)<\/aios-memory>/gi, (whole, a: string, body: string) => {
    const scope = (attrs(a).scope ?? 'private').toLowerCase();
    if ((scope !== 'team' && scope !== 'private') || hasNestedTag(body)) {
      malformed.push(whole.slice(0, 120));
      return '';
    }
    push({ kind: 'memory', scope, text: body.trim() });
    return '';
  });

  clean = clean.replace(/<aios-status\b[^>]*>([\s\S]*?)<\/aios-status>/gi, (whole, body: string) => {
    if (body.trim().toLowerCase() !== 'review') {
      malformed.push(whole.slice(0, 120));
      return '';
    }
    push({ kind: 'status', status: 'review' });
    return '';
  });

  clean = clean.replace(/<aios-action\b([^>]*)>([\s\S]*?)<\/aios-action>/gi, (whole, a: string, body: string) => {
    const at = attrs(a);
    const raw = body.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    if (!at.module || !at.name || hasNestedTag(body) || raw.length > MAX_ACTION_PAYLOAD) {
      malformed.push(whole.slice(0, 120));
      return '';
    }
    let payload: unknown = {};
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        malformed.push(whole.slice(0, 120));
        return '';
      }
    }
    push({ kind: 'action', module: at.module.trim(), name: at.name.trim(), payload });
    return '';
  });

  // stray opening/closing tags left by nesting or truncation never reach the user or the next prompt
  clean = clean.replace(/<\/?aios-(?:task|memory|status|action)\b[^>]*>/gi, '');
  return { directives, cleanOutput: clean.trim(), malformed };
}

export interface ValidationContext {
  agent: AgentConfig;
  task: Task;
  agents: Pick<AgentRegistry, 'get'>;
  config: Pick<AppConfig, 'maxDelegationDepth' | 'maxChildrenPerRun' | 'maxSummaryRounds'>;
  /** access.memory.team of the calling run */
  teamMemory: boolean;
  /** module actions: scope required by '<module>:<name>' (undefined = no such action) and the agent's grant check */
  actionScope?: (module: string, name: string) => string | undefined;
  canModule?: (module: string, scope: string) => boolean;
}

export function validateDirectives(directives: Directive[], ctx: ValidationContext): { accepted: Directive[]; rejected: RejectedDirective[] } {
  const accepted: Directive[] = [];
  const rejected: RejectedDirective[] = [];
  const round = Number(ctx.task.meta.round ?? 0) || 0;
  let taskCount = 0;
  let actionCount = 0;
  for (const d of directives) {
    const reject = (reason: string) => rejected.push({ directive: d, reason });
    if (d.kind === 'status') {
      accepted.push(d);
    } else if (d.kind === 'action') {
      const scope = ctx.actionScope?.(d.module, d.name);
      if (scope === undefined) reject(`Không có hành động "${d.name}" của module "${d.module}" (hoặc module chưa được thêm)`);
      else if (!ctx.canModule?.(d.module, scope)) reject(`Agent chưa được cấp quyền "${scope}" của module "${d.module}"`);
      else if (actionCount >= MAX_ACTIONS_PER_RUN) reject(`Vượt số hành động tối đa mỗi lượt (${MAX_ACTIONS_PER_RUN})`);
      else {
        actionCount++;
        accepted.push(d);
      }
    } else if (d.kind === 'memory') {
      if (!d.text) reject('Nội dung ghi nhớ trống');
      else if (d.scope === 'team' && !ctx.teamMemory) reject('Agent không có quyền ghi bộ nhớ đội');
      else accepted.push(d.text.length > MAX_MEMORY_CHARS ? { ...d, text: d.text.slice(0, MAX_MEMORY_CHARS) } : d);
    } else {
      const target = ctx.agents.get(d.to);
      if (!ctx.agent.canDelegate) reject('Agent không được phép giao việc');
      else if (ctx.task.depth >= ctx.config.maxDelegationDepth) reject(`Vượt độ sâu giao việc tối đa (${ctx.config.maxDelegationDepth})`);
      else if (round >= ctx.config.maxSummaryRounds) reject(`Vượt số vòng tổng hợp tối đa (${ctx.config.maxSummaryRounds})`);
      else if (!target) reject(`Không tìm thấy agent "${d.to}"`);
      else if (!target.enabled) reject(`Agent "${d.to}" đang tắt`);
      else if (target.id === ctx.agent.id) reject('Agent không thể giao việc cho chính mình');
      else if (!d.body) reject('Nội dung việc trống');
      else if (taskCount >= ctx.config.maxChildrenPerRun) reject(`Vượt số việc con tối đa mỗi lượt (${ctx.config.maxChildrenPerRun})`);
      else {
        taskCount++;
        accepted.push(d);
      }
    }
  }
  return { accepted, rejected };
}
