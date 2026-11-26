import { useQuery } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import { FlatList, StyleSheet, View } from 'react-native';
import type { PackDetail, PackFile } from '../../../packages/api-types/src/index';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { ErrorState, LoadingState } from '@/components/States';
import { Text } from '@/components/Text';
import { useApi } from '@/auth/context';
import { MODULE_LABEL } from '@/features/store/modules';
import { useI18n } from '@/i18n';
import { formatBytes } from '@/lib/format';
import { colors, fontFamily, radius } from '@/theme';

export default function PackScreen() {
  const { t } = useI18n();
  const api = useApi();
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  const pack = useQuery({
    queryKey: ['pack', id],
    queryFn: ({ signal }) => api.getPack(id, signal),
    enabled: !!id,
  });

  return (
    <Screen>
      <Stack.Screen options={{ title: pack.data?.name ?? t('pack.title') }} />
      {pack.isPending ? (
        <LoadingState />
      ) : pack.isError ? (
        <ErrorState title={t('pack.errorTitle')} error={pack.error} onRetry={() => void pack.refetch()} />
      ) : (
        <PackBody pack={pack.data} />
      )}
    </Screen>
  );
}

function PackBody({ pack }: { pack: PackDetail }) {
  const { t, lang } = useI18n();
  const latest = pack.latest;
  const license = pack.license ?? latest?.license ?? null;
  const author = pack.author ?? latest?.author ?? null;
  const rows: [string, string | null][] = [
    [t('pack.latestVersion'), latest?.version ?? null],
    [t('pack.size'), formatBytes(latest?.size, lang)],
    [t('pack.license'), license],
    [t('pack.author'), author],
    [t('pack.industry'), pack.industry],
    [t('pack.notes'), latest?.notesCount != null ? String(latest.notesCount) : null],
  ];

  return (
    <FlatList<PackFile>
      data={pack.files}
      keyExtractor={(f) => f.path}
      contentContainerStyle={styles.content}
      renderItem={({ item }) => <FileRow file={item} />}
      ItemSeparatorComponent={() => <View style={styles.sep} />}
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.badge}><Text variant="caption" color="accentHover">{t(MODULE_LABEL[pack.module])}</Text></View>
          <Text variant="title" accessibilityRole="header">{pack.name}</Text>
          <Text color={pack.summary ? 'text' : 'textMuted'}>{pack.summary ?? t('pack.noSummary')}</Text>

          {latest ? (
            <View style={styles.facts} testID="pack-facts">
              {rows.map(([label, value]) => (
                <View key={label} style={styles.fact} accessible accessibilityLabel={`${label}: ${value ?? t('common.unknown')}`}>
                  <Text variant="small" color="textMuted">{label}</Text>
                  <Text variant="small" weight="medium" style={styles.factValue}>{value ?? t('common.unknown')}</Text>
                </View>
              ))}
            </View>
          ) : (
            <Text color="warning" testID="no-release">{t('pack.noRelease')}</Text>
          )}

          <Button label={t('pack.install')} disabled accessibilityHint={t('pack.installComing')} testID="install-button" />
          <View style={styles.notice} testID="install-coming">
            <Text variant="small" color="textMuted">{t('pack.installComing')}</Text>
          </View>

          <Text variant="heading" accessibilityRole="header" style={styles.filesTitle}>{t('pack.files', { count: pack.files.length })}</Text>
        </View>
      }
      ListEmptyComponent={<Text color="textMuted" variant="small">{t('pack.filesEmpty')}</Text>}
    />
  );
}

function FileRow({ file }: { file: PackFile }) {
  return (
    <View style={styles.file} accessible accessibilityLabel={file.loai ? `${file.path}, ${file.loai}` : file.path}>
      <Text variant="small" style={styles.path}>{file.path}</Text>
      {file.loai ? <Text variant="caption" color="textMuted">{file.loai}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40 },
  header: { gap: 12 },
  badge: { alignSelf: 'flex-start', backgroundColor: colors.accentSoft, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 2 },
  facts: { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radius.xl, paddingHorizontal: 14, paddingVertical: 4 },
  fact: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, minHeight: 40, alignItems: 'center' },
  factValue: { flexShrink: 1, textAlign: 'right' },
  notice: { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radius.lg, padding: 12 },
  filesTitle: { marginTop: 12 },
  file: { minHeight: 44, justifyContent: 'center', paddingVertical: 6, gap: 2 },
  path: { fontFamily: fontFamily.regular },
  sep: { height: 1, backgroundColor: colors.border },
});
