import { useLocation, useSearch } from 'wouter-preact';
import { Tab } from '@/components/PageHeader';
import { FbChannel } from '@modules/marketing/web/pages/fb/FbChannel';
import { FbPosts } from '@modules/marketing/web/pages/fb/FbPosts';

const TABS = [
  { id: 'channel', label: 'Hiệu quả kênh' },
  { id: 'posts', label: 'Bài đã đăng' },
] as const;

/** Phân tích: the Facebook channel and posts screens as two tabs of one page (?tab=posts). */
export function Analytics() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const tab = TABS.find((t) => t.id === new URLSearchParams(search).get('tab'))?.id ?? 'channel';
  const tabs = (
    <>
      {TABS.map((t) => (
        <Tab key={t.id} label={t.label} active={tab === t.id} onClick={() => navigate(t.id === 'channel' ? '/m/marketing/analytics' : `/m/marketing/analytics?tab=${t.id}`)} />
      ))}
    </>
  );
  return tab === 'posts' ? <FbPosts tabs={tabs} /> : <FbChannel tabs={tabs} />;
}
