import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Router } from 'wouter-preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
});
import { startSse } from '@/lib/sse';
import AgentMarketPage from './AgentMarket';
import RecosPage from './Recos';
import TeamsPage from './Teams';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(node: preact.VNode, expected: RegExp): Promise<HTMLElement> {
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(() => render(<Router>{node}</Router>, el));
  for (let i = 0; i < 30 && !expected.test(el.textContent ?? ''); i++) await act(() => wait(100));
  expect(el.textContent).toMatch(expected);
  return el;
}

const click = (el: Element | null | undefined) => act(() => { (el as HTMLElement).click(); });
const byText = (root: ParentNode, sel: string, re: RegExp) => [...root.querySelectorAll(sel)].find((n) => re.test(n.textContent ?? ''));

describe('team screens with the mock api', () => {
  beforeEach(() => {
    sessionStorage.setItem('aios.mock', '1');
    startSse();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('Gói Team lists packages and previews an install', async () => {
    const el = await mount(<TeamsPage />, /CSKH Zalo và Email/);
    expect(el.textContent).toMatch(/FB Content Studio/);
    await click(byText(el, 'article[data-team="cskh-zalo-email"] button', /Xem và cài/));
    for (let i = 0; i < 20 && !/Sẽ tạo/.test(document.body.textContent ?? ''); i++) await act(() => wait(100));
    expect(document.body.textContent).toMatch(/Cần điền "Tên cửa hàng"/);
    expect(document.body.textContent).toMatch(/cskh-agent-2/);
    const install = byText(document.body, 'button', /Cài vào đội/) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
  });

  it('Chợ Agent shows templates and the packages', async () => {
    const el = await mount(<AgentMarketPage />, /Nghiên cứu thị trường/);
    expect(el.textContent).toMatch(/Biên tập nội dung/);
    expect(el.textContent).toMatch(/CSKH Zalo và Email/);
    await click(byText(el, 'article[data-template="research-analyst"] button', /Cài vào đội/));
    for (let i = 0; i < 20 && !/Sẽ tạo agent/.test(document.body.textContent ?? ''); i++) await act(() => wait(100));
    expect(document.body.textContent).toMatch(/knowledge\/customer-care\.md/);
    expect(document.body.textContent).toMatch(/Còn thiếu: Doanh nghiệp/);
  });

  it('Đề xuất cải tiến: cart and apply', async () => {
    const el = await mount(<RecosPage />, /sắp hết ngân sách/);
    const card = el.querySelector('[data-reco="budget:sales-a"]')!;
    await click(byText(card, 'button', /Thêm vào giỏ/));
    for (let i = 0; i < 20 && !/Áp dụng giỏ \(1\)/.test(el.textContent ?? ''); i++) await act(() => wait(100));
    expect(el.textContent).toMatch(/Áp dụng giỏ \(1\)/);
    await click(byText(el, 'button', /Áp dụng giỏ/));
    for (let i = 0; i < 20 && /Áp dụng giỏ/.test(el.textContent ?? ''); i++) await act(() => wait(100));
    expect(el.textContent).not.toMatch(/sắp hết ngân sách/);
  });
});
