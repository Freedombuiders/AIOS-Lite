import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { createCloudClient } from '@/api/cloud';
import { config } from '@/config';
import { enabledProviders } from './providers';
import { AuthStore, type AuthState } from './store';
import { secureTokenStorage } from './token-storage';

const AuthContext = createContext<AuthStore | null>(null);

export function createAppAuthStore(): AuthStore {
  return new AuthStore({
    storage: secureTokenStorage,
    providers: enabledProviders(),
    createApi: (hooks) => createCloudClient({ baseUrl: config.cloudUrl, ...hooks }),
  });
}

/** Provides the store. Tests pass their own `store`; the app lets it create one. */
export function AuthProvider({ store, children }: { store?: AuthStore; children: ReactNode }) {
  const value = useMemo(() => store ?? createAppAuthStore(), [store]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthStore(): AuthStore {
  const s = useContext(AuthContext);
  if (!s) throw new Error('useAuthStore needs an AuthProvider');
  return s;
}

export function useAuthState(): AuthState {
  const store = useAuthStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** The cloud client of the current store. */
export const useApi = () => useAuthStore().api;
