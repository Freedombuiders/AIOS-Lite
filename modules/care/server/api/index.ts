/**
 * Care API mount point. The module framework serves it under /api/m/care; sub-modules register
 * their own routes here so parallel work packages do not edit the same file.
 *
 * Everything is mounted on a dedicated sub-app so the error envelope (`{code,message,...}`,
 * scrubbed) and the read gate apply to the care module only and never leak into other routes.
 * Auth/CSRF/read-only middleware stays the dashboard's: this mount is registered behind it.
 */

import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { getCareStores, type CareStores } from '../persistence/index.js';
import { ApiError, errorResponse, notFound } from './errors.js';
import type { CareApiContext } from './context.js';
import { CareCustomerOps } from '../application/customer-ops.js';
import { createCareReplyPort, type CareOutboxService } from '../application/outbox-service.js';
import type { OutboxIntentRecord } from '../persistence/outbox-store.js';
import type { BacklogSource } from '../runtime/backlog.js';
import { CareEventHub, DEFAULT_SSE, type SseOptions } from './events.js';
import type { CareReplyPort } from './ports.js';
import { CareReadModel } from './read-model.js';
import { registerEventRoutes } from './routes-events.js';
import { registerReadRoutes } from './routes-read.js';
import { registerReplyRoutes } from './routes-reply.js';
import { resolveSignature, type SignatureSource } from './signature.js';
import { registerCustomerOpsRoutes } from './routes-customer-ops.js';
import { registerTaskRoutes } from './routes-tasks.js';
import { registerRuleRoutes } from './routes-rules.js';
import { registerDraftRoutes } from './routes-drafts.js';
import { registerRuntimeRoutes } from './routes-runtime.js';
import { registerHealthRoutes } from './routes-health.js';
import { registerInboxDeliveryRoutes } from './routes-inbox-delivery.js';
import { registerMediaRoutes } from './routes-media.js';
import { registerProfileRoutes, storedAvatarSource } from './routes-profiles.js';
import type { CareMediaCache } from '../application/media-cache.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import { registerWorkflowRoutes } from './routes-workflow.js';
import { createCareWorkflowService, type CareWorkflowService } from '../workflow/index.js';

export type { CareReplyPort, CareReplyRequest, CareReplyAcceptance } from './ports.js';
export type * from './dto.js';
export type * from './dto-ops.js';
export type * from './dto-inbox.js';

export interface CareApiDeps {
  /** Defaults to the process-wide runtime binding (`getCareStores()`). */
  stores?: CareStores;
  /**
   * The SQLite handle `stores` is bound to. Needed for SQL filters, the single-transaction
   * snapshot and the cross-process journal tail; without it every route answers 503.
   */
  db?: Database.Database;
  /** Explicit reply port. Absent: built from `outboxService` when that is given, else reply/outbox routes answer 501. */
  replyPort?: CareReplyPort;
  /** CC-11 service: wires the default reply port and the draft approve/discard routes. */
  outboxService?: CareOutboxService;
  /** Dispatcher reconcile hook for the default reply port (`dispatcher.reconcile`). */
  reconcileIntent?: (intentId: string) => Promise<OutboxIntentRecord>;
  /** Per-account read gate for customer ops / timeline / profiles / runs. Default: the global `canRead`. */
  canReadSource?: (accountId: string) => boolean;
  /** Extra backlog sources (e.g. the outbox) parked when a runtime switch is re-enabled. */
  backlogSources?: BacklogSource[];
  /**
   * Mailbox signature source for the composer, read-only. Pass the SAME function the agent turn gets as
   * `signatureFor`, so there is one source of truth. Default: no signature.
   */
  signatureFor?: SignatureSource;
  /** Acting-party label recorded on audited writes. Default `dashboard`. */
  actor?: string;
  /** Stored copies of chat images for `GET /messages/:id/media`. Default: none (the route answers 404). */
  media?: Pick<CareMediaCache, 'get'>;
  /** Channel connectors, for `GET /conversations/:id/profiles` and the list rows' `avatarUrl`. Default: none. */
  connectors?: ConnectorRegistry;
  /** Data-access/module read gate. Evaluated per request and on every SSE tick. Default: allowed. */
  canRead?: () => boolean;
  now?: () => number;
  sse?: Partial<SseOptions>;
  /** Receives the ORIGINAL error behind a scrubbed 5xx (server log hook). */
  onError?: (err: unknown) => void;
}

export interface CareApiHandle {
  /** Stops the journal reader and disconnects every stream. */
  close(): void;
  /** Test/ops access to the per-process fan-out (null until the first stream connects). */
  hub(): CareEventHub | null;
}

export function registerCareRoutes(app: Hono, deps: CareApiDeps = {}): CareApiHandle {
  const now = deps.now ?? Date.now;
  const canRead = deps.canRead ?? (() => true);
  const sse: SseOptions = { ...DEFAULT_SSE, ...deps.sse };

  let model: CareReadModel | null = null;
  let hub: CareEventHub | null = null;
  let ops: CareCustomerOps | null = null;
  let defaultPort: CareReplyPort | undefined;
  let wf: CareWorkflowService | null = null;

  const api: CareApiContext = {
    model(): CareReadModel {
      if (model) return model;
      let stores: CareStores;
      try {
        stores = deps.stores ?? getCareStores();
      } catch {
        throw new ApiError('STORE_UNAVAILABLE', 503);
      }
      if (!deps.db) throw new ApiError('READ_MODEL_UNAVAILABLE', 503);
      model = new CareReadModel(deps.db, stores, (accountId) => api.canReadSource(accountId));
      if (deps.connectors) model.useAvatars(storedAvatarSource(stores, deps.connectors));
      return model;
    },
    get replyPort(): CareReplyPort | undefined {
      if (deps.replyPort) return deps.replyPort;
      if (!deps.outboxService) return undefined;
      if (!defaultPort) {
        defaultPort = createCareReplyPort({ service: deps.outboxService, stores: model?.stores ?? deps.stores ?? getCareStores(), reconcile: deps.reconcileIntent });
      }
      return defaultPort;
    },
    now,
    canReadSource(accountId: string): boolean {
      try {
        return (deps.canReadSource ?? canRead)(accountId) === true;
      } catch {
        return false; // a broken gate is a closed gate
      }
    },
    signatureOf(account): string | null {
      if (!account) return null;
      return resolveSignature(deps.signatureFor, account);
    },
    customerOps(): CareCustomerOps {
      if (!ops) {
        const m = api.model();
        ops = new CareCustomerOps(m.db, m.stores, { canReadSource: (accountId) => api.canReadSource(accountId) });
      }
      return ops;
    },
    outbox: deps.outboxService,
    backlogSources: deps.backlogSources ?? [],
    actor: deps.actor ?? 'dashboard',
    workflow(): CareWorkflowService {
      if (wf) return wf;
      const m = api.model();
      try {
        wf = createCareWorkflowService({
          db: m.db,
          stores: m.stores,
          model: m,
          now,
          canReadSource: (accountId) => api.canReadSource(accountId),
        });
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError('UNSUPPORTED_CAPABILITY', 501, 'The inbox workflow is not available.');
      }
      return wf;
    },
    media: deps.media,
    connectors: deps.connectors,
  };

  const sub = new Hono();
  sub.onError((err, c) => errorResponse(c, err, deps.onError));

  // Read gate: a disabled data-access/module gate stops every care call, mutations included.
  sub.use('*', async (c, next) => {
    let allowed = false;
    try {
      allowed = canRead();
    } catch {
      allowed = false; // fail closed
    }
    if (!allowed) throw new ApiError('READ_DISABLED', 403);
    await next();
  });

  // Inbox v2 first: their paths are new and must win over nothing else, but keep them ahead of the generic groups.
  registerInboxDeliveryRoutes(sub, api);
  registerMediaRoutes(sub, api);
  registerProfileRoutes(sub, api);
  registerWorkflowRoutes(sub, api);
  registerReadRoutes(sub, api);
  registerReplyRoutes(sub, api);
  registerCustomerOpsRoutes(sub, api);
  registerTaskRoutes(sub, api);
  registerRuleRoutes(sub, api);
  registerDraftRoutes(sub, api);
  registerRuntimeRoutes(sub, api);
  registerHealthRoutes(sub, api);
  registerEventRoutes(sub, {
    api,
    sse,
    hub(): CareEventHub {
      if (!hub) hub = new CareEventHub(api.model(), canRead, now, sse, deps.onError);
      return hub;
    },
  });

  // Unknown care paths get the same envelope instead of the host app's default 404.
  sub.all('*', () => {
    throw notFound();
  });

  app.route('/', sub);

  return {
    close(): void {
      hub?.close();
      hub = null;
    },
    hub: () => hub,
  };
}
