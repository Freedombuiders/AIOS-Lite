// Grant logic: what an agent may do with an integration command. Pure functions over AgentConfig.access.integrations.
import type { IntegrationGrantSetting } from '../core/types.js';
import { listIntegrationIds, getIntegration } from './registry.js';
import {
  IntegrationAccessDeniedError,
  type IntegrationAccess,
  type IntegrationCommand,
  type IntegrationGrant,
  type IntegrationRisk,
  type ParsedArgs,
} from './types.js';

/** Per-command overrides next to a grant; command names are exact (`orders set-status`). */
export interface IntegrationOverrides { ask: string[]; allow: string[] }
export interface IntegrationPolicy { grant: IntegrationGrant; overrides?: IntegrationOverrides }

const GRANTS: readonly IntegrationGrant[] = ['off', 'read', 'ask', 'write'];
const MAX_OVERRIDES = 100;

const isGrant = (v: unknown): v is IntegrationGrant => GRANTS.includes(v as IntegrationGrant);

/** Command names only; anything else in an override list is dropped. */
function cleanNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value.filter((n): n is string => typeof n === 'string' && n.trim() !== '' && n.length <= 100).map((n) => n.trim());
  return [...new Set(names)].slice(0, MAX_OVERRIDES);
}

/** One agent-yaml entry → policy. Anything malformed is off (fail closed). */
export function policyOf(setting: IntegrationGrantSetting | undefined): IntegrationPolicy {
  if (isGrant(setting)) return { grant: setting };
  if (setting && typeof setting === 'object' && isGrant(setting.grant)) {
    const overrides = { ask: cleanNames(setting.ask), allow: cleanNames(setting.allow) };
    return { grant: setting.grant, ...(overrides.ask.length || overrides.allow.length ? { overrides } : {}) };
  }
  return { grant: 'off' };
}

/** A write or ask grant includes read; `ask` still gates the write commands (see decideGate). */
export function grantAllows(grant: IntegrationGrant, needed: IntegrationAccess): boolean {
  return grant === 'write' || grant === 'ask' || (grant === 'read' && needed === 'read');
}

const RISK_ORDER: Record<IntegrationRisk, number> = { read: 0, write: 1, destructive: 2 };

/** The command's risk for these arguments: the stricter of `risk ?? access` and `riskOf(args)`. */
export function commandRisk(command: IntegrationCommand, args?: ParsedArgs): IntegrationRisk {
  let risk: IntegrationRisk = command.risk ?? command.access;
  if (args && command.riskOf) {
    try {
      const dynamic = command.riskOf(args);
      if (RISK_ORDER[dynamic] > RISK_ORDER[risk]) risk = dynamic;
    } catch { /* a risk hook must not break the call; keep the static risk */ }
  }
  return risk;
}

/**
 * deny: the grant does not reach it · ask: park it for the owner · run: go ahead.
 * `ask` override beats everything that still lets the agent reach the command;
 * grant ask: writes ask unless `allow`ed; grant write: only destructive asks unless `allow`ed.
 */
export function decideGate(
  grant: IntegrationGrant,
  overrides: IntegrationOverrides | undefined,
  command: IntegrationCommand,
  risk: IntegrationRisk,
): 'deny' | 'run' | 'ask' {
  if (!grantAllows(grant, command.access)) return 'deny';
  if (overrides?.ask.includes(command.name)) return 'ask';
  const needsApproval = grant === 'ask' ? risk !== 'read' : grant === 'write' && risk === 'destructive';
  return needsApproval && !overrides?.allow.includes(command.name) ? 'ask' : 'run';
}

/** Fail-closed gate for one call; throws IntegrationAccessDeniedError when the grant does not reach the command. */
export function resolveCommandGate(
  agentId: string,
  integrationId: string,
  setting: IntegrationGrantSetting | undefined,
  command: IntegrationCommand,
  args: ParsedArgs,
): { gate: 'run' | 'ask'; risk: IntegrationRisk } {
  const { grant, overrides } = policyOf(setting);
  const risk = commandRisk(command, args);
  const gate = decideGate(grant, overrides, command, risk);
  if (gate === 'deny') throw new IntegrationAccessDeniedError(agentId, integrationId, command.access);
  return { gate, risk };
}

/**
 * Validates a PUT body: known integration ids, valid grants, override names that are real commands.
 * Returns the yaml form (off entries dropped, plain string when there are no overrides), or an error message.
 */
export function parseGrantsBody(body: unknown): { grants: Record<string, IntegrationGrantSetting> } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Quyền integration phải là một đối tượng {tên: mức quyền}.' };
  const known = listIntegrationIds();
  const grants: Record<string, IntegrationGrantSetting> = {};
  for (const [id, entry] of Object.entries(body as Record<string, unknown>)) {
    if (!known.includes(id)) return { error: `Không có integration "${id}".` };
    if (isGrant(entry)) {
      if (entry !== 'off') grants[id] = entry;
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { error: `Quyền của "${id}" không hợp lệ.` };
    const { grant, ask, allow, ...rest } = entry as Record<string, unknown>;
    if (!isGrant(grant) || Object.keys(rest).length > 0) return { error: `Quyền của "${id}" không hợp lệ.` };
    for (const list of [ask, allow]) {
      if (list !== undefined && (!Array.isArray(list) || list.length > MAX_OVERRIDES || list.some((n) => typeof n !== 'string'))) {
        return { error: `Danh sách lệnh của "${id}" không hợp lệ.` };
      }
    }
    const overrides = { ask: cleanNames(ask), allow: cleanNames(allow) };
    const names = new Set(getIntegration(id)?.commands.map((c) => c.name));
    const unknown = [...overrides.ask, ...overrides.allow].find((n) => !names.has(n));
    if (unknown) return { error: `Lệnh "${unknown}" không có trong ${id}.` };
    if (grant === 'off') continue;
    grants[id] = overrides.ask.length || overrides.allow.length
      ? { grant, ...(overrides.ask.length ? { ask: overrides.ask } : {}), ...(overrides.allow.length ? { allow: overrides.allow } : {}) }
      : grant;
  }
  return { grants };
}
