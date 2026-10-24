// agent.yaml (snake_case) <-> AgentConfig (camelCase). Default deny everywhere.
import path from 'node:path';
import { z } from 'zod';
import { expandHome } from '../core/config.js';
import { RUNTIME_IDS, type AgentConfig, type AgentAccessConfig } from '../core/types.js';

export const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

const strList = z.preprocess((v) => (typeof v === 'string' ? [v] : v), z.array(z.string()));

const folderGrant = z.strictObject({
  read: strList.default([]),
  write: strList.default([]),
});

const accessSchema = z
  .strictObject({
    brain: z.record(z.string(), folderGrant).default({}),
    memory: z.strictObject({ team: z.boolean().default(false), private: z.boolean().default(true) }).default({ team: false, private: true }),
    skills: z.union([z.literal('all'), z.array(z.string())]).default([]),
    connections: z.record(z.string(), z.union([z.literal(true), z.array(z.string())])).default({}),
    modules: z.record(z.string(), z.array(z.string())).default({}),
  })
  .default({ brain: {}, memory: { team: false, private: true }, skills: [], connections: {}, modules: {} });

const agentYamlSchema = z.strictObject({
  name: z.string().min(1).max(80),
  description: z.string().default(''),
  runtime: z.enum(RUNTIME_IDS as [string, ...string[]]),
  model: z.string().min(1).optional(),
  runtime_options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  permission: z.enum(['safe', 'full']).default('safe'),
  context: z.enum(['standard', 'lean']).default('standard'),
  reports_to: z.string().regex(AGENT_ID_RE).optional(),
  can_delegate: z.boolean().default(false),
  max_concurrent: z.number().int().min(1).max(20).default(1),
  budget_usd_month: z.number().min(0).optional(),
  enabled: z.boolean().default(true),
  workspace: z.string().min(1).optional(),
  access: accessSchema,
});

export class AgentValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = 'AgentValidationError';
  }
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const where = issue.path.length ? issue.path.join('.') : 'agent.yaml';
  switch (issue.code) {
    case 'invalid_type': {
      if (/received undefined/.test(issue.message)) return `${where}: thiếu giá trị bắt buộc`;
      return `${where}: sai kiểu dữ liệu (cần ${(issue as { expected?: string }).expected ?? 'giá trị khác'})`;
    }
    case 'unrecognized_keys':
      return `${where}: khoá không hợp lệ (${(issue as { keys: string[] }).keys.join(', ')}). Kiểm tra lại chính tả.`;
    case 'invalid_value': {
      const values = (issue as { values?: unknown[] }).values ?? [];
      return `${where}: giá trị phải là một trong: ${values.map(String).join(', ')}`;
    }
    case 'too_small':
      return `${where}: giá trị quá nhỏ hoặc để trống`;
    case 'too_big':
      return `${where}: giá trị quá lớn`;
    case 'invalid_format':
      return `${where}: sai định dạng (id agent dùng chữ thường, số và dấu gạch ngang)`;
    case 'invalid_union':
      return `${where}: giá trị không hợp lệ (xem tài liệu agent.yaml)`;
    default:
      return `${where}: ${issue.message}`;
  }
}

export function validateAgentId(id: string): void {
  if (!AGENT_ID_RE.test(id)) {
    throw new AgentValidationError(`Id agent "${id}" không hợp lệ: dùng chữ thường, số, dấu gạch ngang; dài 2–41 ký tự, bắt đầu bằng chữ hoặc số.`, [`id: ${id}`]);
  }
}

export interface ParseContext {
  id: string;
  /** absolute agents/<id> */
  dir: string;
  /** repo root; relative workspace paths resolve against it */
  repoRoot: string;
  workspacesDir: string;
  persona?: string;
}

/** Validate a raw YAML object and build the AgentConfig. Throws AgentValidationError (Vietnamese). */
export function parseAgentConfig(raw: unknown, ctx: ParseContext): AgentConfig {
  validateAgentId(ctx.id);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AgentValidationError('agent.yaml phải là một mapping (khoá: giá trị), file đang trống hoặc sai dạng.', ['agent.yaml']);
  }
  const parsed = agentYamlSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(describeIssue);
    throw new AgentValidationError(`agent.yaml của "${ctx.id}" không hợp lệ:\n- ${issues.join('\n- ')}`, issues);
  }
  const y = parsed.data;
  const access: AgentAccessConfig = {
    brain: y.access.brain,
    memory: y.access.memory,
    skills: y.access.skills,
    connections: y.access.connections,
    modules: y.access.modules,
  };
  const workspace = y.workspace ? path.resolve(ctx.repoRoot, expandHome(y.workspace)) : path.join(ctx.workspacesDir, ctx.id);
  return {
    id: ctx.id,
    name: y.name,
    description: y.description,
    runtime: y.runtime as AgentConfig['runtime'],
    ...(y.model ? { model: y.model } : {}),
    runtimeOptions: y.runtime_options,
    permission: y.permission,
    context: y.context,
    ...(y.reports_to ? { reportsTo: y.reports_to } : {}),
    canDelegate: y.can_delegate,
    maxConcurrent: y.max_concurrent,
    ...(y.budget_usd_month !== undefined ? { budgetUsdMonth: y.budget_usd_month } : {}),
    enabled: y.enabled,
    access,
    persona: (ctx.persona ?? '').trim() || y.description,
    dir: ctx.dir,
    workspace,
  };
}

/** AgentConfig -> plain object with stable key order, ready for YAML.stringify. */
export function agentToYamlObject(cfg: AgentConfig, opts: { workspacesDir: string }): Record<string, unknown> {
  const o: Record<string, unknown> = {
    name: cfg.name,
    description: cfg.description,
    runtime: cfg.runtime,
  };
  if (cfg.model) o.model = cfg.model;
  o.runtime_options = cfg.runtimeOptions;
  o.permission = cfg.permission;
  o.context = cfg.context;
  if (cfg.reportsTo) o.reports_to = cfg.reportsTo;
  o.can_delegate = cfg.canDelegate;
  o.max_concurrent = cfg.maxConcurrent;
  if (cfg.budgetUsdMonth !== undefined) o.budget_usd_month = cfg.budgetUsdMonth;
  o.enabled = cfg.enabled;
  if (path.resolve(cfg.workspace) !== path.join(opts.workspacesDir, cfg.id)) o.workspace = cfg.workspace;
  o.access = {
    brain: cfg.access.brain,
    memory: cfg.access.memory,
    skills: cfg.access.skills,
    connections: cfg.access.connections,
    modules: cfg.access.modules,
  };
  return o;
}
