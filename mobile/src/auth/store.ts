/**
 * Who is signed in. A plain subscribable object (no React inside) so the API
 * client's 401 hook, the screens and the tests all talk to the same thing.
 *
 * The session token is held in a private field and in secure storage. It is not
 * part of `state`, so it never reaches React props, query keys or logs.
 */
import type { ApiUser } from '../../../packages/api-types/src/index';
import type { CloudApi } from '@/api/cloud';
import { CloudError, isCloudError } from '@/api/errors';
import type { TokenStorage } from './token-storage';
import { SignInProviderError, type Credential, type SignInProvider } from './providers/types';

export type AuthState =
  | { status: 'loading' }
  /** `notice: 'expired'` after a 401 (session expired, revoked or account disabled), null after a normal sign-out. */
  | { status: 'signedOut'; notice: 'expired' | null }
  | { status: 'signedIn'; user: ApiUser }
  /** A token is stored but the cloud could not be asked whether it is still good. */
  | { status: 'unreachable'; error: CloudError };

export type SignInOutcome =
  | { type: 'ok' }
  | { type: 'cancelled' }
  | { type: 'error'; error: CloudError | SignInProviderError };

export interface ApiHooks {
  getToken: () => string | null;
  onUnauthorized: (rejectedToken: string) => void;
}

export interface AuthStoreDeps {
  storage: TokenStorage;
  createApi: (hooks: ApiHooks) => CloudApi;
  /** Every provider the app offers; signing out asks each to forget the device account. */
  providers: SignInProvider[];
}

export class AuthStore {
  readonly api: CloudApi;
  /** The sign-in options the app offers, in button order. */
  readonly providers: SignInProvider[];
  private token: string | null = null;
  private state: AuthState = { status: 'loading' };
  private readonly listeners = new Set<() => void>();
  private lastRoute: string | null = null;
  private returnTo: string | null = null;

  constructor(private readonly deps: AuthStoreDeps) {
    this.providers = deps.providers;
    this.api = deps.createApi({
      getToken: () => this.token,
      onUnauthorized: (rejected) => this.handleUnauthorized(rejected),
    });
  }

  getState = (): AuthState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(state: AuthState) {
    this.state = state;
    for (const l of [...this.listeners]) l();
  }

  /** The screen the user is on, remembered so a 401 can bring them back to it after signing in again. */
  rememberRoute(path: string) {
    this.lastRoute = path;
  }

  /** The route to go back to after an expiry, without consuming it. */
  peekReturnTo(): string | null {
    return this.returnTo;
  }

  /** The route to go back to after an expiry, once. */
  takeReturnTo(): string | null {
    const r = this.returnTo;
    this.returnTo = null;
    return r;
  }

  /** Reads the stored token and asks the cloud who it belongs to. */
  async bootstrap(): Promise<void> {
    let stored: string | null = null;
    try { stored = await this.deps.storage.get(); } catch { stored = null; }
    if (!stored) {
      this.set({ status: 'signedOut', notice: null });
      return;
    }
    this.token = stored;
    this.set({ status: 'loading' });
    try {
      const me = await this.api.me();
      if (this.token === stored) this.set({ status: 'signedIn', user: me.user });
    } catch (e) {
      // A 401 already signed us out through the hook. Anything else: we cannot tell, so say so.
      if (this.token === stored) this.set({ status: 'unreachable', error: isCloudError(e) ? e : new CloudError('network') });
    }
  }

  private async exchange(credential: Credential) {
    switch (credential.kind) {
      case 'google-id-token': return this.api.signInWithGoogle(credential.idToken);
      case 'dev-email': return this.api.signInDev(credential.email);
    }
  }

  async signIn(provider: SignInProvider): Promise<SignInOutcome> {
    try {
      const result = await provider.start();
      if (result.type === 'cancelled') return { type: 'cancelled' };
      const auth = await this.exchange(result.credential);
      this.token = auth.token;
      try { await this.deps.storage.set(auth.token); } catch { /* memory only until the next launch */ }
      this.set({ status: 'signedIn', user: auth.user });
      return { type: 'ok' };
    } catch (e) {
      if (isCloudError(e) || e instanceof SignInProviderError) return { type: 'error', error: e };
      return { type: 'error', error: new SignInProviderError('failed') };
    }
  }

  private async forget() {
    this.token = null;
    this.returnTo = null;
    try { await this.deps.storage.clear(); } catch { /* nothing more to do */ }
    for (const p of this.deps.providers) await p.signOut?.();
  }

  /** Ends this session on the cloud (best effort: offline still signs out locally), then forgets the token. */
  async signOut(): Promise<void> {
    if (this.token) {
      try { await this.api.logout(); } catch { /* the cloud will expire it; locally we are out */ }
    }
    await this.forget();
    this.set({ status: 'signedOut', notice: null });
  }

  /** Deletes the account on the cloud. Throws the CloudError when that fails and leaves the user signed in. */
  async deleteAccount(): Promise<void> {
    await this.api.deleteAccount();
    await this.forget();
    this.set({ status: 'signedOut', notice: null });
  }

  /** The cloud said 401 to `rejected`. Ignored when that token is no longer the current one (a newer sign-in won the race). */
  private handleUnauthorized(rejected: string) {
    if (rejected !== this.token) return;
    this.token = null;
    this.returnTo = this.lastRoute && this.lastRoute !== '/' ? this.lastRoute : null;
    void this.deps.storage.clear().catch(() => undefined);
    this.set({ status: 'signedOut', notice: 'expired' });
  }
}
