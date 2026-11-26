/**
 * A way to sign in. Each provider turns a user gesture into a credential the
 * cloud can exchange for a session; the AuthStore knows how to exchange each
 * credential kind. To add a provider (say "Sign in with Apple"):
 *   1. add a credential kind here and a provider file next to google.ts,
 *   2. add its exchange to AuthStore.exchange (and the cloud endpoint it needs),
 *   3. list it in providers/index.ts. The sign-in screen renders whatever is listed.
 */
import type { MessageKey } from '@/i18n';

export type Credential =
  | { kind: 'google-id-token'; idToken: string }
  | { kind: 'dev-email'; email: string };

export type ProviderResult = { type: 'cancelled' } | { type: 'credential'; credential: Credential };

export type SignInProviderErrorCode = 'needs_dev_build' | 'not_configured' | 'no_token' | 'play_services' | 'failed';

/** A provider could not produce a credential. Carries a code only: never the token or the native error text. */
export class SignInProviderError extends Error {
  constructor(readonly code: SignInProviderErrorCode) {
    super(`sign-in provider error: ${code}`);
    this.name = 'SignInProviderError';
  }
}

export interface SignInProvider {
  id: string;
  /** Button text. */
  labelKey: MessageKey;
  start(): Promise<ProviderResult>;
  /** Forget the account on the device (so the next sign-in shows the account chooser). */
  signOut?(): Promise<void>;
}
