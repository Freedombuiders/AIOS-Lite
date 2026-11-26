/**
 * Build-time settings, read from EXPO_PUBLIC_* variables (Metro inlines them).
 * None of them is a secret: client ids are public by design, and the app never
 * holds a client secret.
 */
const env = process.env;

export interface AppConfig {
  /** Base URL of agenticos-cloud, no trailing slash. */
  cloudUrl: string;
  /** Web-type OAuth client id. Its `aud` goes on the cloud's allow list; see mobile/README.md. */
  googleWebClientId: string;
  /** iOS-type OAuth client id (also needed by app.config.ts for the URL scheme). */
  googleIosClientId: string;
  /** Show the "dev sign-in" button. Only ever true in a dev bundle, and the cloud only honours it from localhost. */
  devSignIn: boolean;
  devEmail: string;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

export function readConfig(vars: Record<string, string | undefined>, isDev: boolean): AppConfig {
  return {
    cloudUrl: trimSlash(vars.EXPO_PUBLIC_CLOUD_URL?.trim() || (isDev ? 'http://localhost:8787' : '')),
    googleWebClientId: vars.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?.trim() ?? '',
    googleIosClientId: vars.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim() ?? '',
    devSignIn: isDev && vars.EXPO_PUBLIC_DEV_SIGNIN === '1',
    devEmail: vars.EXPO_PUBLIC_DEV_EMAIL?.trim() || 'dev@example.com',
  };
}

// Metro replaces `process.env.EXPO_PUBLIC_X` only when written out in full, so name each one here.
export const config: AppConfig = readConfig(
  {
    EXPO_PUBLIC_CLOUD_URL: env.EXPO_PUBLIC_CLOUD_URL,
    EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
    EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
    EXPO_PUBLIC_DEV_SIGNIN: env.EXPO_PUBLIC_DEV_SIGNIN,
    EXPO_PUBLIC_DEV_EMAIL: env.EXPO_PUBLIC_DEV_EMAIL,
  },
  __DEV__,
);
