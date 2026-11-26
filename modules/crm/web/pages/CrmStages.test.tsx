import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toasts } from '@/lib/toasts';
import { fakeApi, NOW, ROWS, STATUS_NONE } from '../lib/fixtures.test-util';
import { fire, mount, q, qa, settle } from '../lib/mount.test-util';
import { CrmStages } from './CrmStages';

const now = () => NOW;
let cleanup: (() => void) | null = null;
beforeEach(() => { toasts.value = []; });
afterEach(() => { cleanup?.(); cleanup = null; });

const names = (host: ParentNode, stage: string) => qa(host, `[data-testid="crm-col-${stage}"] [data-testid="crm-card"]`).map((c) => c.textContent ?? '');

describe('CrmStages (Giai đoạn)', () => {
  it('lays customers out by care stage with counts, and lists who needs care today', async () => {
    const api = fakeApi();
    const { host, unmount } = await mount(<CrmStages api={api} now={now} />);
    cleanup = unmount;
    expect(q(host, '[data-testid="crm-count-new"]')!.textContent).toBe('2');
    expect(q(host, '[data-testid="crm-count-consulting"]')!.textContent).toBe('1');
    expect(q(host, '[data-testid="crm-count-lost"]')!.textContent).toBe('0');
    expect(names(host, 'consulting')[0]).toContain('Chị Lan');
    expect(names(host, 'consulting')[0]).toContain('Gửi báo giá');
    // Hoa (2h overdue) and Minh (3 days overdue) are due, Lan (in 2 days) is not
    const today = q(host, '[data-testid="crm-today"]')!.textContent ?? '';
    expect(today).toContain('Chị Hoa');
    expect(today).toContain('Anh Minh');
    expect(today).not.toContain('Chị Lan');
    expect(q(host, '[data-testid="crm-not-configured"]')).toBeNull();
  });

  it('dragging a card to another column changes the stage through care, and the card moves', async () => {
    const api = fakeApi();
    const { host, unmount } = await mount(<CrmStages api={api} now={now} />);
    cleanup = unmount;
    const card = q(host, '[data-testid="crm-card"][data-customer-id="lan"]')!;
    const target = q(host, '[data-testid="crm-col-quoted"]')!;
    // the server will say Lan is now quoted on the reload that follows
    api.customers.mockImplementation(async () => ROWS.map((r) => (r.id === 'lan' ? { ...r, giaiDoan: 'quoted' as const } : { ...r })));
    await fire(card, 'dragstart');
    await fire(target, 'dragover');
    await fire(target, 'drop');
    await settle();
    expect(api.changeStage).toHaveBeenCalledTimes(1);
    expect(api.changeStage).toHaveBeenCalledWith('lan', 'quoted');
    expect(names(host, 'quoted').join('|')).toContain('Chị Lan');
    expect(names(host, 'consulting')).toHaveLength(0);
    expect(toasts.value.some((t) => t.tone === 'success')).toBe(true);
  });

  it('drops on the same column do nothing', async () => {
    const api = fakeApi();
    const { host, unmount } = await mount(<CrmStages api={api} now={now} />);
    cleanup = unmount;
    await fire(q(host, '[data-customer-id="lan"]')!, 'dragstart');
    await fire(q(host, '[data-testid="crm-col-consulting"]')!, 'drop');
    expect(api.changeStage).not.toHaveBeenCalled();
  });

  it('puts the card back and says why when care refuses', async () => {
    const api = fakeApi({ changeStage: (async () => { throw new Error('Hồ sơ vừa được sửa ở nơi khác.'); }) as never });
    const { host, unmount } = await mount(<CrmStages api={api} now={now} />);
    cleanup = unmount;
    await fire(q(host, '[data-customer-id="lan"]')!, 'dragstart');
    await fire(q(host, '[data-testid="crm-col-deposit"]')!, 'drop');
    await settle();
    expect(names(host, 'deposit')).toHaveLength(0);
    expect(names(host, 'consulting')[0]).toContain('Chị Lan');
    const t = toasts.value.find((x) => x.tone === 'error');
    expect(t?.title).toContain('Chị Lan');
    expect(t?.description).toContain('sửa ở nơi khác');
  });

  it('the select on a card is the way to move on a phone (no drag there)', async () => {
    const api = fakeApi();
    const { host, unmount } = await mount(<CrmStages api={api} now={now} />);
    cleanup = unmount;
    const sel = q<HTMLSelectElement>(host, '[data-customer-id="minh"] select')!;
    sel.value = 'won';
    await fire(sel, 'change');
    await settle();
    expect(api.changeStage).toHaveBeenCalledWith('minh', 'won');
  });

  it('search narrows the cards', async () => {
    const api = fakeApi();
    const { host, unmount } = await mount(<CrmStages api={api} now={now} />);
    cleanup = unmount;
    const input = q<HTMLInputElement>(host, '[data-testid="crm-search"]')!;
    input.value = 'quà tết';
    await fire(input, 'input');
    expect(qa(host, '[data-testid="crm-card"]').map((c) => c.getAttribute('data-customer-id'))).toEqual(['hoa']);
  });

  it('with no notes folder it still shows every customer, plus a banner pointing at the setting', async () => {
    const api = fakeApi({ status: (async () => STATUS_NONE) as never });
    const { host, unmount } = await mount(<CrmStages api={api} now={now} />);
    cleanup = unmount;
    const banner = q(host, '[data-testid="crm-not-configured"]')!;
    expect(banner.textContent).toContain('Chưa chọn thư mục Second Brain');
    expect(banner.querySelector('a')!.getAttribute('href')).toBe('/modules');
    expect(qa(host, '[data-testid="crm-card"]')).toHaveLength(4);
  });

  it('shows an honest empty state and an error state', async () => {
    const empty = await mount(<CrmStages api={fakeApi({ customers: (async () => []) as never })} now={now} />);
    expect(empty.host.textContent).toContain('Chưa có khách nào');
    empty.unmount();
    const bad = await mount(<CrmStages api={fakeApi({ customers: (async () => { throw new Error('boom'); }) as never })} now={now} />);
    cleanup = bad.unmount;
    expect(bad.host.textContent).toContain('boom');
  });
});
