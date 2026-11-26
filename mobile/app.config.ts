import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * No secrets here. The OAuth client ids are public values; the app never holds a client secret.
 * Set EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID before an iOS build: the Google SDK needs its reversed form
 * as a URL scheme. See mobile/README.md for which client id goes where.
 */
const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim() ?? '';
// "123-abc.apps.googleusercontent.com" -> "com.googleusercontent.apps.123-abc"
const iosUrlScheme = iosClientId.endsWith('.apps.googleusercontent.com')
  ? `com.googleusercontent.apps.${iosClientId.slice(0, -'.apps.googleusercontent.com'.length)}`
  : 'com.googleusercontent.apps.REPLACE-WITH-IOS-CLIENT-ID';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Open AgenticOS',
  slug: 'agenticos-mobile',
  scheme: 'agenticos',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'dark',
  backgroundColor: '#0f1115',
  icon: './assets/images/icon.png',
  ios: {
    // Placeholder ids: pick the final ones BEFORE creating the Google OAuth clients, they are bound to them.
    bundleIdentifier: 'app.agenticos.mobile',
    supportsTablet: false,
  },
  android: {
    package: 'app.agenticos.mobile',
    adaptiveIcon: {
      foregroundImage: './assets/images/adaptive-icon.png',
      backgroundColor: '#0f1115',
    },
  },
  web: { bundler: 'metro', output: 'single', favicon: './assets/images/icon.png' },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-font',
    ['expo-splash-screen', { backgroundColor: '#0f1115', image: './assets/images/splash-icon.png', imageWidth: 160 }],
    ['@react-native-google-signin/google-signin', { iosUrlScheme }],
  ],
  experiments: { reactCompiler: false },
});
