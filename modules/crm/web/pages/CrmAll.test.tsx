import { afterEach, describe, expect, it } from 'vitest';
import { SAVED_FILTERS_KEY } from '../lib/filters';
import { fakeApi, NOW, STATUS_NONE } from '../lib/fixtures.test-util';
import { fire, mount, q, qa, settle } from '../lib/mount.test-util';
import { CrmAll } from './CrmAll';

const now = () => NOW;
let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

class MemStorage {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
}
const ids = (host: ParentNode) => qa(host, '[data-testid="crm-row"]').map((r) => r.getAttribute('data-customer-id'));

describe('CrmAll (Tất cả khách)', () => {
  it('shows the machine-owned note fields as columns', async () => {
    const { host, unmount } = await mount(<CrmAll api={fakeApi()} now={now} storage={new MemStorage() as never} />);
    cleanup = unmount;
    const heads = qa(host, '[role="columnheader"]').map((h) => h.textContent?.trim());
    expect(heads).toEqual(['ten · tệp', 'giai_doan', 'the', 'sdt', 'viec_tiep · han', 'cap_nhat']);
    const lan = q(host, '[data-customer-id="lan"]')!.textContent ?? '';
    expect(lan).toContain('Chị Lan');
    expect(lan).toContain('lan.md');
    expect(lan).toContain('Đang tư vấn');
    expect(lan).toContain('hỏi sỉ');
    expect(lan).toContain('0901234567');
    expect(lan).toContain('Gửi báo giá');
    expect(lan).toContain('28/11');
    // a customer whose note is not written yet says so instead of inventing a file name
    expect(q(host, '[data-customer-id="tuan"]')!.textContent).toContain('chưa có ghi chú');
    // no Zalo, ranking or order columns: care holds none of that
    expect(heads.join(' ')).not.toMatch(/zalo|hang|gia_tri|da_mua/);
  });

  it('sorts by next follow-up first (overdue first, none last) and by name on click', async () => {
    const { host, unmount } = await mount(<CrmAll api={fakeApi()} now={now} storage={new MemStorage() as never} />);
    cleanup = unmount;
    expect(ids(host)).toEqual(['minh', 'hoa', 'lan', 'tuan']);
    await fire(qa(host, '[role="columnheader"] button').find((b) => b.textContent?.includes('ten'))!, 'click');
    expect(ids(host)).toEqual(['minh', 'tuan', 'hoa', 'lan']); // Anh Minh, Anh Tuấn, Chị Hoa, Chị Lan
  });

  it('filters by stage, tag, due and search', async () => {
    const { host, unmount } = await mount(<CrmAll api={fakeApi()} now={now} storage={new MemStorage() as never} />);
    cleanup = unmount;
    await fire(q(host, '[data-testid="crm-stage-filter-quoted"]')!, 'click');
    expect(ids(host)).toEqual(['minh']);
    await fire(q(host, '[data-testid="crm-stage-filter-quoted"]')!, 'click');
    const tag = q<HTMLSelectElement>(host, 'select[aria-label="Lọc theo thẻ"]')!;
    tag.value = 'hỏi sỉ';
    await fire(tag, 'change');
    expect(ids(host).sort()).toEqual(['lan', 'minh']);
    const due = q<HTMLSelectElement>(host, 'select[aria-label="Lọc theo hạn chăm"]')!;
    due.value = 'late';
    await fire(due, 'change');
    expect(ids(host)).toEqual(['minh']);
    const search = q<HTMLInputElement>(host, '[data-testid="crm-search"]')!;
    search.value = 'xyz';
    await fire(search, 'input');
    expect(host.textContent).toContain('Không có khách nào khớp bộ lọc');
  });

  it('saves a filter to this browser, shows it with a count, and restores it on the next visit', async () => {
    const storage = new MemStorage();
    const first = await mount(<CrmAll api={fakeApi()} now={now} storage={storage as never} />);
    const tag = q<HTMLSelectElement>(first.host, 'select[aria-label="Lọc theo thẻ"]')!;
    tag.value = 'hỏi sỉ';
    await fire(tag, 'change');
    await fire(q(first.host, '[data-testid="crm-save-filter"]')!, 'click');
    const name = q<HTMLInputElement>(first.host, '[data-testid="crm-filter-name"]')!;
    name.value = 'Khách sỉ';
    await fire(name, 'input');
    await fire(q(first.host, 'form')!, 'submit');
    const saved = q(first.host, '[data-testid="crm-saved-filter"]')!;
    expect(saved.textContent).toContain('Khách sỉ');
    expect(saved.textContent).toContain('2');
    expect(JSON.parse(storage.data.get(SAVED_FILTERS_KEY)!)).toMatchObject([{ name: 'Khách sỉ', filter: { tag: 'hỏi sỉ' } }]);
    first.unmount();

    const second = await mount(<CrmAll api={fakeApi()} now={now} storage={storage as never} />);
    cleanup = second.unmount;
    expect(ids(second.host)).toHaveLength(4);
    await fire(q(second.host, '[data-testid="crm-saved-filter"] button')!, 'click');
    expect(ids(second.host).sort()).toEqual(['lan', 'minh']);
    await fire(q(second.host, 'button[aria-label="Xoá bộ lọc Khách sỉ"]')!, 'click');
    expect(q(second.host, '[data-testid="crm-saved-filter"]')).toBeNull();
    expect(JSON.parse(storage.data.get(SAVED_FILTERS_KEY)!)).toEqual([]);
  });

  it('ignores unreadable saved filters instead of failing', async () => {
    const storage = new MemStorage();
    storage.setItem(SAVED_FILTERS_KEY, '{not json');
    const { host, unmount } = await mount(<CrmAll api={fakeApi()} now={now} storage={storage as never} />);
    cleanup = unmount;
    expect(ids(host)).toHaveLength(4);
  });

  it('works from the database with a banner when no notes folder is set', async () => {
    const { host, unmount } = await mount(<CrmAll api={fakeApi({ status: (async () => STATUS_NONE) as never })} now={now} storage={new MemStorage() as never} />);
    cleanup = unmount;
    await settle();
    expect(q(host, '[data-testid="crm-not-configured"]')!.textContent).toContain('Chưa chọn thư mục Second Brain');
    expect(ids(host)).toHaveLength(4);
  });
});
