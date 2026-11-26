import { Screen } from '@/components/Screen';
import { ComingSoon } from '@/components/States';
import { useT } from '@/i18n';

/** "Cần bạn": things waiting for the owner's approval. Needs the paired computer, so it is a placeholder for now. */
export default function AttentionScreen() {
  const t = useT();
  return (
    <Screen title={t('tabs.attention')} top>
      <ComingSoon title={t('tabs.attention')} body={t('coming.attention.body')} icon="notifications-outline" />
    </Screen>
  );
}
