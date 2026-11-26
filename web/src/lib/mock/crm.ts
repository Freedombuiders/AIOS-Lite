// Mock of /api/m/crm/* and the bits of /api/m/care/* the customer screens write through, for the UI preview.
// Add ?mock=1 to the URL. To see the "no folder" banner run sessionStorage.setItem('aios.mock.crm', 'unconfigured').
import * as d from './data';

type Handler = (params: string[], q: URLSearchParams, body: any) => unknown;
export const crmMockRoutes: Array<[string, string, Handler]> = [];

class CrmMockError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
export { CrmMockError };

const DAY = 86_400_000;
const HOUR = 3_600_000;
const FOLDER = 'ban-hang';
type Stage = 'new' | 'consulting' | 'quoted' | 'deposit' | 'won' | 'lost';
const SLUG: Record<Stage, string> = { new: 'moi', consulting: 'dang-tu-van', quoted: 'da-bao-gia', deposit: 'dat-coc', won: 'da-chot', lost: 'mat' };
const STAGE_VI: Record<Stage, string> = { new: 'Mới', consulting: 'Đang tư vấn', quoted: 'Đã báo giá', deposit: 'Đặt cọc', won: 'Đã chốt', lost: 'Mất' };
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const unconfigured = () => {
  try { return sessionStorage.getItem('aios.mock.crm') === 'unconfigured'; } catch { return false; }
};

interface MockTask { id: string; title: string; dueAtMs: number; done: boolean; revision: number }
interface MockCustomer {
  id: string; ten: string; sdt: string | null; email: string | null; congTy: string | null; stage: Stage; the: string[];
  revision: number; capNhatMs: number; tasks: MockTask[]; need: Array<{ field: string; label: string; value: string }>; note: string | null; log: Array<{ atMs: number; text: string }>;
}

const now = Date.now();
const mk = (ten: string, stage: Stage, o: Partial<MockCustomer> & { due?: [string, number] }): MockCustomer => {
  const id = `c-${slug(ten)}`;
  return {
    id, ten, sdt: o.sdt ?? null, email: o.email ?? null, congTy: o.congTy ?? null, stage, the: o.the ?? [], revision: 3, capNhatMs: o.capNhatMs ?? now - DAY,
    tasks: o.due ? [{ id: `t-${id}`, title: o.due[0], dueAtMs: now + o.due[1], done: false, revision: 1 }] : [],
    need: o.need ?? [], note: o.note ?? null,
    log: o.log ?? [{ atMs: now - 3 * DAY, text: 'Tạo khách' }],
  };
};

const customers: MockCustomer[] = [
  mk('Chị Hoa', 'new', { sdt: '0987000111', the: ['quà tết'], due: ['Trả lời tin Combo Tết', -2 * HOUR], capNhatMs: now - 3 * HOUR }),
  mk('Anh Tuấn', 'new', { sdt: '0912000222', the: ['hỏi sỉ'] }),
  mk('Chị Lan', 'consulting', {
    sdt: '0901234567', congTy: 'Cửa hàng Lan Anh', the: ['hỏi sỉ', 'ô long sen'], due: ['Gửi báo giá 60 hộp ô long sen', 2 * HOUR], capNhatMs: now - HOUR,
    need: [{ field: 'service', label: 'Dịch vụ', value: 'Trà ô long sen để bán ở cửa hàng' }, { field: 'people', label: 'Số người', value: '60 hộp' }, { field: 'budget', label: 'Ngân sách', value: 'Khoảng 14 triệu' }],
    note: 'Hay nhắn buổi tối. Muốn được chiết khấu khi nhập 60 hộp.',
    log: [{ atMs: now - HOUR, text: 'Đổi giai đoạn: Mới → Đang tư vấn' }, { atMs: now - 2 * HOUR, text: 'Cập nhật nhu cầu' }, { atMs: now - 2 * HOUR, text: 'Thêm việc: Gửi báo giá 60 hộp ô long sen' }, { atMs: now - 5 * HOUR, text: 'Tạo khách' }],
  }),
  mk('Cửa hàng An Nhiên', 'consulting', { sdt: '0933555666', the: ['đại lý'], due: ['Gọi lại, khách muốn lấy thử 10 hộp', 2 * DAY] }),
  mk('Chị Thu', 'consulting', { the: ['quà tặng công ty'] }),
  mk('Anh Minh', 'quoted', { sdt: '0944777888', the: ['hỏi sỉ', 'trà sen tây hồ'], due: ['Hỏi lại báo giá 200 hộp', -3 * DAY], capNhatMs: now - 4 * DAY }),
  mk('Cô Hạnh', 'quoted', { sdt: '0966111999', the: ['đại lý'], due: ['Hỏi lại đại lý cấp 2', 4 * DAY] }),
  mk('Anh Dũng', 'deposit', { sdt: '0977222333', due: ['Xác nhận ngày giao 80 hộp', DAY] }),
  mk('Trà quán Mộc', 'won', { sdt: '0922888777', the: ['đại lý'], due: ['Chăm định kỳ', 9 * DAY] }),
  mk('Chị Ngân', 'won', { sdt: '0955333444', the: ['mua lẻ'] }),
  mk('Anh Phúc', 'lost', { the: ['hỏi sỉ'] }),
];

const find = (id: string) => {
  const c = customers.find((x) => x.id === id);
  if (!c) throw new CrmMockError(404, 'not_found', 'Không tìm thấy khách này.');
  return c;
};

/** the note as it would be on disk, built from the same data */
const noteOf = (c: MockCustomer) => {
  const next = c.tasks.find((t) => !t.done);
  const fm = [
    '---', 'loai: khach-hang', `id: ${c.id}`, `ten: ${c.ten}`, ...(c.sdt ? [`sdt: "${c.sdt}"`] : []), `giai_doan: ${SLUG[c.stage]}`,
    ...(c.the.length ? [`the: [${c.the.map(slug).join(', ')}]`] : []), ...(next ? [`viec_tiep: ${next.title}`, `han: ${new Date(next.dueAtMs + 7 * HOUR).toISOString().slice(0, 10)}`] : []),
    `cap_nhat: ${new Date(c.capNhatMs).toISOString()}`, 'nguon: Bài đăng "Trà sen Tây Hồ"', '---',
  ];
  return `${fm.join('\n')}\n# ${c.ten}\n\n<!-- aios:begin khach-can-gi -->\n## Khách cần gì\n\n${c.need.length ? c.need.map((n) => `- ${n.label}: ${n.value}`).join('\n') : 'Chưa có thông tin.'}\n<!-- aios:end khach-can-gi -->\n\nGhi chú của tôi: khách này hay hỏi giá lúc 9 giờ tối.\n\n<!-- aios:begin nhat-ky -->\n## Nhật ký\n\n${c.log.map((l) => `- ${new Date(l.atMs + 7 * HOUR).toISOString().slice(0, 16).replace('T', ' ')} · ${l.text}`).join('\n')}\n<!-- aios:end nhat-ky -->\n`;
};

const row = (c: MockCustomer) => {
  const open = c.tasks.filter((t) => !t.done).sort((a, b) => a.dueAtMs - b.dueAtMs);
  const folder = unconfigured() ? null : FOLDER;
  return {
    id: c.id, ten: c.ten, sdt: c.sdt, email: c.email, congTy: c.congTy, giaiDoan: c.stage, giaiDoanGhiChu: SLUG[c.stage], the: c.the,
    viecTiep: open[0] ? { id: open[0].id, title: open[0].title, dueAtMs: open[0].dueAtMs } : null, soViec: open.length, revision: c.revision, capNhatMs: c.capNhatMs,
    folderId: folder, notePath: folder ? `khach-hang/${slug(c.ten)}.md` : null, exportedAt: folder ? c.capNhatMs + 1000 : null, trangThai: folder ? 'da-xuat' : 'chua-xuat',
  };
};

crmMockRoutes.push(['GET', '/m/crm/status', () => (unconfigured()
  ? { state: 'chua-cau-hinh', message: 'Chưa chọn thư mục Second Brain cho ghi chú khách. Vào cài đặt module CRM, điền mã thư mục.', running: false }
  : { state: 'san-sang', message: 'Ghi chú khách đã khớp với dữ liệu.', folderId: FOLDER, exported: customers.length })]);
crmMockRoutes.push(['GET', '/m/crm/customers', () => ({ items: customers.map(row), next: null })]);
crmMockRoutes.push(['GET', '/m/crm/customers/:id', ([id]) => {
  const c = find(id!);
  return { ...row(c), nhuCau: c.need, ghiChuChamSoc: c.note, viecMo: c.tasks.filter((t) => !t.done), nhatKy: c.log };
}]);
crmMockRoutes.push(['GET', '/m/care/customers/:id', ([id]) => {
  const c = find(id!);
  return {
    id: c.id, revision: c.revision,
    conversations: [{ id: `conv-${c.id}`, title: c.ten, channel: 'zalo', primaryCustomerId: c.id, lastActivityMs: c.capNhatMs }],
    tasks: c.tasks,
  };
}]);
crmMockRoutes.push(['PUT', '/m/care/conversations/:id/customer-care', ([id], _q, b) => {
  const c = find(id!.replace(/^conv-/, ''));
  if (b.expectedCustomerRevision !== c.revision) throw new CrmMockError(409, 'STALE_REVISION', 'Hồ sơ vừa được sửa ở nơi khác.');
  const to = b.customer?.stage as Stage | undefined;
  if (to) {
    c.log.unshift({ atMs: Date.now(), text: `Đổi giai đoạn: ${STAGE_VI[c.stage]} → ${STAGE_VI[to]}` });
    c.stage = to;
  }
  c.revision += 1;
  c.capNhatMs = Date.now();
  return { ok: true };
}]);
crmMockRoutes.push(['PATCH', '/m/care/tasks/:id', ([id], _q, b) => {
  for (const c of customers) {
    const t = c.tasks.find((x) => x.id === id);
    if (!t) continue;
    if (b.expectedRevision !== t.revision) throw new CrmMockError(409, 'STALE_REVISION', 'Việc vừa được sửa ở nơi khác.');
    if (typeof b.done === 'boolean') { t.done = b.done; c.log.unshift({ atMs: Date.now(), text: `Xong việc: ${t.title}` }); }
    if (typeof b.dueAtMs === 'number') { t.dueAtMs = b.dueAtMs; c.log.unshift({ atMs: Date.now(), text: `Đổi hạn việc: ${t.title}` }); }
    t.revision += 1;
    c.capNhatMs = Date.now();
    return { ...t, customerId: c.id };
  }
  throw new CrmMockError(404, 'not_found', 'Không tìm thấy việc này.');
}]);

// the notes themselves: the existing mock GET /brain/file reads d.brainFiles
for (const c of customers) Object.defineProperty(d.brainFiles, `${FOLDER}:khach-hang/${slug(c.ten)}.md`, { enumerable: true, configurable: true, get: () => noteOf(c) });

// the module itself, so it shows as on and /m/crm/* routes are mounted
if (!d.modules.some((m) => m.manifest.id === 'crm')) {
  d.modules.push({
    manifest: { id: 'crm', name: 'Khách hàng (ghi chú)', description: 'Mỗi khách trong Chăm sóc khách hàng có một ghi chú khach-hang/<ten>.md trong Second Brain.', version: '0.1.0', category: 'sales', requires: { modules: ['care'] }, tables: ['crm_note_index', 'crm_sync_state'] },
    state: { id: 'crm', enabled: true, version: '0.1.0', installedAt: new Date(now - 2 * DAY).toISOString(), settings: { folderId: FOLDER } },
    requirements: [{ kind: 'module', id: 'care', ok: true, message: 'Module care đã bật' }], ready: true, hasServer: true, hasWeb: true, agentTemplates: [],
  });
}
