import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { ApiSession } from '../../../packages/api-types/src/index';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { ConfirmModal } from '@/components/ConfirmModal';
import { Screen } from '@/components/Screen';
import { ErrorState, LoadingState } from '@/components/States';
import { Text } from '@/components/Text';
import { useApi, useAuthState, useAuthStore } from '@/auth/context';
import { errorMessageKey } from '@/api/errors';
import { LANGS, useI18n, type Lang } from '@/i18n';
import { formatDate } from '@/lib/format';
import { colors, radius } from '@/theme';

export default function SettingsScreen() {
  const { t, lang, setLang } = useI18n();
  const api = useApi();
  const store = useAuthStore();
  const auth = useAuthState();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const me = useQuery({ queryKey: ['me'], queryFn: ({ signal }) => api.me(signal) });
  const user = me.data?.user ?? (auth.status === 'signedIn' ? auth.user : null);

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeSession(id),
    onMutate: () => setRevokeError(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
    onError: (e) => setRevokeError(t(errorMessageKey(e))),
  });

  const remove = useMutation({
    mutationFn: () => store.deleteAccount(),
    onMutate: () => setDeleteError(null),
    onError: (e) => setDeleteError(`${t('settings.deleteFailed')} ${t(errorMessageKey(e))}`),
  });

  const langLabel: Record<Lang, string> = { vi: t('settings.languageVi'), en: t('settings.languageEn') };
  const version = Constants.expoConfig?.version ?? '0.1.0';

  return (
    <Screen title={t('settings.title')} top>
      <ScrollView contentContainerStyle={styles.content}>
        <Section title={t('settings.account')}>
          <View style={styles.account} testID="account-info">
            <View style={styles.avatar} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <Text variant="heading">{(user?.name ?? user?.email ?? '?').slice(0, 1).toUpperCase()}</Text>
            </View>
            <View style={styles.flex}>
              <Text variant="heading" testID="account-name">{user?.name ?? t('settings.noName')}</Text>
              <Text color="textMuted" testID="account-email">{user?.email ?? ''}</Text>
              {user?.role === 'admin' ? <Text variant="caption" color="warning">{t('settings.admin')}</Text> : null}
            </View>
          </View>
        </Section>

        <Section title={t('settings.language')}>
          <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={t('settings.language')}>
            {LANGS.map((l) => (
              <Chip key={l} role="radio" label={langLabel[l]} selected={lang === l} onPress={() => setLang(l)} testID={`lang-${l}`} />
            ))}
          </View>
        </Section>

        <Section title={t('settings.sessions')}>
          <Text variant="small" color="textMuted">{t('settings.sessionsHint')}</Text>
          {me.isPending ? (
            <LoadingState />
          ) : me.isError ? (
            <ErrorState title={t('settings.sessionsError')} error={me.error} onRetry={() => void me.refetch()} />
          ) : me.data.sessions.length === 0 ? (
            <Text color="textMuted">{t('settings.sessionsEmpty')}</Text>
          ) : (
            me.data.sessions.map((s) => (
              <SessionRow key={s.id} session={s} busy={revoke.isPending && revoke.variables === s.id} onRevoke={() => revoke.mutate(s.id)} />
            ))
          )}
          {revokeError ? <Text color="danger" accessibilityRole="alert" testID="revoke-error">{`${t('settings.revokeFailed')} ${revokeError}`}</Text> : null}
        </Section>

        <Section title={t('settings.about')}>
          <Text color="textMuted">{t('settings.version', { version })}</Text>
        </Section>

        <Button label={t('settings.signOut')} variant="secondary" onPress={() => void store.signOut()} testID="sign-out" />

        <Section title={t('settings.danger')}>
          <Button label={t('settings.deleteAccount')} variant="danger" onPress={() => { setDeleteError(null); setConfirming(true); }} testID="delete-account" />
        </Section>
      </ScrollView>

      <ConfirmModal
        visible={confirming}
        title={t('settings.deleteTitle')}
        body={t('settings.deleteBody')}
        confirmLabel={remove.isPending ? t('settings.deleteBusy') : t('settings.deleteConfirm')}
        cancelLabel={t('common.cancel')}
        busy={remove.isPending}
        error={deleteError}
        onCancel={() => setConfirming(false)}
        onConfirm={() => remove.mutate()}
      />
    </Screen>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text variant="caption" color="textMuted" accessibilityRole="header" style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      {children}
    </View>
  );
}

function SessionRow({ session, busy, onRevoke }: { session: ApiSession; busy: boolean; onRevoke: () => void }) {
  const { t, lang } = useI18n();
  const kind = { mobile: t('settings.sessionKindMobile'), machine: t('settings.sessionKindMachine'), web: t('settings.sessionKindWeb') }[session.kind];
  const name = session.label ?? kind;
  return (
    <View style={styles.session} testID={`session-${session.id}`}>
      <View style={styles.flex}>
        <Text weight="medium">{name}{session.current ? ` · ${t('settings.sessionThis')}` : ''}</Text>
        <Text variant="caption" color="textMuted">{`${kind} · ${t('settings.sessionSince', { date: formatDate(session.createdAt, lang) })} · ${t('settings.sessionExpires', { date: formatDate(session.expiresAt, lang) })}`}</Text>
      </View>
      {session.current ? null : (
        <Button label={t('settings.revoke')} accessibilityLabel={t('settings.revokeLabel', { name })} variant="secondary" loading={busy} onPress={onRevoke} testID={`revoke-${session.id}`} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 20, paddingBottom: 40 },
  flex: { flex: 1 },
  section: { gap: 10 },
  sectionTitle: { letterSpacing: 0.8 },
  account: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radius.xl, padding: 14 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  session: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radius.lg, padding: 12 },
});
