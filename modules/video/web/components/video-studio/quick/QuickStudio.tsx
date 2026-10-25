// Video Studio › Dựng nhanh: Trang đầu → Thiết lập → Đang dựng. The screen and project live in the URL
// (?tab=quick&project=<id>&view=setup|progress); project state and SSE come from lib/video-edit/studio.
import { useEffect, useState } from 'preact/hooks';
import { ChevronLeft } from 'lucide-preact';
import {
  bootstrap, openProjectStream, profilesLoaded, project, projectLoading, selectedProjectId, selectProject,
} from '@modules/video/web/lib/video-edit/studio';
import { quickRoute, type QuickView } from '@modules/video/web/lib/video-edit/studio-tabs';
import { ProfileModal } from '../ProfileModal';
import { QuickHome } from './QuickHome';
import { QuickProgress } from './QuickProgress';
import { QuickSetup } from './QuickSetup';
import { loadTemplates } from './quick-state';
import '@modules/video/web/styles/video-studio.css';
import '@modules/video/web/styles/video-quick.css';

export function QuickStudio({ search, onNavigate, onOpenEditor }: {
  /** window.location.search as the page knows it. */
  search: string;
  onNavigate: (view: QuickView, projectId?: string) => void;
  onOpenEditor: (projectId: string) => void;
}) {
  const route = quickRoute(search);
  const wanted = route.projectId;
  const [missing, setMissing] = useState<string | null>(null);

  useEffect(() => { void bootstrap(); void loadTemplates(); }, []);

  // A reload or a shared link opens the project in the URL once the channel list is in.
  const loaded = profilesLoaded.value;
  useEffect(() => {
    if (!loaded || !wanted || selectedProjectId.value === wanted) return;
    void selectProject(wanted).then(() => { if (selectedProjectId.value !== wanted) setMissing(wanted); });
  }, [loaded, wanted]);

  const projectId = selectedProjectId.value;
  useEffect(() => (projectId ? openProjectStream(projectId) : undefined), [projectId]);

  /** A video from the list: Đang dựng once an AI edit was asked for, else Thiết lập. */
  const open = async (id: string) => {
    await selectProject(id);
    if (project.value?.id === id) onNavigate(project.value.quick || project.value.busy ? 'progress' : 'setup', id);
  };

  const p = project.value;
  let screen;
  if (route.view === 'home' || !wanted) {
    screen = <QuickHome onSetup={(id) => onNavigate('setup', id)} onOpen={(id) => void open(id)} />;
  } else if (p?.id !== wanted) {
    screen = missing === wanted && !projectLoading.value
      ? <div class="vs-dn-page"><div class="vs-dn-bar">
        <button type="button" class="vs-dn-back" onClick={() => onNavigate('home')}><ChevronLeft size={16} aria-hidden="true" /> Trang đầu</button>
      </div><p class="vs-muted vs-dn-pad" role="alert">Không mở được video này. Có thể nó đã bị xoá.</p></div>
      : <p class="vs-muted vs-dn-pad" role="status">Đang mở video…</p>;
  } else if (route.view === 'setup') {
    screen = <QuickSetup key={p.id} onHome={() => onNavigate('home')} onStarted={() => onNavigate('progress', p.id)} />;
  } else {
    screen = <QuickProgress onSetup={() => onNavigate('setup', p.id)} onOpenEditor={() => onOpenEditor(p.id)} />;
  }

  return <div class="vs-dn">
    {screen}
    <ProfileModal />
  </div>;
}
