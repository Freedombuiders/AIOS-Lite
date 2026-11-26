import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { CloudApi } from '@/api/cloud';
import { AuthProvider } from '@/auth/context';
import { AuthStore } from '@/auth/store';
import type { TokenStorage } from '@/auth/token-storage';
import type { SignInProvider } from '@/auth/providers/types';
import { I18nProvider, type Lang } from '@/i18n';
import { me } from './fixtures';

export function memoryStorage(initial: string | null = null): TokenStorage & { value: string | null } {
  const s = {
    value: initial,
    get: async () => s.value,
    set: async (t: string) => { s.value = t; },
    clear: async () => { s.value = null; },
  };
  return s;
}

const unexpected = (name: string) => () => { throw new Error(`unexpected call to api.${name}`); };

/** A fake cloud API. Anything a test did not stub throws, so a stray call fails the test. */
export function fakeApi(over: Partial<CloudApi> = {}): CloudApi {
  return {
    signInWithGoogle: unexpected('signInWithGoogle'),
    signInDev: unexpected('signInDev'),
    logout: jest.fn(async () => ({ ok: true as const })),
    me: jest.fn(async () => me()),
    revokeSession: unexpected('revokeSession'),
    deleteAccount: unexpected('deleteAccount'),
    listPacks: unexpected('listPacks'),
    getPack: unexpected('getPack'),
    ...over,
  };
}

export function makeStore(api: CloudApi, opts: { token?: string | null; providers?: SignInProvider[] } = {}) {
  const storage = memoryStorage(opts.token === undefined ? 'tok_test' : opts.token);
  const store = new AuthStore({ storage, providers: opts.providers ?? [], createApi: () => api });
  return { store, storage };
}

export interface RenderOptions { api?: CloudApi; lang?: Lang; signedIn?: boolean; store?: AuthStore }

/** Renders a screen the way the app does (i18n, auth, query cache), signed in against the fake API unless told otherwise. */
export async function renderScreen(ui: ReactElement, opts: RenderOptions = {}) {
  const api = opts.api ?? fakeApi();
  const { store, storage } = makeStore(api, { token: opts.signedIn === false ? null : 'tok_test' });
  const useStore = opts.store ?? store;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, networkMode: 'always', gcTime: Infinity }, mutations: { networkMode: 'always', gcTime: Infinity } } });
  await act(async () => { await useStore.bootstrap(); });
  const utils = await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider initialLang={opts.lang ?? 'vi'}>
        <AuthProvider store={useStore}>
          <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
        </AuthProvider>
      </I18nProvider>
    </SafeAreaProvider>,
  );
  return { ...utils, api, store: useStore, storage, queryClient };
}
