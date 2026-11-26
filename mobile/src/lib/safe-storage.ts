/**
 * Small key/value storage on expo-secure-store, with an in-memory fallback where
 * it is unavailable (the web target). Every call is wrapped: storage can throw
 * (locked keychain, restored backup) and the app must still run.
 */
import * as SecureStore from 'expo-secure-store';

const memory = new Map<string, string>();
let available: Promise<boolean> | undefined;

function secureStoreAvailable(): Promise<boolean> {
  available ??= SecureStore.isAvailableAsync().catch(() => false);
  return available;
}

export async function storageGet(key: string): Promise<string | null> {
  try {
    if (await secureStoreAvailable()) return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
  return memory.get(key) ?? null;
}

export async function storageSet(key: string, value: string): Promise<void> {
  try {
    if (await secureStoreAvailable()) {
      await SecureStore.setItemAsync(key, value);
      return;
    }
  } catch {
    // Fall through to memory: the value lives for this run only.
  }
  memory.set(key, value);
}

export async function storageDelete(key: string): Promise<void> {
  memory.delete(key);
  try {
    if (await secureStoreAvailable()) await SecureStore.deleteItemAsync(key);
  } catch {
    // Nothing more to do; the in-memory copy is already gone.
  }
}
