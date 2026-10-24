export const CANVAS_BLOCKS = [
  { id: 'partners', title: 'Đối tác chính', hint: 'Ai giúp bạn tạo và giao giá trị?', skills: 'sop-builder', area: 'col-start-1 row-start-1 row-span-2' },
  { id: 'activities', title: 'Hoạt động chính', hint: 'Việc nào bắt buộc phải làm tốt?', skills: 'sop-builder · process-automation-audit', area: 'col-start-2 row-start-1' },
  { id: 'resources', title: 'Nguồn lực chính', hint: 'Con người, dữ liệu, tài sản và năng lực nào?', skills: 'knowledge-base-builder', area: 'col-start-2 row-start-2' },
  { id: 'value', title: 'Giá trị cốt lõi', hint: 'Giải quyết vấn đề gì? Vì sao khách chọn bạn?', skills: 'value-proposition-canvas · thiet-ke-offer', area: 'col-start-3 row-start-1 row-span-2' },
  { id: 'relationships', title: 'Quan hệ khách hàng', hint: 'Tư vấn, phục vụ và giữ khách bằng cách nào?', skills: 'crm-lifecycle-builder', area: 'col-start-4 row-start-1' },
  { id: 'channels', title: 'Kênh phân phối', hint: 'Khách biết, mua và nhận giá trị ở đâu?', skills: 'marketing-strategy-planner', area: 'col-start-4 row-start-2' },
  { id: 'segments', title: 'Phân khúc khách hàng', hint: 'Ai mua? Ai dùng? Ai là người quyết định?', skills: 'customer-persona · customer-segmentation', area: 'col-start-5 row-start-1 row-span-2' },
  { id: 'costs', title: 'Cơ cấu chi phí', hint: 'Chi phí cố định, biến đổi và chi phí phục vụ?', skills: 'cost-analysis · unit-economics', area: 'col-start-1 col-span-2 row-start-3' },
  { id: 'revenue', title: 'Dòng doanh thu', hint: 'Khách trả tiền cho gì? Theo giao dịch hay định kỳ?', skills: 'pricing-analysis · unit-economics', area: 'col-start-3 col-span-3 row-start-3' },
] as const;

export const PARAMS = [
  { id: 'productType', title: 'Loại sản phẩm', key: 'loai-san-pham', options: ['vat-ly', 'dich-vu', 'so', 'hon-hop'] },
  { id: 'buyerIsUser', title: 'Người mua là người dùng', key: 'nguoi-mua-la-nguoi-dung', options: ['co', 'khong', 'hon-hop'] },
  { id: 'seasonality', title: 'Mùa vụ', key: 'mua-vu', options: ['co-mua', 'deu', 'chua-xac-dinh'] },
  { id: 'touchpointOwnership', title: 'Sở hữu điểm chạm', key: 'so-huu-diem-cham', options: ['co', 'ban-tren-san', 'hon-hop'] },
  { id: 'repurchase', title: 'Mô hình mua lại', key: 'mo-hinh-mua-lai', options: ['mot-lan', 'lien-tuc', 'theo-ky'] },
] as const;

export const PARAM_LABELS: Record<string, string> = {
  'vat-ly': 'Sản phẩm vật lý', 'dich-vu': 'Dịch vụ', so: 'Sản phẩm số',
  'hon-hop': 'Hỗn hợp', co: 'Có', khong: 'Không',
  'co-mua': 'Có mùa vụ', deu: 'Đều quanh năm', 'chua-xac-dinh': 'Chưa có kết luận',
  'ban-tren-san': 'Bán trên sàn / nền tảng đối tác',
  'mot-lan': 'Mua một lần', 'lien-tuc': 'Mua lại liên tục', 'theo-ky': 'Mua lại theo kỳ',
};

export type CanvasId = typeof CANVAS_BLOCKS[number]['id'];
export type ParamId = typeof PARAMS[number]['id'];
export interface BusinessModelDraft {
  version: 1;
  company: string;
  summary: string;
  source: string;
  canvas: Record<CanvasId, string>;
  parameters: Record<ParamId, string> & { salesCycleDays: string };
}

export const BUSINESS_DRAFT_KEY = 'claudeclaw.business-model.v1';

export function emptyDraft(): BusinessModelDraft {
  return {
    version: 1, company: '', summary: '', source: '',
    canvas: Object.fromEntries(CANVAS_BLOCKS.map(b => [b.id, ''])) as Record<CanvasId, string>,
    parameters: { productType: '', buyerIsUser: '', seasonality: '', touchpointOwnership: '', repurchase: '', salesCycleDays: '' },
  };
}

export function parseDraft(raw: string): BusinessModelDraft {
  const value = JSON.parse(raw);
  if (!value || value.version !== 1 || !value.canvas || !value.parameters) throw new Error('Hồ sơ phải là JSON phiên bản 1 xuất từ page này.');
  const draft = emptyDraft();
  for (const key of ['company', 'summary', 'source'] as const) {
    if (typeof value[key] !== 'string' || value[key].length > 20000) throw new Error(`Trường ${key} không hợp lệ.`);
    draft[key] = value[key];
  }
  for (const { id } of CANVAS_BLOCKS) {
    if (typeof value.canvas[id] !== 'string' || value.canvas[id].length > 20000) throw new Error(`Ô ${id} không hợp lệ.`);
    draft.canvas[id] = value.canvas[id];
  }
  for (const { id, options } of PARAMS) {
    const v = value.parameters[id];
    if (typeof v !== 'string' || (v !== '' && !(options as readonly string[]).includes(v))) throw new Error(`Tham số ${id} không hợp lệ.`);
    draft.parameters[id] = v;
  }
  const days = value.parameters.salesCycleDays;
  if (typeof days !== 'string' || (days !== '' && (!Number.isFinite(Number(days)) || Number(days) <= 0 || !days.trim()))) throw new Error('Chu kỳ bán phải là số ngày lớn hơn 0.');
  draft.parameters.salesCycleDays = days;
  return draft;
}

export function modelMarkdown(draft: BusinessModelDraft): string {
  const params = PARAMS.map(p => `- ${p.key}: ${draft.parameters[p.id] || 'chưa có dữ liệu'}`);
  params.splice(1, 0, `- chu-ky-ban-ngay: ${draft.parameters.salesCycleDays || 'chưa có dữ liệu'}`);
  return [
    `# Mô hình kinh doanh — ${draft.company || 'Chưa đặt tên'}`,
    '> Bản nháp xuất từ FreedomOS. Cần duyệt trước khi dùng làm ngữ cảnh chính thức.',
    draft.summary || 'Chưa có mô tả.',
    `Nguồn: ${draft.source || 'Chưa gắn nguồn'}`,
    ...CANVAS_BLOCKS.map(b => `## ${b.title}\n\n${draft.canvas[b.id] || 'Chưa có dữ liệu.'}`),
    `## Sáu tham số vận hành\n\n${params.join('\n')}`,
    '## Kết nối\n\n- [[_MOC 00. Business Context]]\n- [[Hồ Sơ Mô Hình Kinh Doanh]]\n- [[Bản Đồ Ứng Dụng AI — Sale & Marketing]]',
  ].join('\n\n') + '\n';
}

export const SKILL_WORKFLOWS = [
  { title: 'Nền tảng doanh nghiệp', owner: 'Chủ doanh nghiệp + agent điều phối', chain: 'mo-hinh-kinh-doanh → hoan-tat-business-context → ban-do-ai-sale-mkt', input: '9 ô, chân dung khách, offer và quy trình thật', output: '00. Business Context/', surface: 'Mô hình kinh doanh', review: 'Duyệt hồ sơ trước khi dùng chung' },
  { title: 'Nghiên cứu & chiến lược', owner: 'Agent research / main', chain: 'chan-doan-nhanh → marketing-strategy-planner', input: 'Business Context đã duyệt + dữ liệu thị trường', output: '04. Resources/ + 02. Projects/', surface: 'Chat → Mission Control', review: 'Duyệt hướng chiến dịch' },
  { title: 'Nội dung đa kênh', owner: 'Agent content', chain: 'content-plan-builder → content-copywriter → social-media-calendar', input: 'Phân khúc, Brand Voice, bằng chứng và brief', output: 'Bản nháp chiến dịch → content đã đăng', surface: 'FB · Kho content / Lịch đăng', review: 'Duyệt bài trước khi xuất bản' },
  { title: 'Quảng cáo & thử nghiệm', owner: 'Agent marketing', chain: 'ads-strategy-planner → ads-testing-designer → ads-performance-diagnostic', input: 'Offer, ngân sách đã duyệt và số liệu thực', output: 'Kế hoạch test + báo cáo + bài học', surface: 'FB · Quảng cáo', review: 'Duyệt ngân sách và bật/tắt ads' },
  { title: 'CRM & chăm sóc khách', owner: 'Agent sale / comms', chain: 'ghi-cuoc-gap → crm-lifecycle-builder', input: 'Hội thoại, hồ sơ khách và quyền liên hệ', output: 'Meetings/ + People/ + bài học khách hàng', surface: 'Zalo · Chat / Agent chăm', review: 'Kiểm tra hồ sơ và tin gửi ra ngoài' },
  { title: 'Đo lường & cải tiến', owner: 'Agent ops / analytics', chain: 'mkt-marketing-measurement-designer → mkt-marketing-report-writer', input: 'Dữ liệu kênh, CRM, doanh thu có nguồn', output: '03. Areas/Analytics & Reporting/', surface: 'Scheduled → Bunker → Second brain', review: 'Duyệt kết luận và việc kế tiếp' },
] as const;
