/**
 * Sign-in without Google, for development only: `POST /auth/dev` on a cloud run
 * locally with DEV_MODE (see cloud/README.md). Listed only when `config.devSignIn`
 * is true, which needs a dev bundle (`__DEV__`) and EXPO_PUBLIC_DEV_SIGNIN=1.
 * A release build never shows it, and the cloud refuses it outside localhost.
 */
import { config } from '@/config';
import type { SignInProvider } from './types';

export const devProvider: SignInProvider = {
  id: 'dev',
  labelKey: 'signIn.dev',
  async start() {
    return { type: 'credential', credential: { kind: 'dev-email', email: config.devEmail } };
  },
};
