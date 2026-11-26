import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Router } from 'wouter-preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/agents', () => ({
  useAgents: () => ({ agents: [{ id: 'main', name: 'Trợ lý chính', enabled: true, stats: { running: 0, queued: 0, lastRunAt: null } }], loading: false, error: null, loadErrors: [], refresh() {} }),
}));

import { AppMain } from './AppMain';
import type { AppRoute } from './AppMain';

const Plain = () => <p>trang thường</p>;
const OwnComposer = () => <p>trang có ô soạn riêng</p>;
const Missing = () => <p>không tìm thấy</p>;

const routes: AppRoute[] = [
  { path: '/', component: Plain },
  { path: '/chat/:id', component: OwnComposer, hideCommandBar: true },
  { path: '/m/x/inbox', component: OwnComposer, hideCommandBar: true, modulePage: true },
];

const mounted: HTMLElement[] = [];

async function mount(path: string) {
  history.replaceState(null, '', path);
  const el = document.createElement('div');
  document.body.appendChild(el);
  mounted.push(el);
  await act(() => render(<Router><AppMain routes={routes} notFound={Missing} /></Router>, el));
  return el;
}

describe('AppMain command bar', () => {
  // Unmount for real so pending hook effects (wouter reads `location`) do not fire after jsdom is torn down.
  afterEach(async () => {
    for (const el of mounted.splice(0)) await act(() => render(null, el));
    document.body.innerHTML = '';
  });

  it('shows the bar on a page that does not ask to hide it', async () => {
    const el = await mount('/');
    expect(el.textContent).toContain('trang thường');
    expect(el.querySelector('form[aria-label="Ra lệnh cho đội AI"]')).not.toBeNull();
  });

  it('hides the bar on a route that declares hideCommandBar', async () => {
    const el = await mount('/chat/5');
    expect(el.textContent).toContain('trang có ô soạn riêng');
    expect(el.querySelector('form[aria-label="Ra lệnh cho đội AI"]')).toBeNull();
  });

  it('hides it on a module route that declares it, and still wraps it in the module page', async () => {
    const el = await mount('/m/x/inbox');
    expect(el.querySelector('.module-page')).not.toBeNull();
    expect(el.querySelector('form[aria-label="Ra lệnh cho đội AI"]')).toBeNull();
  });

  it('keeps the bar on the not-found page', async () => {
    const el = await mount('/khong-co');
    expect(el.textContent).toContain('không tìm thấy');
    expect(el.querySelector('form[aria-label="Ra lệnh cho đội AI"]')).not.toBeNull();
  });
});
