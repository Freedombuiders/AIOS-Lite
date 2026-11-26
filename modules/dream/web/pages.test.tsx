// Dream 100 pages D2: the morning suggestions with the owner's three buttons, and the formulas with their verdict.
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
});
import { invalidateFetchCache } from '@/lib/useFetch';
import { FormulasPage } from './FormulasPage';
import { IdeasPage } from './IdeasPage';
import type { Formula, FormulaDetailDto, FormulasDto, IdeasDto } from './lib';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let calls: Array<{ url: string; method: string; body: unknown }> = [];

function serve(routes: Record<string, unknown>) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => String(url).includes(k));
    return new Response(JSON.stringify(key ? routes[key] : {}), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

async function mount(node: preact.ComponentChildren) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(() => render(node, el));
  for (let i = 0; i < 30 && /Đang tải/.test(el.textContent ?? ''); i++) await act(async () => { await wait(30); });
  await act(async () => { await wait(30); });
  return el;
}

const click = async (el: Element) => act(async () => { (el as HTMLElement).click(); await wait(30); });
const button = (root: Element, text: string) => [...root.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateFetchCache();
  document.body.innerHTML = '';
});

const formula = (o: Partial<Formula> = {}): Formula => ({
  slug: 'huong-dan-3-buoc', path: 'cong-thuc/huong-dan-3-buoc.md', name: 'Hướng dẫn 3 bước', moDau: 'cau-hoi', cauTruc: 'huong-dan-buoc', maxLen: 45, cutsPerMin: 14,
  pillar: 'Cách pha', kyVong: 1.5, evidence: 9, made: 3, result: 1.3, ratio: 1.95, state: 'hop', stateLabel: 'Hợp với kênh mình', exploratory: true, version: 1, rejections: 0, ...o,
});
const overview = { folder: 'b1', folderError: null, channels: 0, maxChannels: 100, agent: null, agents: [], tools: [] };

describe('Đề xuất hôm nay', () => {
  it('shows each suggestion with its fixed expectation; "Bỏ, không hợp" asks a reason before dropping', async () => {
    const dto: IdeasDto = {
      day: '2026-11-26', today: '2026-11-26', history: { suggested: 3, given: 1, rejected: 0, later: 0 },
      run: { day: '2026-11-26', status: 'done', picked: 1, written: 1, note_path: 'noi-dung/de-xuat/2026-11-26.md', log: null, finished_at: 1 },
      items: [{
        day: '2026-11-26', slot: 1, formula_slug: 'huong-dan-3-buoc', formula_version: 1, kind: 'hop', source_video_slug: '2026-11-25-bep-vd_1', expected_ratio: 1.95, tru_cot: 'Cách pha',
        tieu_de: '3 bước pha ô long sen lạnh', cau_mo_dau: 'Vì sao ô long pha lạnh hay bị chát?', viec_can_lam: 'Quay 3 cảnh cận tay.', nen_tang: 'facebook', status: 'new',
        reject_reason: null, content_id: null, task_id: null, formula: formula(),
      }],
    };
    serve({ '/api/m/dream/overview': overview, '/api/brain/folders': { items: [] }, '/api/m/dream/ideas': dto });
    const el = await mount(<IdeasPage />);
    expect(el.textContent).toContain('3 bước pha ô long sen lạnh');
    expect(el.textContent).toContain('Công thức đã hợp');
    expect(el.textContent).toContain('Gấp 1,95 lần ER trung vị của kênh, cố định lúc đề xuất');
    expect(el.textContent).toContain('(thăm dò)');
    expect(el.textContent).toContain('Thứ Năm 26/11');

    await click(button(el, 'Bỏ, không hợp'));
    const drop = button(el, 'Bỏ đề xuất');
    expect(drop.disabled).toBe(true);
    const input = el.querySelector('input')!;
    await act(async () => { input.value = 'Tuần này bán sỉ'; input.dispatchEvent(new Event('input')); });
    await click(button(el, 'Bỏ đề xuất'));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/api/m/dream/ideas/2026-11-26/1/reject', body: { reason: 'Tuần này bán sỉ' } });

    await click(button(el, 'Giao Bot Nội dung viết'));
    expect(calls.filter((c) => c.method === 'POST').at(-1)!.url).toBe('/api/m/dream/ideas/2026-11-26/1/give');
  });
});

describe('Công thức', () => {
  it('labels 3 posts as exploratory and shows the comparison bot’s verdict and remark', async () => {
    const list: FormulasDto = { folder: 'b1', formulas: [formula()], proposals: [], options: { moDau: [], cauTruc: [] } };
    const detail: FormulaDetailDto = {
      formula: formula(), body: '', remark: 'Bài của mình dài hơn video gốc.',
      result: { da_lam: 3, ket_qua: 1.3, ti_le_trung_vi: 1.95, trang_thai: 'hop', tham_do: true, label: 'Hợp với kênh mình' },
      posts: [{ path: 'noi-dung/bai/a.md', title: 'Bài A', publishedAt: null, comparisons: [{ moc: '24h', er: 7.5, trung_vi_kenh: 4, so_bai_nen: 3, ti_le: 1.88, ky_vong: 1.5, so_voi_ky_vong: 1.25 }] }],
      videos: [],
    };
    serve({ '/api/m/dream/overview': overview, '/api/brain/folders': { items: [] }, '/api/m/dream/formulas/huong-dan-3-buoc': detail, '/api/m/dream/formulas': list });
    const el = await mount(<FormulasPage />);
    expect(el.textContent).toContain('Hợp với kênh mình · thăm dò');
    expect(el.textContent).toContain('Bot Đối chiếu kết luận');
    expect(el.textContent).toContain('Hợp với kênh mình (thăm dò)');
    expect(el.textContent).toContain('Bài của mình dài hơn video gốc.');
    expect(el.textContent).toContain('cao hơn trung vị kênh 95%');
  });
});
