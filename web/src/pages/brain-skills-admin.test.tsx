import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Router } from 'wouter-preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
});
import { AccessEditor, presetOf } from '@/components/agents/AccessEditor';
import { mockRequest } from '@/lib/mock';
import { invalidateFetchCache } from '@/lib/useFetch';
import SecondBrains from './SecondBrains';
import SkillsPage from './Skills';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (el: Element) => el.textContent ?? '';

async function mount(path: string, node: preact.VNode) {
  history.replaceState(null, '', path);
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(() => render(<Router>{node}</Router>, el));
  return el;
}
async function until(el: Element, re: RegExp) {
  for (let i = 0; i < 40 && !re.test(text(el)); i++) await act(() => wait(100));
  expect(text(el)).toMatch(re);
}
const button = (el: Element, label: RegExp) => [...el.querySelectorAll('button')].find((b) => label.test(text(b))) as HTMLButtonElement;
const click = (b: Element) => act(() => void (b as HTMLElement).click());

describe('brain management and skills admin (mock api)', () => {
  beforeEach(() => {
    sessionStorage.setItem('aios.mock', '1');
    invalidateFetchCache();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('lists brains with vault badge, readers and the folder browser in the add modal', async () => {
    const el = await mount('/brain/all', <SecondBrains />);
    await until(el, /Tri thức chung/);
    expect(text(el)).toMatch(/Obsidian vault/);
    expect(text(el)).toMatch(/Được đọc bởi/);
    await click(button(el, /Thêm brain/));
    await until(document.body, /Thêm Second Brain/);
    await until(document.body, /Documents/); // /fs/dirs listing
    await click([...document.querySelectorAll('[role=option]')].find((o) => /Documents/.test(text(o)))!);
    await until(document.body, /CongTyA[\s\S]*Obsidian/);
  });

  it('asks before removing and says files stay', async () => {
    const el = await mount('/brain/all', <SecondBrains />);
    await until(el, /Bán hàng/);
    await click(button(el.querySelector('[data-testid="brain-ban-hang"]')!, /Gỡ/));
    await until(document.body, /Chỉ gỡ khỏi AIOS, không xoá file/);
  });

  it('skills: sources tab shows roots and suggestions, grants tab saves a checkbox', async () => {
    const el = await mount('/skills', <SkillsPage />);
    await until(el, /Trả lời khách/);
    await click(button(el, /Nguồn skill/));
    await until(el, /Nguồn đang dùng[\s\S]*Gợi ý trên máy bạn/);
    expect(text(el)).toMatch(/Chỉ đọc/);
    await click(button(el, /Phân quyền/));
    await until(el, /dùng tất cả skill/);
    const boxes = [...el.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    expect(boxes.some((b) => b.disabled && b.checked)).toBe(true); // agents with skills 'all'
    const target = el.querySelector<HTMLInputElement>('input[aria-label="Sales A dùng skill Viết caption"]')!;
    expect(target.checked).toBe(false);
    await act(() => {
      target.checked = true;
      target.dispatchEvent(new Event('change', { bubbles: true }));
    });
    for (let i = 0; i < 20 && !el.querySelector<HTMLInputElement>('input[aria-label="Sales A dùng skill Viết caption"]')!.checked; i++) await act(() => wait(100));
    expect(el.querySelector<HTMLInputElement>('input[aria-label="Sales A dùng skill Viết caption"]')!.checked).toBe(true);
  });

  it('agent access tab lists every brain with presets', async () => {
    const access = { brain: { 'ban-hang': { read: ['**'], write: [] } }, memory: { team: true, private: true }, skills: [], connections: {}, modules: {} };
    const el = await mount('/agents/sales-a', <AccessEditor agentId="sales-a" access={access} runtimeLabel="Codex" onSaved={() => undefined} />);
    await until(el, /Tri thức chung/);
    const row = el.querySelector('[data-testid="brain-grant-ban-hang"]')!;
    expect(row.querySelector('[aria-checked=true]')!.textContent).toBe('Chỉ đọc toàn bộ');
    expect(el.querySelector('[data-testid="brain-grant-tri-thuc"] [aria-checked=true]')!.textContent).toBe('Không');
    await click(button(el.querySelector('[data-testid="brain-grant-tri-thuc"]')!, /Đọc & ghi toàn bộ/));
    expect(el.querySelector('[data-testid="brain-grant-tri-thuc"] [aria-checked=true]')!.textContent).toBe('Đọc & ghi toàn bộ');
    await click(button(el.querySelector('[data-testid="brain-grant-tri-thuc"]')!, /Tuỳ chỉnh/));
    expect(el.querySelector('[data-testid="brain-grant-tri-thuc"] input.field')).toBeTruthy();
  });

  it('presetOf maps grants to presets', () => {
    expect(presetOf(undefined)).toBe('none');
    expect(presetOf({ read: ['**'], write: [] })).toBe('read');
    expect(presetOf({ read: ['**'], write: ['**'] })).toBe('rw');
    expect(presetOf({ read: ['A/**'], write: [] })).toBe('custom');
  });

  it('mock endpoints behave like the real ones', async () => {
    await expect(mockRequest('GET', '/fs/dirs?path=/etc')).rejects.toMatchObject({ status: 400 });
    await expect(mockRequest('DELETE', '/skills/roots', { path: '/Users/demo/aios/skills' })).rejects.toMatchObject({ status: 404 });
    const added = await mockRequest<{ path: string }>('POST', '/skills/roots', { path: '/Users/demo/x', label: 'X' });
    expect(added.path).toBe('/Users/demo/x');
    await expect(mockRequest('POST', '/skills/roots', { path: '/Users/demo/x' })).rejects.toMatchObject({ status: 409 });
  });
});
