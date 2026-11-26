import { describe, expect, it } from 'vitest';
import type { CareCustomerHistoryEntry, CareCustomerView } from '../../care/server/customers-service.js';
import { customerDetail, customerRow } from './views.js';

const view = (over: Partial<CareCustomerView> = {}): CareCustomerView => ({
  id: 'c1', displayName: 'Chị Lan', phone: '0901234567', email: null, company: null, stage: 'consulting', tags: ['hỏi sỉ', 'ô long sen'], owner: null,
  revision: 3, createdAtMs: 1000, updatedAtMs: 2000, lastChangeAtMs: 5000,
  need: [{ field: 'service', value: 'Trà ô long sen' }], careNote: 'Hay nhắn buổi tối',
  openTasks: [{ id: 't1', title: 'Gửi báo giá', dueAtMs: 9000 }, { id: 't2', title: 'Gọi lại', dueAtMs: 9500 }],
  ...over,
});

describe('customerRow', () => {
  it('maps the fields the note machine-owns, with the earliest open follow-up', () => {
    const r = customerRow(view(), undefined, null);
    expect(r).toMatchObject({ id: 'c1', ten: 'Chị Lan', sdt: '0901234567', giaiDoan: 'consulting', giaiDoanGhiChu: 'dang-tu-van', the: ['hỏi sỉ', 'ô long sen'], soViec: 2, revision: 3 });
    expect(r.viecTiep).toEqual({ id: 't1', title: 'Gửi báo giá', dueAtMs: 9000 });
  });

  it('has no note data when no folder is set or the note sits in another folder', () => {
    const row = { folder_id: 'a', rel_path: 'khach-hang/chi-lan.md', exported_at: 9999 };
    expect(customerRow(view(), row, null)).toMatchObject({ notePath: null, folderId: null, trangThai: 'chua-xuat' });
    expect(customerRow(view(), row, 'b')).toMatchObject({ notePath: null, trangThai: 'chua-xuat' });
  });

  it('tells a written note from one that waits for the next export', () => {
    const row = { folder_id: 'a', rel_path: 'khach-hang/chi-lan.md', exported_at: 6000 };
    expect(customerRow(view(), row, 'a')).toMatchObject({ notePath: 'khach-hang/chi-lan.md', folderId: 'a', trangThai: 'da-xuat' });
    expect(customerRow(view({ lastChangeAtMs: 7000 }), row, 'a').trangThai).toBe('cho-xuat');
  });

  it('has no follow-up when none is open', () => {
    expect(customerRow(view({ openTasks: [] }), undefined, null)).toMatchObject({ viecTiep: null, soViec: 0 });
  });
});

describe('customerDetail', () => {
  it('adds needs, open follow-ups and a short activity log without message text', () => {
    const history: CareCustomerHistoryEntry[] = [
      { id: 2, customerId: 'c1', entity: 'customer', entityId: 'c1', op: 'update', atMs: 5000, detail: { stage_from: 'new', stage_to: 'consulting' }, taskTitle: null },
      { id: 1, customerId: 'c1', entity: 'customer', entityId: 'c1', op: 'insert', atMs: 1000, detail: null, taskTitle: null },
    ] as unknown as CareCustomerHistoryEntry[];
    const d = customerDetail(view(), history, undefined, null);
    expect(d.nhuCau).toEqual([{ field: 'service', label: 'Dịch vụ', value: 'Trà ô long sen' }]);
    expect(d.ghiChuChamSoc).toBe('Hay nhắn buổi tối');
    expect(d.viecMo).toHaveLength(2);
    expect(d.nhatKy).toEqual([{ atMs: 5000, text: 'Đổi giai đoạn: Mới → Đang tư vấn' }, { atMs: 1000, text: 'Tạo khách' }]);
  });
});
