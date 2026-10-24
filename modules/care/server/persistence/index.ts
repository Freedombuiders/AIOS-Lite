/**
 * Customer Care Persistence Layer
 * Encapsulated stores factory and test isolation without exposing raw arbitrary DB handles.
 *
 * Three distinct operations, never conflated:
 *  - createCareStores        pure factory: stores bound to one handle + key; touches no global
 *  - bindCareStores          sets the process-wide runtime binding (getCareStores)
 *  - initCareStores          applies the additive schema, then binds (read-write runtimes)
 *  - bindReadOnlyCareStores  binds stores for a read-only handle WITHOUT any schema write
 */

import Database from 'better-sqlite3';
import type { CareKeyInput } from './crypto.js';
import { createCareSchema } from './schema.js';
import { CareBridgeStore } from './bridge-store.js';
import { CareOutboxStore } from './outbox-store.js';
import { CareOwnershipStore } from './ownership-store.js';
import { CareAgentRunStore } from './agent-run-store.js';
import { CareAuditStore } from './audit-store.js';
import { CareBridgeAuditStore } from './bridge-audit.js';
import {
  CareAccountStore,
  CareAssignmentStore,
  CareCheckpointStore,
  CareConversationStore,
  CareCredentialStore,
  CareCustomerStore,
  CareEventStore,
  CareIdentityStore,
  CareJobStore,
  CareJournalStore,
  CareLegacyLinkStore,
  CareMessageStore,
  CareProfileStore,
  CareTaskStore,
} from './stores.js';

export interface CareStores {
  accounts: CareAccountStore;
  customers: CareCustomerStore;
  identities: CareIdentityStore;
  conversations: CareConversationStore;
  messages: CareMessageStore;
  jobs: CareJobStore;
  events: CareEventStore;
  checkpoints: CareCheckpointStore;
  journal: CareJournalStore;
  legacyLinks: CareLegacyLinkStore;
  credentials: CareCredentialStore;
  assignments: CareAssignmentStore;
  profiles: CareProfileStore;
  tasks: CareTaskStore;
  bridge: CareBridgeStore;
  outbox: CareOutboxStore;
  ownership: CareOwnershipStore;
  agentRuns: CareAgentRunStore;
  audit: CareAuditStore;
  bridgeAudit: CareBridgeAuditStore;
}

/**
 * Creates independent store instances bound to a specific DB handle without touching globals.
 * Every encrypted store receives the same key (or the fail-closed "unavailable" marker).
 */
export function createCareStores(db: Database.Database, key?: CareKeyInput): CareStores {
  return {
    accounts: new CareAccountStore(db, key),
    customers: new CareCustomerStore(db, key),
    identities: new CareIdentityStore(db, key),
    conversations: new CareConversationStore(db, key),
    messages: new CareMessageStore(db, key),
    jobs: new CareJobStore(db, key),
    events: new CareEventStore(db, key),
    checkpoints: new CareCheckpointStore(db),
    journal: new CareJournalStore(db, key),
    legacyLinks: new CareLegacyLinkStore(db),
    credentials: new CareCredentialStore(db, key),
    assignments: new CareAssignmentStore(db, key),
    profiles: new CareProfileStore(db, key),
    tasks: new CareTaskStore(db, key),
    bridge: new CareBridgeStore(db, key),
    outbox: new CareOutboxStore(db, key),
    ownership: new CareOwnershipStore(db, key),
    agentRuns: new CareAgentRunStore(db, key),
    audit: new CareAuditStore(db, key),
    bridgeAudit: new CareBridgeAuditStore(db),
  };
}

let activeStores: CareStores | null = null;

/** Replaces the process-wide runtime binding. */
export function bindCareStores(stores: CareStores): CareStores {
  activeStores = stores;
  return stores;
}

/** Applies the additive schema on `db`, then binds fresh stores for it as the runtime stores. */
export function initCareStores(db: Database.Database, key?: CareKeyInput): CareStores {
  createCareSchema(db);
  return bindCareStores(createCareStores(db, key));
}

/**
 * Binds stores to a read-only handle. Performs NO schema write; reads of a database that never
 * got the Care schema fail with SQLite's "no such table" instead of mutating it.
 */
export function bindReadOnlyCareStores(db: Database.Database, key?: CareKeyInput): CareStores {
  return bindCareStores(createCareStores(db, key));
}

/** Pure read-only factory (no schema write, no global binding). */
export function createReadOnlyCareStores(db: Database.Database, key?: CareKeyInput): CareStores {
  return createCareStores(db, key);
}

/** Drops the runtime binding (used when the owning handle is closed). */
export function unbindCareStores(): void {
  activeStores = null;
}

export function getCareStores(): CareStores {
  if (!activeStores) {
    throw new Error('CareStores have not been initialized. Call initCareStores(db) first.');
  }
  return activeStores;
}

/**
 * Creates an isolated test database with Care schema and returns independent stores.
 * Never alters the process-wide runtime binding.
 */
export function createTestCareDatabase(
  fileOrMemory = ':memory:',
  key?: CareKeyInput,
): {
  stores: CareStores;
  rawDbForTestIsolationOnly: Database.Database;
  close: () => void;
} {
  const db = new Database(fileOrMemory);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  createCareSchema(db);
  const stores = createCareStores(db, key);
  return {
    stores,
    rawDbForTestIsolationOnly: db,
    close: () => db.close(),
  };
}

export { createCareSchema };
export * from './bridge-store.js';
export * from './outbox-store.js';
export * from './ownership-store.js';
export * from './agent-run-store.js';
export * from './audit-store.js';
export * from './bridge-audit.js';
export {
  createUnavailableCareKey,
  resolveEncryptionKey,
  type CareKeyInput,
  type CareKeyUnavailable,
} from './crypto.js';
