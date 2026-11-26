/**
 * Google sign-in on the device, with @react-native-google-signin/google-signin
 * (its free "Original" module). The native module is loaded on first use, so
 * the app still starts in Expo Go and on the web, where it does not exist; the
 * button then reports "needs a development build".
 *
 * What goes where (details in mobile/README.md):
 *  - webClientId: the *web* OAuth client id. Required by the library to get an ID token at all.
 *  - iosClientId: the iOS OAuth client id (and its reversed form in app.config.ts as the URL scheme).
 *  - Android needs no id in code: the Android OAuth client is matched by package name + SHA-1.
 * The cloud checks the ID token's `aud` against GOOGLE_CLIENT_IDS, so that list
 * must contain whichever of those ids the token carries.
 * There is no client secret anywhere in the app.
 */
import { Platform } from 'react-native';
import { config } from '@/config';
import { SignInProviderError, type SignInProvider } from './types';

type GoogleModule = typeof import('@react-native-google-signin/google-signin');

let loaded: GoogleModule | null | undefined;
let configured = false;

function loadModule(): GoogleModule | null {
  if (loaded !== undefined) return loaded;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require('@react-native-google-signin/google-signin') as GoogleModule;
  } catch {
    loaded = null;
  }
  return loaded;
}

export const googleProvider: SignInProvider = {
  id: 'google',
  labelKey: 'signIn.google',

  async start() {
    if (!config.googleWebClientId) throw new SignInProviderError('not_configured');
    const g = loadModule();
    if (!g?.GoogleSignin) throw new SignInProviderError('needs_dev_build');
    try {
      if (!configured) {
        g.GoogleSignin.configure({
          webClientId: config.googleWebClientId,
          ...(Platform.OS === 'ios' && config.googleIosClientId ? { iosClientId: config.googleIosClientId } : {}),
        });
        configured = true;
      }
      await g.GoogleSignin.hasPlayServices();
      const response = await g.GoogleSignin.signIn();
      if (g.isCancelledResponse?.(response) || response.type === 'cancelled') return { type: 'cancelled' };
      const idToken = response.type === 'success' ? response.data.idToken : null;
      if (!idToken) throw new SignInProviderError('no_token');
      return { type: 'credential', credential: { kind: 'google-id-token', idToken } };
    } catch (e) {
      if (e instanceof SignInProviderError) throw e;
      const code = (e as { code?: unknown } | null)?.code;
      if (code === g.statusCodes?.SIGN_IN_CANCELLED) return { type: 'cancelled' };
      if (code === g.statusCodes?.PLAY_SERVICES_NOT_AVAILABLE) throw new SignInProviderError('play_services');
      // Do not forward the native error: its text can echo account details.
      throw new SignInProviderError('failed');
    }
  },

  async signOut() {
    try {
      await loadModule()?.GoogleSignin?.signOut();
    } catch {
      // Already signed out, or the module is absent: nothing to do.
    }
  },
};
