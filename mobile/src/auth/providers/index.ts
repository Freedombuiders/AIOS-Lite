import { config } from '@/config';
import { devProvider } from './dev';
import { googleProvider } from './google';
import type { SignInProvider } from './types';

/** The sign-in buttons, in order. Add a provider here and the sign-in screen shows it. */
export function enabledProviders(): SignInProvider[] {
  return [googleProvider, ...(config.devSignIn ? [devProvider] : [])];
}

export * from './types';
