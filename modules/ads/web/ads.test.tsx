import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrganicSection } from './components/fb/ads/AdsCreatives';
import module from './index';

vi.mock('@/lib/useFetch', () => ({
  useFetch: () => ({ data: { accounts: [], connection: 'MISSING' }, loading: false, error: null, refresh: vi.fn() }),
  invalidateFetchCache: vi.fn(),
}));
vi.mock('@/lib/page-context', () => ({ usePageFocus: vi.fn() }));
const host = document.createElement('div'); document.body.append(host);
afterEach(() => act(() => render(null, host)));

describe('ads web module', () => {
  it('mounts the registered page with connection setup and no marketing dependency', () => {
    const Page = module.routes![0].component;
    act(() => render(<Page />, host));
    expect(host.textContent).toContain('Quảng cáo');
    expect(module.nav![0].path).toBe('/m/ads');
  });
  it('hides the entire organic section without marketing', () => {
    act(() => render(<OrganicSection available={false} items={[]} />, host));
    expect(host.textContent).toBe('');
  });
  it('shows organic candidates when marketing provides them', () => {
    act(() => render(<OrganicSection available items={[{ postId: 'p1', pageName: 'Trang mẫu', title: 'Bài nổi bật', format: 'reel', er: 8, shares: 20 }]} />, host));
    expect(host.textContent).toContain('Bài nổi bật');
    expect(host.textContent).toContain('Trang mẫu');
  });
});
