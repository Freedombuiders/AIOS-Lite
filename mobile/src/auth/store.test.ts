import { createCloudClient } from '@/api/cloud';
import { CloudError } from '@/api/errors';
import { fakeApi, makeStore, memoryStorage } from '@/test/helpers';
import { auth } from '@/test/fixtures-auth';
import { AuthStore } from './store';
import { SignInProviderError, type SignInProvider } from './providers/types';

const googleOk: SignInProvider = {
  id: 'google', labelKey: 'signIn.google',
  start: async () => ({ type: 'credential', credential: { kind: 'google-id-token', idToken: 'gid' } }),
  signOut: jest.fn(async () => undefined),
};

describe('AuthStore: sign-in', () => {
  it('exchanges the Google ID token, keeps the session token in storage and signs in', async () => {
    const api = fakeApi({ signInWithGoogle: jest.fn(async () => auth('tok_new')) });
    const { store, storage } = makeStore(api, { token: null });
    await store.bootstrap();
    expect(store.getState()).toEqual({ status: 'signedOut', notice: null });
    expect(await store.signIn(googleOk)).toEqual({ type: 'ok' });
    expect(api.signInWithGoogle).toHaveBeenCalledWith('gid');
    expect(storage.value).toBe('tok_new');
    expect(store.getState().status).toBe('signedIn');
    // The token is not part of the observable state.
    expect(JSON.stringify(store.getState())).not.toContain('tok_new');
  });

  it('returns a cancelled outcome without calling the cloud', async () => {
    const api = fakeApi();
    const { store } = makeStore(api, { token: null });
    await store.bootstrap();
    const out = await store.signIn({ ...googleOk, start: async () => ({ type: 'cancelled' }) });
    expect(out).toEqual({ type: 'cancelled' });
    expect(store.getState().status).toBe('signedOut');
  });

  it('a disabled account (403) stays signed out and reports it', async () => {
    const api = fakeApi({ signInWithGoogle: jest.fn(async () => { throw new CloudError('disabled', 403); }) });
    const { store, storage } = makeStore(api, { token: null });
    await store.bootstrap();
    const out = await store.signIn(googleOk);
    expect(out.type).toBe('error');
    expect(out.type === 'error' && (out.error as CloudError).kind).toBe('disabled');
    expect(store.getState()).toEqual({ status: 'signedOut', notice: null });
    expect(storage.value).toBeNull();
  });

  it('a provider failure is an error outcome, never a crash', async () => {
    const { store } = makeStore(fakeApi(), { token: null });
    await store.bootstrap();
    const out = await store.signIn({ ...googleOk, start: async () => { throw new SignInProviderError('needs_dev_build'); } });
    expect(out.type === 'error' && (out.error as SignInProviderError).code).toBe('needs_dev_build');
    const out2 = await store.signIn({ ...googleOk, start: async () => { throw new Error('native boom with account@example.com'); } });
    expect(out2.type === 'error' && (out2.error as SignInProviderError).code).toBe('failed');
  });

  it('a network failure while exchanging is an error outcome and leaves no token behind', async () => {
    const api = fakeApi({ signInWithGoogle: jest.fn(async () => { throw new CloudError('network'); }) });
    const { store, storage } = makeStore(api, { token: null });
    await store.bootstrap();
    const out = await store.signIn(googleOk);
    expect(out.type === 'error' && (out.error as CloudError).kind).toBe('network');
    expect(storage.value).toBeNull();
  });
});

describe('AuthStore: start-up', () => {
  it('signs in from a stored token after asking the cloud who it is', async () => {
    const api = fakeApi();
    const { store } = makeStore(api, { token: 'tok_saved' });
    await store.bootstrap();
    expect(api.me).toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ status: 'signedIn', user: { email: 'lan@example.com' } });
  });

  it('a stored token the cloud rejects (401) is cleared and the user is told the session expired', async () => {
    // The real client against a fake fetch, so the 401 travels the whole way: client hook -> store.
    const fetch401 = jest.fn(async () => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'x' } }), { status: 401 })) as unknown as typeof fetch;
    const storage = memoryStorage('tok_saved');
    const store = new AuthStore({ storage, providers: [], createApi: (hooks) => createCloudClient({ baseUrl: 'https://cloud.test', fetch: fetch401, ...hooks }) });
    await store.bootstrap();
    expect(store.getState()).toEqual({ status: 'signedOut', notice: 'expired' });
    expect(storage.value).toBeNull();
  });

  it('a later 401 from any call signs out through the same path', async () => {
    let calls = 0;
    const fetchImpl = jest.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ user: { id: 'u', email: 'a@b.c', name: null, avatarUrl: null, role: 'user', status: 'active', createdAt: 'x', lastSeenAt: null }, sessions: [] }), { status: 200 })
        : new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'x' } }), { status: 401 });
    }) as unknown as typeof fetch;
    const storage = memoryStorage('tok_saved');
    const store = new AuthStore({ storage, providers: [], createApi: (hooks) => createCloudClient({ baseUrl: 'https://cloud.test', fetch: fetchImpl, ...hooks }) });
    await store.bootstrap();
    expect(store.getState().status).toBe('signedIn');
    await expect(store.api.listPacks()).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(store.getState()).toEqual({ status: 'signedOut', notice: 'expired' });
    expect(storage.value).toBeNull();
  });

  it('an unreachable cloud keeps the token and says it could not check, instead of signing out', async () => {
    const api = fakeApi({ me: jest.fn(async () => { throw new CloudError('network'); }) });
    const { store, storage } = makeStore(api, { token: 'tok_saved' });
    await store.bootstrap();
    expect(store.getState().status).toBe('unreachable');
    expect(storage.value).toBe('tok_saved');
  });

  it('is signed out with no notice when nothing is stored', async () => {
    const { store } = makeStore(fakeApi(), { token: null });
    await store.bootstrap();
    expect(store.getState()).toEqual({ status: 'signedOut', notice: null });
  });
});

/** The store hands the client a hook; simulate the client calling it on a 401. */
function rejectWith(store: AuthStore, token: string): CloudError {
  (store as unknown as { handleUnauthorized(t: string): void }).handleUnauthorized(token);
  return new CloudError('unauthorized', 401);
}

describe('AuthStore: 401 during use', () => {
  it('clears the token, goes back to sign-in with an "expired" notice and remembers the screen', async () => {
    const { store, storage } = makeStore(fakeApi(), { token: 'tok_saved' });
    await store.bootstrap();
    store.rememberRoute('/store/tra-va-qua-tang-co-ban');
    rejectWith(store, 'tok_saved');
    expect(store.getState()).toEqual({ status: 'signedOut', notice: 'expired' });
    expect(storage.value).toBeNull();
    expect(store.takeReturnTo()).toBe('/store/tra-va-qua-tang-co-ban');
    expect(store.takeReturnTo()).toBeNull();
  });

  it('ignores a 401 for a token that is no longer current (a newer sign-in won the race)', async () => {
    const { store } = makeStore(fakeApi(), { token: 'tok_new' });
    await store.bootstrap();
    rejectWith(store, 'tok_old');
    expect(store.getState().status).toBe('signedIn');
  });

  it('peeking at the route to return to does not consume it', async () => {
    const { store } = makeStore(fakeApi(), { token: 'tok_saved' });
    await store.bootstrap();
    store.rememberRoute('/store');
    rejectWith(store, 'tok_saved');
    expect(store.peekReturnTo()).toBe('/store');
    expect(store.peekReturnTo()).toBe('/store');
    expect(store.takeReturnTo()).toBe('/store');
    expect(store.peekReturnTo()).toBeNull();
  });

  it('does not remember the home screen as a place to return to', async () => {
    const { store } = makeStore(fakeApi(), { token: 'tok_saved' });
    await store.bootstrap();
    store.rememberRoute('/');
    rejectWith(store, 'tok_saved');
    expect(store.takeReturnTo()).toBeNull();
  });

  it('notifies subscribers once per change', async () => {
    const { store } = makeStore(fakeApi(), { token: 'tok_saved' });
    await store.bootstrap();
    const listener = jest.fn();
    const off = store.subscribe(listener);
    rejectWith(store, 'tok_saved');
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('AuthStore: sign-out and account deletion', () => {
  it('signs out locally even when the cloud cannot be reached, and asks providers to forget the account', async () => {
    const api = fakeApi({ logout: jest.fn(async () => { throw new CloudError('network'); }) });
    const storage = memoryStorage('tok_saved');
    const signOut = jest.fn(async () => undefined);
    const store = new AuthStore({ storage, createApi: () => api, providers: [{ ...googleOk, signOut }] });
    await store.bootstrap();
    await store.signOut();
    expect(api.logout).toHaveBeenCalled();
    expect(storage.value).toBeNull();
    expect(signOut).toHaveBeenCalled();
    expect(store.getState()).toEqual({ status: 'signedOut', notice: null });
  });

  it('deleting the account signs out only after the cloud says yes', async () => {
    const deleteAccount = jest.fn(async () => ({ ok: true as const }));
    const { store, storage } = makeStore(fakeApi({ deleteAccount }), { token: 'tok_saved' });
    await store.bootstrap();
    await store.deleteAccount();
    expect(deleteAccount).toHaveBeenCalled();
    expect(storage.value).toBeNull();
    expect(store.getState()).toEqual({ status: 'signedOut', notice: null });
  });

  it('a failed deletion keeps the user signed in and rethrows', async () => {
    const deleteAccount = jest.fn(async () => { throw new CloudError('network'); });
    const { store, storage } = makeStore(fakeApi({ deleteAccount }), { token: 'tok_saved' });
    await store.bootstrap();
    await expect(store.deleteAccount()).rejects.toMatchObject({ kind: 'network' });
    expect(store.getState().status).toBe('signedIn');
    expect(storage.value).toBe('tok_saved');
  });
});

