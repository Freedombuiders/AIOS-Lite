/**
 * /video-studio — the agentic content production hub.
 *   Studio           one workspace: video list · canvas (Phân cảnh ⇄ Xem thử ⇄ Hoàn thiện) · Đạo diễn AI
 *   Video quay sẵn   the HyperFrames editor for recorded footage
 *   Dựng nhanh       raw footage + an edit template → AI edit → hand edits (Trang đầu, Thiết lập, Đang dựng)
 *   Kết nối          engines, HeyGen voice and brand kit per KOL, RocketFlow
 * KOL Studio creates and trains the characters; this page makes the videos.
 */
import { useEffect, useState } from 'preact/hooks';

import { PageHeader, Tab } from '@/components/PageHeader';
import { SetupNotice } from '@modules/video/web/components/video-studio/SetupNotice';
import { StudioShell } from '@modules/video/web/components/video-studio/StudioShell';
import { ConnectionsStudio } from '@modules/video/web/components/video-studio/production/ProductionStudio';
import { QuickStudio } from '@modules/video/web/components/video-studio/quick/QuickStudio';
import { StudioWorkspace } from '@modules/video/web/components/video-studio/studio/StudioWorkspace';
import { studioTab, studioTabUrl, type QuickView, type StudioTab } from '@modules/video/web/lib/video-edit/studio-tabs';

export function VideoStudio() {
  // The query string as of the last tab or Dựng nhanh navigation (and browser back/forward).
  const [search, setSearch] = useState(() => window.location.search);
  const tab = studioTab(search);
  useEffect(() => {
    const sync = () => setSearch(window.location.search);
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  const choose = (next: StudioTab, projectId?: string, view?: QuickView) => {
    window.history.pushState(window.history.state, '', studioTabUrl(window.location.href, next, projectId, view));
    setSearch(window.location.search);
  };
  return (
    <div class="flex flex-col h-full min-h-0">
      <PageHeader
        compact
        title="AI Video Studio"
        tabs={<>
          <Tab label="Studio" active={tab === 'produce'} onClick={() => choose('produce')} />
          <Tab label="Video quay sẵn" active={tab === 'edit'} onClick={() => choose('edit')} />
          <Tab label="Dựng nhanh" active={tab === 'quick'} onClick={() => choose('quick')} />
          <Tab label="Kết nối" active={tab === 'connect'} onClick={() => choose('connect')} />
        </>}
      />
      <SetupNotice />
      {tab === 'produce' && <StudioWorkspace onConnections={() => choose('connect')} onFootage={(id) => choose('edit', id)} />}
      {tab === 'edit' && <StudioShell />}
      {tab === 'quick' && <QuickStudio search={search} onNavigate={(view, id) => choose('quick', id, view)} onOpenEditor={(id) => choose('edit', id)} />}
      {tab === 'connect' && <ConnectionsStudio />}
    </div>
  );
}
