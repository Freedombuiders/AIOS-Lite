/**
 * Encapsulated Customer Care stores (barrel). No public raw db handle is exported; every store
 * is constructed with the handle (and encryption key) of the database it serves.
 */

export { CareAccountStore } from './account-store.js';
export { CareCustomerStore, CareIdentityStore } from './directory-stores.js';
export { CareConversationStore } from './conversation-store.js';
export { CareMessageStore, type MessageInsertOptions } from './message-store.js';
export { CareJobStore } from './job-store.js';
export {
  CareCheckpointStore,
  CareEventStore,
  scrubEventPayload,
  type CheckpointOutcome,
  type StoredCheckpoint,
} from './event-store.js';
export {
  CareAssignmentStore,
  CareCredentialStore,
  CareJournalStore,
  CareLegacyLinkStore,
  CareProfileStore,
  CareTaskStore,
  type CareProfileRecord,
  type CareTaskRecord,
} from './misc-stores.js';
