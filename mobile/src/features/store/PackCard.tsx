import { Pressable, StyleSheet, View } from 'react-native';
import type { PackListItem } from '../../../../packages/api-types/src/index';
import { Text } from '@/components/Text';
import { useI18n } from '@/i18n';
import { formatBytes } from '@/lib/format';
import { colors, radius } from '@/theme';
import { MODULE_LABEL } from './modules';

export function PackCard({ pack, onPress }: { pack: PackListItem; onPress: () => void }) {
  const { t, lang } = useI18n();
  const size = formatBytes(pack.latest.size, lang);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('store.openPack', { name: pack.name })}
      onPress={onPress}
      testID={`pack-${pack.id}`}
      style={({ pressed }) => [styles.card, pressed && { backgroundColor: colors.elevated }]}
    >
      <View style={styles.top}>
        <View style={styles.badge}><Text variant="caption" color="accentHover">{t(MODULE_LABEL[pack.module])}</Text></View>
        <Text variant="caption" color="textMuted">{[t('store.version', { version: pack.latest.version }), size].filter(Boolean).join(' · ')}</Text>
      </View>
      <Text variant="heading">{pack.name}</Text>
      {pack.summary ? <Text variant="small" color="textMuted" numberOfLines={2}>{pack.summary}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radius.xl, padding: 14, gap: 6, minHeight: 44 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  badge: { backgroundColor: colors.accentSoft, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 2 },
});
