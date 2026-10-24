import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Router } from 'wouter-preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
});
import mod from './index';
import { KolHome } from './pages/KolHome';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('kol web module', () => {
  it('registers the KOL home and the per-KOL workspace under /m/kol in the studio group', () => {
    expect(mod.id).toBe('kol');
    expect(mod.nav).toEqual([expect.objectContaining({ group: 'studio', label: 'KOL Studio', path: '/m/kol' })]);
    expect(mod.routes?.map((r) => r.path)).toEqual(['/m/kol', '/m/kol/:id']);
    expect(mod.agentAccess?.map((a) => a.scope)).toEqual(['kol.read', 'content.write', 'media.generate']);
  });
});

describe('KOL home screen', () => {
  const fixtures: Record<string, unknown> = {
    '/api/m/kol/personas': { personas: [{
      id: 'p1', name: 'Mia', handle: 'mia', status: 'active', tagline: '', niche: 'thời trang', coverUrl: null, platforms: ['instagram'],
      followers: 1200, postsScheduled: 2, postsPublished30d: 5, spendMonthUsd: 1.5, autopilot: false, languages: ['vi'], refCount: 2,
    }] },
    '/api/m/kol/status': {
      enabled: true, killSwitches: { generate: true, publish: true }, composio: false, providers: [],
      judge: { configured: false, provider: 'none', model: '' }, voice: { configured: false }, chatgpt: { mode: 'none', configured: false, imagesToday: 0, dailyLimit: 40, model: '', models: [], hint: '' },
    },
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).split('?')[0];
      return new Response(JSON.stringify(fixtures[path] ?? {}), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders the studio home and lists the KOLs', async () => {
    history.replaceState(null, '', '/m/kol');
    const el = document.createElement('div');
    document.body.appendChild(el);
    await act(() => render(<Router><KolHome /></Router>, el));
    for (let i = 0; i < 30 && !/Mia/.test(el.textContent ?? ''); i++) await act(async () => { await wait(100); });
    expect(el.textContent).toMatch(/KOL Studio/);
    expect(el.textContent).toMatch(/Mia/);
    render(null, el);
    el.remove();
  });
});
