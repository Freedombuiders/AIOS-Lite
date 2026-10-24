/**
 * Contract for third-party integrations (Pancake, and whatever comes next).
 *
 * An integration is one external service the owner connects once, in
 * Integrations (dashboard), by entering its credentials. Agents then reach it
 * through `integration-cli`, but only the agents the owner granted it to in
 * Agents › Settings › Integrations, at the level granted (read, ask or write).
 *
 * To add an integration: write a definition that satisfies
 * `IntegrationDefinition` under src/integrations/<id>/ and add it to
 * INTEGRATIONS in registry.ts. Storage, the dashboard pages, the per-agent
 * grant, the CLI and the prompt block all derive from the definition.
 * See docs/integrations.md.
 */

/** What a command does to the external service. A write grant includes read. */
export type IntegrationAccess = 'read' | 'write';

/**
 * One agent's grant for one integration, as stored in agent.yaml `integrations`.
 * `ask` = read commands run at once, write and destructive commands wait for
 * the owner's approval (see approval-handler.ts).
 */
export type { IntegrationGrant } from '../core/types.js';
import type { IntegrationGrant } from '../core/types.js';

/**
 * How dangerous one command is. Defaults to `access`. `destructive` (cancel,
 * delete, ...) needs the owner's approval even under a `write` grant.
 */
export type IntegrationRisk = 'read' | 'write' | 'destructive';

/** Credentials and settings for one integration, keyed by IntegrationField.key. */
export type IntegrationValues = Record<string, string>;

export interface IntegrationField {
  /** Stable key, e.g. "api_key". */
  key: string;
  /** Vietnamese label shown in the form. */
  label: string;
  /** Secrets are write-only in the dashboard: never returned, only masked. */
  kind: 'secret' | 'text';
  required: boolean;
  placeholder?: string;
  help?: string;
}

export interface IntegrationTestResult {
  ok: boolean;
  /** Short Vietnamese status for the owner, e.g. "Đã kết nối shop Bimspeed". */
  detail: string;
  /** What the credentials belong to, e.g. the shop name. */
  accountLabel?: string;
  /** Values the test discovered and wants stored with the owner's, e.g. a shop id. */
  discovered?: IntegrationValues;
}

/** Arguments after the command words: `orders get 123 --full --limit 20`. */
export interface ParsedArgs {
  positionals: string[];
  /** `--flag value` → "value"; a bare `--flag` → true. Keys keep their dashes: "page-id". */
  flags: Record<string, string | true>;
}

export interface IntegrationCommandContext {
  /** The calling agent (CLAUDECLAW_AGENT_ID). */
  agentId: string;
  /** Decrypted stored values for this integration. */
  values: IntegrationValues;
  signal?: AbortSignal;
}

export interface IntegrationCommand {
  /** Space-separated words, e.g. "orders list". Matched against the start of argv. */
  name: string;
  access: IntegrationAccess;
  /** Defaults to `access`. Mark commands that destroy data `destructive`; they need a write grant plus approval. */
  risk?: IntegrationRisk;
  /**
   * Risk that depends on the arguments (e.g. a status change that cancels an
   * order). The stricter of `risk` and this result applies. Must not throw.
   */
  riskOf?(args: ParsedArgs): IntegrationRisk;
  /** Everything after the command words, e.g. "<orderId> [--full]". Empty when none. */
  usage: string;
  /** One line, English, for the agent. */
  description: string;
  /** Returns a JSON-serialisable result. Throws IntegrationUsageError for bad arguments. */
  run(ctx: IntegrationCommandContext, args: ParsedArgs): Promise<unknown>;
}

export interface IntegrationDefinition {
  /** Lowercase slug used in agent.yaml, the API and the CLI: "pancake". */
  id: string;
  name: string;
  /** Vietnamese group label in the catalog, e.g. "Bán hàng". */
  category: string;
  /** Vietnamese, one or two sentences, for the owner. */
  description: string;
  docsUrl?: string;
  authKind?: 'api-key' | 'oauth';
  group?: 'google';
  /** Vietnamese steps telling the owner where to get the credentials. */
  setupSteps: string[];
  fields: IntegrationField[];
  /** Checks the credentials with a cheap read call. Must not throw: report failures in the result. */
  test(values: IntegrationValues, signal?: AbortSignal): Promise<IntegrationTestResult>;
  commands: IntegrationCommand[];
  /** English, one or two sentences for the agent: what the service holds and when to use it. */
  agentGuide: string;
}

// ── Errors ──────────────────────────────────────────────────────────────
// integration-cli maps these to exit codes: usage/API 1, denied 3, not configured 4,
// waiting for the owner's approval 5.

export class IntegrationUsageError extends Error {
  constructor(message: string) { super(message); this.name = 'IntegrationUsageError'; }
}

/** The external service refused or failed. `message` is safe to show: no credentials in it. */
export class IntegrationApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'IntegrationApiError'; }
}

export class IntegrationAccessDeniedError extends Error {
  constructor(readonly agentId: string, readonly integrationId: string, readonly needed: IntegrationAccess) {
    super(needed === 'write'
      ? `Agent "${agentId}" chưa được cấp quyền ghi cho integration "${integrationId}". `
        + 'Chủ có thể đổi trong tab Quyền của agent.'
      : `Agent "${agentId}" chưa được cấp quyền dùng integration "${integrationId}". `
        + 'Chủ có thể bật trong tab Quyền của agent.');
    this.name = 'IntegrationAccessDeniedError';
  }
}

export class IntegrationNotConfiguredError extends Error {
  constructor(readonly integrationId: string) {
    super(`Integration "${integrationId}" chưa được kết nối. Chủ cần nhập thông tin ở trang Kết nối.`);
    this.name = 'IntegrationNotConfiguredError';
  }
}

/** integration-cli exit code for "filed for the owner's approval, not run" (0 ok, 1 error, 3 denied, 4 not connected). */
export const APPROVAL_PENDING_EXIT_CODE = 5;

/**
 * The command was not run: an approval request is waiting for the owner.
 * Not a failure; integration-cli prints it as JSON and exits with 5.
 */
export class IntegrationApprovalPendingError extends Error {
  constructor(readonly approvalId: string, message: string) {
    super(message);
    this.name = 'IntegrationApprovalPendingError';
  }
}
