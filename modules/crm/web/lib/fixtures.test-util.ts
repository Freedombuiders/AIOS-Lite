import { vi } from 'vitest';
import type { CareCustomerLite, CrmApi, CrmStatus, CustomerDetailDto, CustomerRowDto } from './types';

export const NOW = Date.UTC(2026, 10, 26, 3, 0, 0); // 26/11/2026 10:00 in Vietnam
const H = 3_600_000;
const D = 24 * H;

export const row = (o: Partial<CustomerRowDto> & Pick<CustomerRowDto, 'id' | 'ten'>): CustomerRowDto => ({
  sdt: null, email: null, congTy: null, giaiDoan: 'new', giaiDoanGhiChu: 'moi', the: [], viecTiep: null, soViec: 0, revision: 2, capNhatMs: NOW - D,
  folderId: 'ban-hang', notePath: `khach-hang/${o.id}.md`, exportedAt: NOW, trangThai: 'da-xuat', ...o,
});

export const ROWS: CustomerRowDto[] = [
  row({ id: 'hoa', ten: 'Chị Hoa', giaiDoan: 'new', giaiDoanGhiChu: 'moi', the: ['quà tết'], viecTiep: { id: 't-hoa', title: 'Trả lời tin Combo Tết', dueAtMs: NOW - 2 * H }, soViec: 1 }),
  row({ id: 'lan', ten: 'Chị Lan', sdt: '0901234567', giaiDoan: 'consulting', giaiDoanGhiChu: 'dang-tu-van', the: ['hỏi sỉ', 'ô long sen'], viecTiep: { id: 't-lan', title: 'Gửi báo giá', dueAtMs: NOW + 2 * D }, soViec: 1 }),
  row({ id: 'minh', ten: 'Anh Minh', giaiDoan: 'quoted', giaiDoanGhiChu: 'da-bao-gia', the: ['hỏi sỉ'], viecTiep: { id: 't-minh', title: 'Hỏi lại báo giá', dueAtMs: NOW - 3 * D }, soViec: 1 }),
  row({ id: 'tuan', ten: 'Anh Tuấn', giaiDoan: 'new', giaiDoanGhiChu: 'moi', notePath: null, folderId: null, trangThai: 'chua-xuat' }),
];

export const DETAIL_LAN: CustomerDetailDto = {
  ...ROWS[1]!,
  nhuCau: [{ field: 'service', label: 'Dịch vụ', value: 'Trà ô long sen' }, { field: 'people', label: 'Số người', value: '60 hộp' }],
  ghiChuChamSoc: 'Hay nhắn buổi tối',
  viecMo: [{ id: 't-lan', title: 'Gửi báo giá', dueAtMs: NOW + 2 * D }],
  nhatKy: [{ atMs: NOW - H, text: 'Đổi giai đoạn: Mới → Đang tư vấn' }, { atMs: NOW - 5 * H, text: 'Tạo khách' }],
};

export const CARE_LAN: CareCustomerLite = {
  id: 'lan', revision: 2,
  conversations: [
    { id: 'conv-old', title: 'Nhóm khác', channel: 'zalo', primaryCustomerId: 'someone-else', lastActivityMs: NOW },
    { id: 'conv-lan', title: 'Chị Lan', channel: 'zalo', primaryCustomerId: 'lan', lastActivityMs: NOW - H },
  ],
  tasks: [
    { id: 't-lan', title: 'Gửi báo giá', dueAtMs: NOW + 2 * D, done: false, revision: 4 },
    { id: 't-old', title: 'Việc đã xong', dueAtMs: NOW - D, done: true, revision: 1 },
  ],
};

export const STATUS_OK: CrmStatus = { state: 'san-sang', message: 'Ghi chú khách đã khớp với dữ liệu.', folderId: 'ban-hang' };
export const STATUS_NONE: CrmStatus = { state: 'chua-cau-hinh', message: 'Chưa chọn thư mục Second Brain cho ghi chú khách.' };

/** A fake server: every method is a spy with a sensible default; pass overrides to change one. */
export function fakeApi(over: Partial<CrmApi> = {}): CrmApi & { [K in keyof CrmApi]: ReturnType<typeof vi.fn> } {
  const api = {
    status: vi.fn(async () => STATUS_OK),
    customers: vi.fn(async () => ROWS.map((r) => ({ ...r }))),
    customer: vi.fn(async () => DETAIL_LAN),
    careCustomer: vi.fn(async () => CARE_LAN),
    noteFile: vi.fn(async () => ({ content: '---\nloai: khach-hang\nten: Chị Lan\n---\n# Chị Lan\n' })),
    brainFolders: vi.fn(async () => [{ id: 'ban-hang', name: 'Bán hàng', path: '/Users/me/Brain/ban-hang' }]),
    changeStage: vi.fn(async () => undefined),
    patchTask: vi.fn(async () => undefined),
    ...over,
  };
  return api as never;
}
