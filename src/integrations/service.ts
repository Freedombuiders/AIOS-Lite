// The integration service: credentials, runner (gate + budget + log), approvals, per-agent grants, run tokens.
import path from 'node:path';
import type { AuditService, ConnectionsService } from '../access/contracts.js';
import type { AgentRegistry } from '../agents/contracts.js';
import type { Cipher } from '../core/crypto.js';
import type { DB } from '../core/db.js';
import type { EventBus } from '../core/events.js';
import type { Logger } from '../core/log.js';
import type { IntegrationGrantSetting } from '../core/types.js';
import type { AttentionService, CommentService } from '../work/contracts.js';
import { parseGrantsBody } from './access.js';
import { createApprovals } from './approvals.js';
import { setComposioKeySource } from './composio/client.js';
import { createIntegrationDb } from './db.js';
import { setMediaRoot } from './media-files.js';
import { getIntegration, INTEGRATIONS } from './registry.js';
import { createRunner } from './runner.js';
import { createRunToken, tokenSecret, verifyRunToken } from './run-token.js';
import { createCredentialStore, mergeValues, missingRequired, type IntegrationSummary } from './store.js';
import type { IntegrationDefinition, IntegrationTestResult, IntegrationValues } from './types.js';

const TEST_TIMEOUT_MS = 20_000;

export interface IntegrationServiceDeps {
  db: DB;
  cipher: Cipher;
  agents: AgentRegistry;
  bus: EventBus;
  comments: CommentService;
  attention: AttentionService;
  audit: AuditService;
  log: Logger;
  /** source of the shared Composio project key (`COMPOSIO_API_KEY`) when none is stored */
  connections?: Pick<ConnectionsService, 'secret'>;
  /** where media integrations save files: <dataDir>/media */
  dataDir?: string;
  /** override for tests */
  callTimeoutMs?: number;
}

export type PutResult = { ok: true; summary: IntegrationSummary } | { ok: false; status: 400; detail: string };

export function createIntegrationService(deps: IntegrationServiceDeps) {
  const idb = createIntegrationDb(deps.db);
  const store = createCredentialStore({ idb, cipher: deps.cipher, composioFallback: () => deps.connections?.secret('COMPOSIO_API_KEY') });
  setComposioKeySource(() => store.loadValues('composio')?.api_key);
  if (deps.dataDir) setMediaRoot(path.join(deps.dataDir, 'media'));

  // approvals need the runner (to run approved commands); the runner needs approvals (to file requests)
  let approvalsRef: ReturnType<typeof createApprovals> | undefined;
  const runner = createRunner({
    idb, store, agents: deps.agents, audit: deps.audit, log: deps.log, timeoutMs: deps.callTimeoutMs,
    requestApproval: (req) => approvalsRef!.request(req),
  });
  const approvals = createApprovals({ idb, runner, attention: deps.attention, comments: deps.comments, bus: deps.bus, audit: deps.audit, log: deps.log });
  approvalsRef = approvals;

  const agentGrants = () => deps.agents.list().map((a) => ({ agentId: a.id, integrations: a.access.integrations }));

  /** definition.test must not throw, but a bug in one integration must not break the page. */
  async function runTest(definition: IntegrationDefinition, values: IntegrationValues): Promise<IntegrationTestResult> {
    try {
      return await definition.test(values, AbortSignal.timeout(TEST_TIMEOUT_MS));
    } catch {
      return { ok: false, detail: 'Không kiểm tra được kết nối. Thử lại sau.' };
    }
  }

  const credentials = {
    list: (): IntegrationSummary[] => store.summaries(INTEGRATIONS, agentGrants()),
    get: (id: string): IntegrationSummary | undefined => {
      const d = getIntegration(id);
      return d && store.summary(d, agentGrants());
    },
    loadValues: store.loadValues,
    /** Saves only when the service accepts the credentials. */
    async put(id: string, incoming: Record<string, unknown>): Promise<PutResult> {
      const definition = getIntegration(id)!;
      const merged = mergeValues(definition, store.loadValues(id), incoming);
      const missing = missingRequired(definition, merged);
      if (missing.length > 0) return { ok: false, status: 400, detail: `Cần nhập: ${missing.join(', ')}.` };
      const result = await runTest(definition, merged);
      if (!result.ok) return { ok: false, status: 400, detail: result.detail };
      store.save(id, merged, result);
      deps.audit.log({ actor: 'user', action: 'integration.save', target: id });
      return { ok: true, summary: store.summary(definition, agentGrants()) };
    },
    /** Re-tests stored values; null when nothing is stored. */
    async test(id: string): Promise<IntegrationTestResult | null> {
      const definition = getIntegration(id)!;
      const values = store.loadValues(id);
      if (!values) return null;
      const result = await runTest(definition, values);
      store.recordTest(id, result);
      return result;
    },
    remove(id: string): void {
      store.remove(id);
      store.remove(`oauth-pending-${id}`);
      deps.audit.log({ actor: 'user', action: 'integration.remove', target: id });
    },
  };

  const grants = {
    get(agentId: string): Record<string, IntegrationGrantSetting> | undefined {
      const a = deps.agents.get(agentId);
      return a && { ...(a.access.integrations ?? {}) };
    },
    /** Replaces the agent's grants (written to agent.yaml through the registry). */
    set(agentId: string, body: unknown): { grants: Record<string, IntegrationGrantSetting> } | { error: string } {
      const parsed = parseGrantsBody(body);
      if ('error' in parsed) return parsed;
      const cur = deps.agents.require(agentId);
      deps.agents.update(agentId, { access: { ...cur.access, integrations: parsed.grants } });
      deps.audit.log({ actor: 'user', action: 'integration.grants', target: agentId, detail: { grants: parsed.grants } });
      return parsed;
    },
  };

  return {
    definitions: INTEGRATIONS,
    credentials,
    runner,
    approvals,
    grants,
    /** the slice of the credential store the Composio/Google OAuth flow uses */
    oauthStore: { load: store.loadValues, save: store.save, remove: store.remove },
    /** Bearer token for the MCP bridge of one run (pass this as `integrationToken` to the access policy). */
    createRunToken: (agentId: string, taskId: number | string): string => createRunToken({ agentId, taskId }, tokenSecret(deps.db)),
    verifyRunToken: (token: string) => verifyRunToken(token, tokenSecret(deps.db)),
  };
}

export type IntegrationService = ReturnType<typeof createIntegrationService>;
