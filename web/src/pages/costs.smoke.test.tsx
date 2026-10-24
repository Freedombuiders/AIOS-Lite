import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Router } from 'wouter-preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { costCell } from '@/components/costs/format';
import { startSse } from '@/lib/sse';
import BudgetsPage from './Budgets';
import UsagePage from './Usage';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(node: preact.VNode, expected: RegExp): Promise<HTMLElement> {
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(() => render(<Router>{node}</Router>, el));
  for (let i = 0; i < 30 && !expected.test(el.textContent ?? ''); i++) await act(() => wait(100));
  return el;
}

describe('cost pages with the mock api', () => {
  beforeEach(() => {
    sessionStorage.setItem('aios.mock', '1');
    startSse();
  });
  afterEach(() => vi.restoreAllMocks());

  it('usage shows KPIs, unknown prices and the period switcher', async () => {
    const el = await mount(<UsagePage />, /Lượt chưa có giá/);
    expect(el.textContent).toMatch(/Tổng chi phí/);
    expect(el.textContent).toMatch(/chưa có giá/);
    expect(el.textContent).toMatch(/Việc tốn kém nhất/);
    const btn = [...el.querySelectorAll('button')].find((b) => b.textContent === '7 ngày')!;
    await act(() => btn.click());
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('budgets shows the global form and per-agent rows', async () => {
    const el = await mount(<BudgetsPage />, /Ngân sách từng agent/);
    expect(el.textContent).toMatch(/Ngân sách chung của tháng/);
    expect(el.textContent).toMatch(/Trợ lý chính/);
    expect(el.textContent).toMatch(/Cảnh báo gần đây/);
  });
});

describe('costCell', () => {
  it('never shows $0 for unknown prices', () => {
    expect(costCell({ costUsd: 0, runs: 3, unpricedRuns: 3 })).toBe('chưa có giá');
    expect(costCell({ costUsd: 1.5, runs: 3, unpricedRuns: 1 })).toContain('chưa có giá');
    expect(costCell({ costUsd: 0, runs: 0, unpricedRuns: 0 })).toBe('$0');
  });
});
