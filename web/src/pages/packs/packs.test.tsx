import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Router } from 'wouter-preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
});
import PacksPage from './PacksPage';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean) {
  for (let i = 0; i < 60 && !ok(); i++) await act(async () => { await wait(50); });
  expect(ok()).toBe(true);
}
const button = (root: HTMLElement, text: RegExp) => [...root.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;

describe('Kho dữ liệu page', () => {
  beforeEach(() => { sessionStorage.setItem('aios.mock', '1'); document.body.innerHTML = ''; });

  it('shows a preview first, installs only on an explicit click, then uninstalls through a confirmation', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    await act(async () => { render(<Router><PacksPage id="tra-va-qua-tang-co-ban" /></Router>, root); await wait(100); });
    await until(() => !!button(root, /Xem trước/) && !(button(root, /Xem trước/)!.disabled));
    expect(button(root, /Cài vào brain/)).toBeUndefined();

    await act(async () => { button(root, /Xem trước/)!.click(); });
    await until(() => !!button(root, /Cài vào brain/));
    expect(root.textContent).toMatch(/5 ghi chú mới/);
    expect(root.textContent).toMatch(/ảnh minh hoạ trong gói không được chép/);

    await act(async () => { button(root, /Cài vào brain/)!.click(); });
    await until(() => /trong một commit/.test(root.textContent ?? ''));
    await until(() => !!button(root, /^Gỡ$/));

    await act(async () => { button(root, /^Gỡ$/)!.click(); });
    await until(() => !!button(root, /Gỡ gói/));
    expect(document.body.textContent).toMatch(/Chỉ xoá ghi chú bạn chưa sửa/);
    await act(async () => { button(document.body, /Gỡ gói/)!.click(); });
    await until(() => !button(document.body, /Gỡ gói/));
  });
});
