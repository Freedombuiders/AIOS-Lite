/**
 * Video Studio tabs, kept in the URL:
 *   produce  Studio (default): agentic production workspace (?p=<production>&v=board|preview|finish)
 *   edit     Video quay sẵn: the HyperFrames editor for recorded footage
 *   connect  Kết nối: engines, HeyGen voice and brand kit per KOL, RocketFlow
 * Old links keep working: ?tab=create / ?tab=flow open Studio, and an editor link
 * (?project=…) without a tab opens Video quay sẵn.
 */
export type StudioTab = 'produce' | 'edit' | 'connect';

export function studioTab(search: string): StudioTab {
  const q = new URLSearchParams(search);
  const tab = q.get('tab') || '';
  if (tab === 'edit') return 'edit';
  if (tab === 'connect') return 'connect';
  if (['produce', 'create', 'flow', 'studio'].includes(tab)) return 'produce';
  return q.has('project') ? 'edit' : 'produce';
}

export function studioTabUrl(href: string, tab: StudioTab, projectId?: string): string {
  const url = new URL(href);
  if (tab === 'produce') {
    url.searchParams.delete('tab');
    url.searchParams.delete('project');
    url.searchParams.delete('view');
  } else {
    url.searchParams.set('tab', tab);
    url.searchParams.delete('p');
    url.searchParams.delete('v');
    if (tab === 'edit' && projectId) { url.searchParams.set('project', projectId); url.searchParams.set('view', 'editor'); }
  }
  return url.toString();
}
