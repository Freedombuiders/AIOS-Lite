import { Screen } from '@/components/Screen';
import { ComingSoon } from '@/components/States';
import { useT } from '@/i18n';

/** "Hộp thư": customer messages. Needs the paired computer, so it is a placeholder for now. */
export default function InboxScreen() {
  const t = useT();
  return (
    <Screen title={t('tabs.inbox')} top>
      <ComingSoon title={t('tabs.inbox')} body={t('coming.inbox.body')} icon="chatbubbles-outline" />
    </Screen>
  );
}
