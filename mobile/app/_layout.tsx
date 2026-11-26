import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Stack, usePathname, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuthState, useAuthStore } from '@/auth/context';
import { Button } from '@/components/Button';
import { LoadingState } from '@/components/States';
import { Text } from '@/components/Text';
import { I18nProvider, useT } from '@/i18n';
import { colors, fontFamily, fontFiles } from '@/theme';

void SplashScreen.preventAutoHideAsync();

function makeQueryClient() {
  // In memory only (nothing persisted to the phone). No automatic retries: a failure shows its
  // state with a retry button instead of spinning. `networkMode: 'always'` so an offline phone
  // gets a fetch error to show, not a paused query.
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, networkMode: 'always', staleTime: 60_000, refetchOnWindowFocus: false },
      mutations: { networkMode: 'always' },
    },
  });
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(fontFiles);
  const queryClient = useMemo(makeQueryClient, []);
  return (
    <SafeAreaProvider>
      <I18nProvider>
        <AuthProvider>
          <QueryClientProvider client={queryClient}>
            <StatusBar style="light" />
            <Gate fontsReady={fontsLoaded || !!fontError} queryClient={queryClient} />
          </QueryClientProvider>
        </AuthProvider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}

/** Reads the stored session once, then shows either the sign-in screen or the app. */
function Gate({ fontsReady, queryClient }: { fontsReady: boolean; queryClient: QueryClient }) {
  const t = useT();
  const store = useAuthStore();
  const auth = useAuthState();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => { void store.bootstrap(); }, [store]);

  useEffect(() => {
    if (fontsReady && auth.status !== 'loading') void SplashScreen.hideAsync();
  }, [fontsReady, auth.status]);

  // Keep the current screen so a 401 can bring the user back to it, and drop cached data on sign-out.
  useEffect(() => {
    if (auth.status === 'signedIn') store.rememberRoute(pathname);
  }, [auth.status, pathname, store]);
  useEffect(() => {
    if (auth.status === 'signedOut') queryClient.clear();
  }, [auth.status, queryClient]);
  // After a 401 and a fresh sign-in, go back to the screen the user was on. The signed-in navigator
  // mounts on its default route first, so wait for the pathname to settle: go back only from the
  // default route, and stop as soon as the user is there or has gone somewhere else.
  useEffect(() => {
    if (auth.status !== 'signedIn') return;
    const back = store.peekReturnTo();
    if (!back || pathname === '/sign-in') return;
    if (pathname === '/' && back !== '/') router.replace(back as never);
    else store.takeReturnTo();
  }, [auth.status, pathname, router, store]);

  if (!fontsReady || auth.status === 'loading') return <LoadingState label={t('boot.checking')} testID="boot-loading" />;

  if (auth.status === 'unreachable') {
    return (
      <View style={styles.boot} testID="boot-unreachable">
        <Text variant="heading" style={styles.center}>{t('boot.unreachable')}</Text>
        <Button label={t('common.retry')} onPress={() => void store.bootstrap()} />
        <Button label={t('boot.signOut')} variant="ghost" onPress={() => void store.signOut()} />
      </View>
    );
  }

  const signedIn = auth.status === 'signedIn';
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.sidebar },
        headerTintColor: colors.text,
        headerTitleStyle: { fontFamily: fontFamily.semibold, color: colors.text },
        headerBackTitle: t('common.back'),
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="(auth)/sign-in" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="store/[id]" options={{ title: t('pack.title') }} />
      </Stack.Protected>
    </Stack>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  center: { textAlign: 'center' },
});
