/**
 * The session token lives in the device's secure storage (iOS Keychain,
 * Android Keystore-backed) and in memory, nowhere else. On the web target, where
 * secure storage does not exist, it is kept in memory only.
 */
import { storageDelete, storageGet, storageSet } from '@/lib/safe-storage';

export interface TokenStorage {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

const KEY = 'agenticos.session';

export const secureTokenStorage: TokenStorage = {
  get: () => storageGet(KEY),
  set: (token) => storageSet(KEY, token),
  clear: () => storageDelete(KEY),
};
