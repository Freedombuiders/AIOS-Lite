import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Router } from 'wouter-preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundledModules, moduleInfos } from '@/module-host/host';
import type { NavGroup } from '@/module-host/contracts';
import { Sidebar } from './Sidebar';

const store = new Map<string, string>();
const memoryStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() };

const FAKE: Record<string, { group: NavGroup; label: string }> = {
  t_care: { group: 'care', label: 'Hộp thư thử' },
  t_sales: { group: 'sales', label: 'Bán hàng thử' },
  t_studio: { group: 'studio', label: 'Studio thử' },
  t_mkt: { group: 'marketing', label: 'Đăng bài thử' },
  t_brain: { group: 'brain', label: 'Tệp thử' },
  t_fin: { group: 'finance', label: 'Sổ thử' },
};

function setEnabled(ids: string[]) {
  moduleInfos.value = Object.keys(FAKE).map((id) => ({
    manifest: { id, name: id, description: '', version: '0.1.0', category: FAKE[id]!.group, tables: [] },
    state: { id, enabled: ids.includes(id), version: '0.1.0', installedAt: null, settings: {} },
    requirements: [], ready: true, hasServer: true, hasWeb: true, agentTemplates: [],
  })) as never;
}

async function mount(path = '/') {
  history.replaceState(null, '', path);
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(() => render(<Router><Sidebar /></Router>, el));
  return el;
}

const captions = (el: HTMLElement) => [...el.querySelectorAll('.snav-caption')].map((c) => c.textContent);
const labels = (el: HTMLElement) => [...el.querySelectorAll('.sidebar-nav-link .sidebar-label')].map((c) => c.textContent);

describe('Sidebar', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage);
    store.clear();
    window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
    for (const [id, f] of Object.entries(FAKE)) bundledModules[id] = { id, nav: [{ group: f.group, label: f.label, path: `/m/${id}` }] };
    setEnabled([]);
  });
  afterEach(() => {
    document.body.innerHTML = '';
    for (const id of Object.keys(FAKE)) delete bundledModules[id];
    moduleInfos.value = [];
    vi.unstubAllGlobals();
  });

  it('with no module on: the top three, Brain, and the team section; "Nâng cao" shut', async () => {
    const el = await mount();
    expect(captions(el)).toEqual(['BRAIN', 'ĐỘI AI VÀ HỆ THỐNG']);
    expect(labels(el)).toEqual(expect.arrayContaining(['Hôm nay', 'Gọi trợ lý', 'Trò chuyện', 'Đồ thị', 'Second Brain', 'Đội AI · Bot', 'Công việc', 'Kết nối', 'Cài đặt', 'Nâng cao']));
    // GenBot is the only engine: the bot screen replaces the generic Agents entry, which moved into "Nâng cao"
    expect(labels(el)).not.toContain('Agents');
    expect(labels(el)).not.toContain('Skills');
    expect(labels(el)).not.toContain('Khác');
  });

  it('shows the five captions in order once modules fill Chăm khách and Marketing', async () => {
    setEnabled(['t_care', 't_studio']);
    const el = await mount();
    expect(captions(el)).toEqual(['BRAIN', 'CHĂM KHÁCH', 'MARKETING', 'ĐỘI AI VÀ HỆ THỐNG']);
    const care = el.querySelector('[data-nav-section="care"]')!;
    expect(care.textContent).toContain('Hộp thư thử');
    expect(el.querySelector('[data-nav-section="marketing"]')!.textContent).toContain('Studio thử');
  });

  it('puts old and new groups where the design says, with finance/ops/other under a closed "Khác"', async () => {
    setEnabled(['t_care', 't_sales', 't_studio', 't_mkt', 't_brain', 't_fin']);
    const el = await mount();
    const text = (s: string) => el.querySelector(`[data-nav-section="${s}"]`)!.textContent ?? '';
    expect(text('care')).toContain('Hộp thư thử');
    expect(text('care')).toContain('Bán hàng thử');
    expect(text('marketing')).toContain('Studio thử');
    expect(text('marketing')).toContain('Đăng bài thử');
    expect(text('brain')).toContain('Tệp thử');
    expect(labels(el)).toContain('Khác');
    expect(labels(el)).not.toContain('Sổ thử');
  });

  it('adds and drops a module entry as the module is turned on and off, without a reload', async () => {
    const el = await mount();
    expect(el.textContent).not.toContain('Hộp thư thử');
    await act(() => { setEnabled(['t_care']); });
    expect(el.textContent).toContain('Hộp thư thử');
    expect(captions(el)).toContain('CHĂM KHÁCH');
    await act(() => { setEnabled([]); });
    expect(el.textContent).not.toContain('Hộp thư thử');
    expect(captions(el)).not.toContain('CHĂM KHÁCH');
  });

  it('opens "Nâng cao" by itself when the current page is inside it', async () => {
    const el = await mount('/skills');
    expect(labels(el)).toEqual(expect.arrayContaining(['Skills', 'Gói Team', 'Bộ nhớ', 'Đề xuất cải tiến', 'Chi phí AI', 'Ngân sách AI', 'Nhật ký', 'Module']));
    expect(el.querySelector('[aria-current="page"]')?.textContent).toContain('Skills');
    // the old agent market and the generic Agents list are gone (G3)
    expect(labels(el)).not.toContain('Chợ Agent');
    expect(labels(el)).not.toContain('Agents');
  });

  it('lights one entry only on a nested path', async () => {
    const el = await mount('/brain/graph');
    const current = [...el.querySelectorAll('[aria-current="page"]')];
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toContain('Đồ thị');
  });
});
