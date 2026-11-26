import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { errorMessageKey, isCloudError } from '@/api/errors';
import { useAuthState, useAuthStore } from '@/auth/context';
import { SignInProviderError, type SignInProvider } from '@/auth/providers';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Text } from '@/components/Text';
import { config } from '@/config';
import { LANGS, useI18n, type MessageKey } from '@/i18n';
import { colors, radius } from '@/theme';

function messageFor(error: unknown): MessageKey {
  if (error instanceof SignInProviderError) {
    switch (error.code) {
      case 'needs_dev_build': return 'signIn.needsDevBuild';
      case 'not_configured': return 'signIn.notConfigured';
      case 'no_token': return 'signIn.noToken';
      case 'play_services': return 'signIn.playServices';
      default: return 'errors.generic';
    }
  }
  if (isCloudError(error)) {
    if (error.kind === 'disabled') return 'signIn.disabled';
    if (error.kind === 'credentials') return 'signIn.credentials';
  }
  return errorMessageKey(error);
}

export default function SignInScreen() {
  const { t, lang, setLang } = useI18n();
  const store = useAuthStore();
  const providers = store.providers;
  const auth = useAuthState();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);

  async function run(provider: SignInProvider) {
    setBusy(provider.id);
    setError(null);
    const outcome = await store.signIn(provider);
    setBusy(null);
    if (outcome.type === 'error') setError(messageFor(outcome.error));
    // On success the root layout's guard sends the user into the app; nothing to do here.
  }

  const expired = auth.status === 'signedOut' && auth.notice === 'expired';

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.logo} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Ionicons name="sparkles" size={30} color={colors.onAccent} />
      </View>
      <Text variant="title" accessibilityRole="header">{t('app.name')}</Text>
      <Text color="textMuted">{t('signIn.subtitle')}</Text>

      {expired && !error ? (
        <View style={[styles.banner, styles.warn]} accessibilityRole="alert" testID="notice-expired">
          <Text variant="small">{t('signIn.expired')}</Text>
        </View>
      ) : null}
      {error ? (
        <View style={[styles.banner, styles.bad]} accessibilityRole="alert" testID="sign-in-error">
          <Text variant="small">{t(error)}</Text>
        </View>
      ) : null}
      {!config.cloudUrl ? (
        <View style={[styles.banner, styles.bad]} accessibilityRole="alert" testID="not-configured">
          <Text variant="small">{t('errors.notConfigured')}</Text>
        </View>
      ) : null}

      <View style={styles.buttons}>
        {providers.map((p, i) => (
          <Button
            key={p.id}
            label={busy === p.id ? t('signIn.busy') : t(p.labelKey)}
            variant={i === 0 ? 'primary' : 'secondary'}
            loading={busy === p.id}
            disabled={busy !== null && busy !== p.id}
            onPress={() => void run(p)}
            testID={`sign-in-${p.id}`}
          />
        ))}
      </View>

      <Text variant="small" color="textMuted">{t('signIn.privacy')}</Text>

      <View accessibilityRole="radiogroup" accessibilityLabel={t('signIn.language')} style={styles.langs}>
        {LANGS.map((l) => (
          <Chip key={l} role="radio" label={l === 'vi' ? 'Tiếng Việt' : 'English'} selected={lang === l} onPress={() => setLang(l)} testID={`lang-${l}`} />
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 24, gap: 14 },
  logo: { width: 56, height: 56, borderRadius: radius.xl, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  buttons: { gap: 10, marginTop: 10 },
  banner: { borderRadius: radius.lg, padding: 12, borderWidth: 1 },
  warn: { borderColor: colors.warning, backgroundColor: 'rgba(240,178,74,0.12)' },
  bad: { borderColor: colors.danger, backgroundColor: 'rgba(240,100,122,0.12)' },
  langs: { flexDirection: 'row', gap: 8, marginTop: 8 },
});
