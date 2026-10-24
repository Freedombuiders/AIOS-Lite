import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mod from './index';
import { VideoStudio } from './pages/VideoStudio';

const styles = [{ id: 'kienthuc', command: '/kienthuc', name: 'Kiến thức nhanh', group: 'teach', description: '', bestFor: '', palette: { bg: '#000', text: '#fff', highlight: '#ff0' }, fontHeading: 'Anton', captionStyle: 'x', cutPace: 'fast', sfxDensity: 'low', musicMoods: [], promptNotes: '' }];

function api(url: string): unknown {
  const path = new URL(url, 'http://localhost').pathname.replace('/api/m/video', '');
  if (path === '/edit/profiles') return { profiles: [] };
  if (path === '/edit/projects') return { projects: [] };
  if (path === '/edit/productions') return { productions: [] };
  if (path === '/edit/agents') return { agents: [{ id: 'main', name: 'main', provider: 'claude', engineLabel: 'Claude', isDefault: true }], defaultAgentId: 'main' };
  if (path === '/edit/styles') return { groups: [{ id: 'teach', label: 'Dạy & kiến thức' }], styles };
  if (path === '/edit/doctor') return { checks: [{ id: 'ffmpeg', label: 'ffmpeg', required: true, ok: false, detail: 'chưa cài', fix: 'brew install ffmpeg' }], ok: 0, total: 1, requiredOk: false };
  if (path === '/edit/brains') return { enabled: true, activeVaultId: 'default', vaults: [{ id: 'default', name: 'Kho tri thức' }] };
  if (path.startsWith('/edit/assets')) return { kinds: [], assets: [] };
  if (path === '/edit/creation/projects') return { projects: [] };
  if (path === '/health') return { ffmpeg: false, ffprobe: false, hint: 'Chưa cài ffmpeg. Mở Terminal và chạy: brew install ffmpeg', kol: false };
  if (path === '/studio/jobs') return { jobs: [] };
  if (path === '/studio/connection') return { mode: 'local-auto', grants: {} };
  return {};
}

let host: HTMLElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(api(String(url))), { status: 200, headers: { 'content-type': 'application/json' } }))));
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} onerror = null; });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  window.history.replaceState({}, '', '/m/video');
});
afterEach(() => { render(null, host); host.remove(); vi.unstubAllGlobals(); });

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const tabButton = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

describe('video web module', () => {
  it('registers one studio page with the AI Video Studio nav entry and both agent scopes', () => {
    expect(mod.id).toBe('video');
    expect(mod.nav).toHaveLength(1);
    expect(mod.nav![0]).toMatchObject({ group: 'studio', label: 'AI Video Studio', path: '/m/video' });
    expect(mod.routes?.map((r) => r.path)).toEqual(['/m/video']);
    expect(mod.agentAccess?.map((a) => a.scope)).toEqual(['studio.read', 'studio.write']);
  });

  it('renders the page with its three tabs', async () => {
    await act(async () => { render(<VideoStudio />, host); });
    await flush();
    expect(host.textContent).toContain('AI Video Studio');
    for (const label of ['Studio', 'Video quay sẵn', 'Kết nối']) expect(tabButton(label), label).toBeTruthy();
  });

  it('tells the owner how to install ffmpeg when it is missing', async () => {
    await act(async () => { render(<VideoStudio />, host); });
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('brew install ffmpeg');
  });

  it('opens the footage editor and the connections tab without crashing and reaches the module API', async () => {
    await act(async () => { render(<VideoStudio />, host); });
    await flush();
    await act(async () => { tabButton('Video quay sẵn')!.click(); });
    await flush();
    expect(host.textContent?.length).toBeGreaterThan(50);
    await act(async () => { tabButton('Kết nối')!.click(); });
    await flush();
    expect(host.textContent).toContain('HeyGen');
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.startsWith('/api/m/video/edit/'))).toBe(true);
    expect(urls.every((u) => !u.startsWith('/api/video-edit') && !u.startsWith('/api/video-studio'))).toBe(true);
  });
});
