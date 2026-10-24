// Runs one integration call: grant gate → stored values → hourly budget → trust rule / approval → run → log.
// Call-log and audit rows hold the command name only, never arguments; error text is scrubbed of stored secrets.
import crypto from 'node:crypto';
import type { AuditService } from '../access/contracts.js';
import type { AgentRegistry } from '../agents/contracts.js';
import type { Logger } from '../core/log.js';
import { redactValue } from '../core/redact.js';
import { commandRisk as commandRiskOf, decideGate, policyOf, resolveCommandGate } from './access.js';
import { parseArgs, tokenize } from './args.js';
import type { IntegrationDb } from './db.js';
import { getIntegration, INTEGRATIONS } from './registry.js';
import type { CredentialStore } from './store.js';
import {
  IntegrationAccessDeniedError,
  IntegrationApiError,
  IntegrationNotConfiguredError,
  IntegrationUsageError,
  type IntegrationAccess,
  type IntegrationCommand,
  type IntegrationDefinition,
  type IntegrationRisk,
  type IntegrationValues,
  type ParsedArgs,
} from './types.js';

export const HOURLY_CALL_BUDGET = 600;
export const CALL_TIMEOUT_MS = 60_000;

export type CallErrorCode = 'denied' | 'not_configured' | 'approval_pending' | 'usage' | 'api' | 'rate_limited';
export type CallResult =
  | { ok: true; result: unknown }
  | { ok: false; code: CallErrorCode; message: string; approvalId?: string };

export interface BridgeTool {
  /** `${integrationId}__${command with spaces and dashes turned into _}` */
  name: string;
  integrationId: string;
  command: string;
  description: string;
  usage: string;
  access: IntegrationAccess;
  risk: IntegrationRisk;
}

export interface CallInput {
  agentId: string;
  taskId?: number | null;
  integration: string;
  /** command name, e.g. "orders list" */
  command: string;
  /** everything after the command words, as one string */
  args?: string;
}

/** What the approval service needs to file a request for a gated call. */
export interface ApprovalRequest {
  agentId: string;
  taskId: number | null;
  definition: IntegrationDefinition;
  command: IntegrationCommand;
  risk: IntegrationRisk;
  /** the command line as the agent wrote it (command words + args) */
  argsText: string;
  argsHash: string;
}

export type CallVia = { kind: 'direct' } | { kind: 'trust_rule' | 'approval'; ref?: string };

export function matchCommand(definition: IntegrationDefinition, positionals: string[]): { command: IntegrationCommand; rest: string[] } | null {
  let best: { command: IntegrationCommand; words: number } | null = null;
  for (const command of definition.commands) {
    const words = command.name.split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > positionals.length) continue;
    if (!words.every((w, i) => positionals[i] === w)) continue;
    if (!best || words.length > best.words) best = { command, words: words.length };
  }
  return best ? { command: best.command, rest: positionals.slice(best.words) } : null;
}

/** Exact-shape hash of one call: flag order does not matter, values do. */
export function callArgsHash(definition: IntegrationDefinition, command: IntegrationCommand, args: ParsedArgs): string {
  const flags = Object.fromEntries(Object.entries(args.flags).sort(([a], [b]) => a.localeCompare(b)));
  return crypto.createHash('sha256').update(JSON.stringify({ i: definition.id, c: command.name, p: args.positionals, f: flags })).digest('hex');
}

export const toolName = (integrationId: string, command: string): string => `${integrationId}__${command.replace(/[\s-]+/g, '_')}`;

function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new IntegrationApiError(`Quá thời gian chờ (${Math.round(timeoutMs / 1000)} giây).`));
    }, timeoutMs);
  });
  return Promise.race([work(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

/** Removes stored credential values from text that is about to be kept or shown. */
export function scrub(message: string, values: IntegrationValues): string {
  let out = message;
  for (const value of Object.values(values)) if (value.length >= 4) out = out.split(value).join('***');
  return out;
}

function scrubDeep<T>(value: T, values: IntegrationValues): T {
  const secrets = Object.values(values).filter((v) => v.length >= 4);
  if (secrets.length === 0) return redactValue(value);
  const text = secrets.reduce((acc, s) => acc.split(s).join('***'), JSON.stringify(value) ?? 'null');
  return redactValue(JSON.parse(text) as T);
}

export function createRunner(deps: {
  idb: IntegrationDb;
  store: CredentialStore;
  agents: Pick<AgentRegistry, 'get'>;
  audit: Pick<AuditService, 'log'>;
  log: Logger;
  requestApproval: (req: ApprovalRequest) => { id: string; created: boolean };
  timeoutMs?: number;
}) {
  const { idb, store } = deps;
  const settingOf = (agentId: string, integrationId: string) => deps.agents.get(agentId)?.access.integrations?.[integrationId];

  function assertBudget(definition: IntegrationDefinition): void {
    if (idb.countCallsSince(definition.id, Math.floor(Date.now() / 1000) - 3600) >= HOURLY_CALL_BUDGET) {
      throw new RateLimited(`Đã dùng hết ${HOURLY_CALL_BUDGET} lượt gọi ${definition.name} trong 1 giờ. Thử lại sau.`);
    }
  }

  /** The shared run path: timeout, error scrubbing, call log and write audit. */
  async function execute(
    run: { definition: IntegrationDefinition; command: IntegrationCommand; args: ParsedArgs; agentId: string; taskId: number | null; values: IntegrationValues; via: CallVia },
  ): Promise<unknown> {
    const { definition, command, args, agentId, taskId, values, via } = run;
    const started = Date.now();
    let failure = '';
    try {
      return scrubDeep(await withTimeout((signal) => command.run({ agentId, values, signal }, args), deps.timeoutMs ?? CALL_TIMEOUT_MS), values);
    } catch (err) {
      // Only errors the integration marked safe keep their text; anything else could carry a URL or header with a credential.
      if (err instanceof IntegrationUsageError || err instanceof IntegrationApiError) {
        failure = scrub(err.message, values);
        if (err instanceof IntegrationApiError) throw new IntegrationApiError(failure, err.status);
        throw new IntegrationUsageError(failure);
      }
      failure = 'Lỗi không xác định khi gọi dịch vụ.';
      throw new IntegrationApiError(failure);
    } finally {
      idb.insertCall({ integrationId: definition.id, agentId, taskId, command: command.name, access: command.access, ok: failure === '', error: failure, durationMs: Date.now() - started });
      if (command.access === 'write' || via.kind !== 'direct') {
        try {
          deps.audit.log({
            actor: agentId,
            action: 'integration.write',
            target: `${definition.id}:${command.name}`,
            detail: { integration: definition.id, command: command.name, ...(via.kind === 'direct' ? {} : { via: via.kind, ref: via.ref ?? null }) },
          });
        } catch (e) {
          deps.log.warn({ err: e }, 'integration audit failed');
        }
      }
    }
  }

  function parseCall(input: CallInput): { definition: IntegrationDefinition; command: IntegrationCommand; args: ParsedArgs; argsText: string } {
    const definition = getIntegration(input.integration);
    if (!definition) throw new IntegrationUsageError(`Không có integration "${input.integration}".`);
    const argsText = `${input.command} ${input.args ?? ''}`.trim();
    const parsed = parseArgs(tokenize(argsText));
    const matched = matchCommand(definition, parsed.positionals);
    if (!matched) {
      throw new IntegrationUsageError(`Lệnh "${parsed.positionals.slice(0, 2).join(' ')}" không tồn tại trong ${definition.id}.`);
    }
    return { definition, command: matched.command, args: { positionals: matched.rest, flags: parsed.flags }, argsText };
  }

  async function call(input: CallInput): Promise<CallResult> {
    const taskId = input.taskId ?? null;
    try {
      const definition = getIntegration(input.integration);
      if (!definition) throw new IntegrationUsageError(`Không có integration "${input.integration}".`);
      const setting = settingOf(input.agentId, definition.id);
      // An agent without any grant learns nothing about the command list.
      if (policyOf(setting).grant === 'off') throw new IntegrationAccessDeniedError(input.agentId, definition.id, 'read');
      const { command, args, argsText } = parseCall(input);
      const { gate, risk } = resolveCommandGate(input.agentId, definition.id, setting, command, args);
      const values = store.loadValues(definition.id);
      if (!values) throw new IntegrationNotConfiguredError(definition.id);
      assertBudget(definition);
      let via: CallVia = { kind: 'direct' };
      if (gate === 'ask') {
        const hash = callArgsHash(definition, command, args);
        if (idb.hasTrustRule(input.agentId, definition.id, command.name, hash)) {
          via = { kind: 'trust_rule' };
        } else {
          const { id, created } = deps.requestApproval({ agentId: input.agentId, taskId, definition, command, risk, argsText, argsHash: hash });
          return {
            ok: false,
            code: 'approval_pending',
            approvalId: id,
            message: (created ? `Đã gửi chủ duyệt (mã ${id}), lệnh CHƯA chạy.` : `Yêu cầu y hệt đang chờ chủ duyệt (mã ${id}), lệnh CHƯA chạy.`)
              + ' Đừng chạy lại hay tìm cách khác; báo người dùng là đang chờ chủ và kết thúc lượt. Khi chủ quyết định, bạn sẽ nhận kết quả (hoặc lời từ chối) trong bình luận của việc.',
          };
        }
      }
      return { ok: true, result: await execute({ definition, command, args, agentId: input.agentId, taskId, values, via }) };
    } catch (err) {
      return toFailure(err);
    }
  }

  /** Runs a command the owner approved. The grant is re-checked (revoked access cannot cash in an old approval); the ask gate is not. */
  async function executeApproved(req: { integrationId: string; command: string; argsText: string; agentId: string; taskId: number | null; approvalId: string }): Promise<unknown> {
    const { definition, command, args } = parseCall({ agentId: req.agentId, integration: req.integrationId, command: req.argsText });
    if (command.name !== req.command) throw new IntegrationUsageError('Lệnh đã duyệt không còn khớp với định nghĩa hiện tại. Cần yêu cầu duyệt lại.');
    const { grant, overrides } = policyOf(settingOf(req.agentId, definition.id));
    if (decideGate(grant, overrides, command, commandRiskOf(command, args)) === 'deny') {
      throw new IntegrationAccessDeniedError(req.agentId, definition.id, command.access);
    }
    const values = store.loadValues(definition.id);
    if (!values) throw new IntegrationNotConfiguredError(definition.id);
    assertBudget(definition);
    return execute({ definition, command, args, agentId: req.agentId, taskId: req.taskId, values, via: { kind: 'approval', ref: req.approvalId } });
  }

  /**
   * A read command run by module code (dashboards, sync), not by an agent: no grant check, only read commands,
   * same timeout, scrubbing, call log and hourly budget. `actor` is 'module:<id>'.
   */
  async function runRead(req: { integrationId: string; commandLine: string; actor: string }): Promise<unknown> {
    const { definition, command, args } = parseCall({ agentId: req.actor, integration: req.integrationId, command: req.commandLine });
    if (command.access !== 'read' || commandRiskOf(command, args) !== 'read') {
      throw new IntegrationUsageError(`Module chỉ được chạy lệnh đọc; "${command.name}" là lệnh ghi.`);
    }
    const values = store.loadValues(definition.id);
    if (!values) throw new IntegrationNotConfiguredError(definition.id);
    assertBudget(definition);
    return execute({ definition, command, args, agentId: req.actor, taskId: null, values, via: { kind: 'direct' } });
  }

  /** The commands this agent may call, one MCP tool each. */
  function tools(agentId: string): BridgeTool[] {
    const out: BridgeTool[] = [];
    for (const d of INTEGRATIONS) {
      const { grant, overrides } = policyOf(settingOf(agentId, d.id));
      if (grant === 'off') continue;
      for (const c of d.commands) {
        const risk = c.risk ?? c.access;
        const gate = decideGate(grant, overrides, c, risk);
        if (gate === 'deny') continue;
        out.push({
          name: toolName(d.id, c.name),
          integrationId: d.id,
          command: c.name,
          description: `${d.name}: ${c.description}${gate === 'ask' ? ' (cần chủ duyệt trước khi chạy)' : ''}`,
          usage: c.usage,
          access: c.access,
          risk,
        });
      }
    }
    return out;
  }

  return { call, executeApproved, runRead, tools };
}

class RateLimited extends Error {}

function toFailure(err: unknown): Extract<CallResult, { ok: false }> {
  if (err instanceof RateLimited) return { ok: false, code: 'rate_limited', message: err.message };
  if (err instanceof IntegrationAccessDeniedError) return { ok: false, code: 'denied', message: err.message };
  if (err instanceof IntegrationNotConfiguredError) return { ok: false, code: 'not_configured', message: err.message };
  if (err instanceof IntegrationUsageError) return { ok: false, code: 'usage', message: err.message };
  if (err instanceof IntegrationApiError) return { ok: false, code: 'api', message: err.message };
  return { ok: false, code: 'api', message: 'Lỗi không xác định khi gọi dịch vụ.' };
}

export { toFailure };
export type Runner = ReturnType<typeof createRunner>;
