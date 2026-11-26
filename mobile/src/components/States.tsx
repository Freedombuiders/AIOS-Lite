import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { errorMessageKey } from '@/api/errors';
import { useT } from '@/i18n';
import { colors } from '@/theme';
import { Button } from './Button';
import { Text } from './Text';

export function LoadingState({ label, testID }: { label?: string; testID?: string }) {
  const t = useT();
  const text = label ?? t('common.loading');
  return (
    <View style={styles.center} accessibilityRole="progressbar" accessibilityLabel={text} accessibilityLiveRegion="polite" testID={testID ?? 'loading'}>
      <ActivityIndicator color={colors.accent} size="large" />
      <Text color="textMuted" style={styles.text}>{text}</Text>
    </View>
  );
}

/** A failed load: what happened in words (offline and timeout say so), and a way to try again. */
export function ErrorState({ title, error, onRetry, testID }: { title: string; error: unknown; onRetry?: () => void; testID?: string }) {
  const t = useT();
  return (
    <View style={styles.center} accessibilityRole="alert" testID={testID ?? 'error'}>
      <Ionicons name="cloud-offline-outline" size={36} color={colors.textMuted} accessible={false} />
      <Text variant="heading" style={styles.text}>{title}</Text>
      <Text color="textMuted" style={styles.text}>{t(errorMessageKey(error))}</Text>
      {onRetry ? <Button label={t('common.retry')} variant="secondary" onPress={onRetry} testID="retry" /> : null}
    </View>
  );
}

export function EmptyState({ title, body, testID }: { title: string; body?: string; testID?: string }) {
  return (
    <View style={styles.center} testID={testID ?? 'empty'}>
      <Ionicons name="file-tray-outline" size={36} color={colors.textMuted} accessible={false} />
      <Text variant="heading" style={styles.text}>{title}</Text>
      {body ? <Text color="textMuted" style={styles.text}>{body}</Text> : null}
    </View>
  );
}

/** For tabs that exist but are not built yet: honest about it. */
export function ComingSoon({ title, body, icon }: { title: string; body: string; icon: keyof typeof Ionicons.glyphMap }) {
  const t = useT();
  return (
    <View style={styles.center} testID="coming-soon">
      <Ionicons name={icon} size={40} color={colors.accent} accessible={false} />
      <Text variant="heading" style={styles.text}>{title}</Text>
      <View style={styles.badge}><Text variant="caption" color="warning">{t('coming.title')}</Text></View>
      <Text color="textMuted" style={styles.text}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  text: { textAlign: 'center' },
  badge: { paddingHorizontal: 10, paddingVertical: 2, borderRadius: 999, backgroundColor: 'rgba(240,178,74,0.16)' },
});
