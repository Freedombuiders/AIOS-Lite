// Lazy per-AppDeps service (so server.ts and the engine share one) + route mounting.
import type { AppDeps } from '../core/deps.js';
import { createIntegrationService, type IntegrationService } from './service.js';

const services = new WeakMap<object, IntegrationService>();

/** The integration service for these deps, created on first use. */
export function integrationServiceFor(deps: AppDeps): IntegrationService {
  let svc = services.get(deps);
  if (!svc) {
    svc = createIntegrationService({
      db: deps.db, cipher: deps.cipher, agents: deps.agents, bus: deps.bus, comments: deps.comments,
      attention: deps.attention, audit: deps.audit, log: deps.log, connections: deps.connections, dataDir: deps.config.dataDir,
    });
    services.set(deps, svc);
  }
  return svc;
}
