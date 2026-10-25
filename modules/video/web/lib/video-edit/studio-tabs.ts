/**
 * Video Studio tabs, kept in the URL:
 *   produce  Studio (default): agentic production workspace (?p=<production>&v=board|preview|finish)
 *   edit     Video quay sẵn: the HyperFrames editor for recorded footage
 *   quick    Dựng nhanh: raw footage → template → AI edit (?tab=quick&project=<id>&view=setup|progress|editor)
 *   connect  Kết nối: engines, HeyGen voice and brand kit per KOL, RocketFlow
 * Old links keep working: ?tab=create / ?tab=flow open Studio, and an editor link
 * (?project=…) without a tab opens Video quay sẵn.
 */
export type StudioTab = 'produce' | 'edit' | 'quick' | 'connect';
/** Dựng nhanh screens: Trang đầu, Thiết lập, Đang dựng, Editor v2. */
export type QuickView = 'home' | 'setup' | 'progress' | 'editor';

export function studioTab(search: string): StudioTab {
  const q = new URLSearchParams(search);
  const tab = q.get('tab') || '';
  if (tab === 'edit') return 'edit';
  if (tab === 'quick') return 'quick';
  if (tab === 'connect') return 'connect';
  if (['produce', 'create', 'flow', 'studio'].includes(tab)) return 'produce';
  return q.has('project') ? 'edit' : 'produce';
}

/** The Dựng nhanh screen in the URL; setup, progress and editor need a project, else Trang đầu. */
export function quickRoute(search: string): { view: QuickView; projectId: string | null } {
  const q = new URLSearchParams(search);
  const projectId = q.get('project');
  const view = q.get('view');
  if (projectId && (view === 'setup' || view === 'progress' || view === 'editor')) return { view, projectId };
  return { view: 'home', projectId: null };
}

export function studioTabUrl(href: string, tab: StudioTab, projectId?: string, view?: QuickView): string {
  const url = new URL(href);
  // view=editor is Editor v2 on Dựng nhanh but the old editor on Video quay sẵn.
  const fromQuick = url.searchParams.get('tab') === 'quick';
  if (tab === 'produce') {
    url.searchParams.delete('tab');
    url.searchParams.delete('project');
    url.searchParams.delete('view');
  } else {
    url.searchParams.set('tab', tab);
    url.searchParams.delete('p');
    url.searchParams.delete('v');
    // A Dựng nhanh screen means nothing on another tab, and an editor link nothing on Dựng nhanh.
    const current = url.searchParams.get('view');
    const quickScreen = current === 'setup' || current === 'progress' || (fromQuick && current === 'editor');
    if (tab === 'quick' ? !quickScreen : quickScreen) { url.searchParams.delete('project'); url.searchParams.delete('view'); }
    if (tab === 'edit' && projectId) { url.searchParams.set('project', projectId); url.searchParams.set('view', 'editor'); }
    if (tab === 'quick') {
      if (projectId && view && view !== 'home') { url.searchParams.set('project', projectId); url.searchParams.set('view', view); }
      else { url.searchParams.delete('project'); url.searchParams.delete('view'); }
    }
  }
  return url.toString();
}
