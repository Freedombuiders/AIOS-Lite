// Process-wide Care UI state that must outlive component mounts (route changes, tab switches).

import { createDraftStore } from './drafts';
import { createIntentStore } from './intents';

function sessionStorageOrNull(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null; // blocked storage throws on access
  }
}

export const draftStore = createDraftStore(sessionStorageOrNull());
export const intentStore = createIntentStore();
