/**
 * /video-studio — the agentic content production hub.
 *   Studio           one workspace: video list · canvas (Phân cảnh ⇄ Xem thử ⇄ Hoàn thiện) · Đạo diễn AI
 *   Video quay sẵn   the HyperFrames editor for recorded footage
 *   Kết nối          engines, HeyGen voice and brand kit per KOL, RocketFlow
 * KOL Studio creates and trains the characters; this page makes the videos.
 */
import { useEffect, useState } from 'preact/hooks';

import { PageHeader, Tab } from '@/components/PageHeader';
import { SetupNotice } from '@modules/video/web/components/video-studio/SetupNotice';
import { StudioShell } from '@modules/video/web/components/video-studio/StudioShell';
import { ConnectionsStudio } from '@modules/video/web/components/video-studio/production/ProductionStudio';
import { StudioWorkspace } from '@modules/video/web/components/video-studio/studio/StudioWorkspace';
import { studioTab, studioTabUrl, type StudioTab } from '@modules/video/web/lib/video-edit/studio-tabs';

const tabFromUrl = () => studioTab(window.location.search);

export function VideoStudio() {
  const [tab, setTab] = useState<StudioTab>(tabFromUrl);
  useEffect(() => {
    const sync = () => setTab(tabFromUrl());
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  const choose = (next: StudioTab, projectId?: string) => {
    window.history.pushState(window.history.state, '', studioTabUrl(window.location.href, next, projectId));
    setTab(next);
  };
  return (
    <div class="flex flex-col h-full min-h-0">
      <PageHeader
        compact
        title="AI Video Studio"
        tabs={<>
          <Tab label="Studio" active={tab === 'produce'} onClick={() => choose('produce')} />
          <Tab label="Video quay sẵn" active={tab === 'edit'} onClick={() => choose('edit')} />
          <Tab label="Kết nối" active={tab === 'connect'} onClick={() => choose('connect')} />
        </>}
      />
      <SetupNotice />
      {tab === 'produce' && <StudioWorkspace onConnections={() => choose('connect')} onFootage={(id) => choose('edit', id)} />}
      {tab === 'edit' && <StudioShell />}
      {tab === 'connect' && <ConnectionsStudio />}
    </div>
  );
}
