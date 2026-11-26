import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import type { PackModule } from '../../../packages/api-types/src/index';
import { Chip } from '@/components/Chip';
import { Screen } from '@/components/Screen';
import { EmptyState, ErrorState, LoadingState } from '@/components/States';
import { useApi } from '@/auth/context';
import { MODULES, MODULE_LABEL } from '@/features/store/modules';
import { PackCard } from '@/features/store/PackCard';
import { useT } from '@/i18n';
import { useDebounced } from '@/lib/use-debounced';
import { MIN_TARGET, colors, fontFamily, radius } from '@/theme';

export default function StoreScreen() {
  const t = useT();
  const api = useApi();
  const router = useRouter();
  const [module, setModule] = useState<PackModule | undefined>(undefined);
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 300);

  const packs = useQuery({
    queryKey: ['packs', { module: module ?? null, q }],
    queryFn: ({ signal }) => api.listPacks({ module, q }, signal),
  });

  const filtered = !!module || !!q;
  const items = packs.data?.items ?? [];

  return (
    <Screen title={t('store.title')} top>
      <View style={styles.search}>
        <Ionicons name="search" size={18} color={colors.textMuted} accessible={false} />
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={t('store.searchPlaceholder')}
          placeholderTextColor={colors.textMuted}
          accessibilityLabel={t('store.searchLabel')}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          testID="search-input"
        />
        {text ? (
          <Pressable accessibilityRole="button" accessibilityLabel={t('store.clearSearch')} onPress={() => setText('')} style={styles.clear} testID="clear-search">
            <Ionicons name="close-circle" size={20} color={colors.textMuted} accessible={false} />
          </Pressable>
        ) : null}
      </View>

      <View accessibilityRole="radiogroup" accessibilityLabel={t('store.filterLabel')}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          <Chip role="radio" label={t('store.filterAll')} selected={!module} onPress={() => setModule(undefined)} testID="filter-all" />
          {MODULES.map((m) => (
            <Chip key={m} role="radio" label={t(MODULE_LABEL[m])} selected={module === m} onPress={() => setModule(m)} testID={`filter-${m}`} />
          ))}
        </ScrollView>
      </View>

      {packs.isPending ? (
        <LoadingState label={t('store.loading')} />
      ) : packs.isError ? (
        <ErrorState title={t('store.errorTitle')} error={packs.error} onRetry={() => void packs.refetch()} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(p) => p.id}
          renderItem={({ item }) => <PackCard pack={item} onPress={() => router.push(`/store/${encodeURIComponent(item.id)}`)} />}
          contentContainerStyle={items.length ? styles.list : styles.emptyList}
          ItemSeparatorComponent={Separator}
          refreshing={packs.isRefetching}
          onRefresh={() => void packs.refetch()}
          ListEmptyComponent={
            filtered
              ? <EmptyState title={t('store.emptyFilteredTitle')} body={t('store.emptyFilteredBody')} />
              : <EmptyState title={t('store.emptyTitle')} body={t('store.emptyBody')} />
          }
        />
      )}
    </Screen>
  );
}

const Separator = () => <View style={{ height: 10 }} />;

const styles = StyleSheet.create({
  search: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginBottom: 8,
    paddingLeft: 12, minHeight: MIN_TARGET, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.controlBorder, backgroundColor: colors.input,
  },
  input: { flex: 1, minHeight: MIN_TARGET, color: colors.text, fontSize: 15, fontFamily: fontFamily.regular },
  clear: { width: MIN_TARGET, height: MIN_TARGET, alignItems: 'center', justifyContent: 'center' },
  chips: { paddingHorizontal: 16, paddingBottom: 8, gap: 8 },
  list: { padding: 16 },
  emptyList: { flexGrow: 1 },
});
