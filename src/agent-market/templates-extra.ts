import type { MarketTemplate } from './catalog.js';

const brief = (key: string, label: string, placeholder: string, extra: Partial<MarketTemplate['fields'][number]> = {}) => ({ key, label, step: 0, multiline: true, placeholder, ...extra });

export const EXTRA_TEMPLATES: MarketTemplate[] = [
  {
    id: 'research-analyst', version: 1, name: 'Nghiên cứu thị trường', category: 'Nghiên cứu',
    description: 'Tìm, đối chiếu và tóm tắt thông tin về thị trường, đối thủ và xu hướng, luôn kèm nguồn.',
    outcome: 'Báo cáo ngắn có nguồn, tách rõ dữ kiện và suy đoán.',
    capabilities: ['Tóm tắt đối thủ', 'Tổng hợp xu hướng', 'Đối chiếu nguồn', 'Nêu mức chắc chắn'],
    steps: ['Bối cảnh'],
    fields: [
      brief('business', 'Doanh nghiệp và lĩnh vực', 'Bạn bán gì, cho ai, ở thị trường nào.', { required: true }),
      brief('questions', 'Câu hỏi cần theo dõi', 'Ví dụ: đối thủ nào đang giảm giá, kênh nào tăng trưởng.'),
    ],
    examples: ['Tóm tắt 3 đối thủ chính tuần này', 'Xu hướng nào đáng thử trong quý tới?'],
    persona: `Bạn là chuyên viên nghiên cứu thị trường. Mọi nhận định phải kèm nguồn hoặc ghi rõ "chưa có nguồn".
Tách ba phần trong mỗi báo cáo: dữ kiện đã kiểm chứng, suy luận của bạn, điều còn chưa biết.
Không bịa số liệu. Không chắc thì nói không chắc. Trả lời tiếng Việt, ngắn gọn, ưu tiên gạch đầu dòng.
Đọc knowledge/customer-care.md để nắm bối cảnh doanh nghiệp trước khi nghiên cứu.`,
  },
  {
    id: 'content-writer', version: 1, name: 'Biên tập nội dung', category: 'Nội dung',
    description: 'Viết bài, caption và email theo giọng thương hiệu; mọi bản thảo chờ bạn duyệt.',
    outcome: 'Bản nháp đúng giọng thương hiệu trong lần đầu.',
    capabilities: ['Viết caption và bài đăng', 'Soạn email', 'Gợi ý 3 hook', 'Giữ giọng thương hiệu'],
    steps: ['Thương hiệu'],
    fields: [
      brief('brand', 'Tên thương hiệu và sản phẩm', 'Tên, sản phẩm chủ lực, điểm khác biệt.', { required: true }),
      brief('voice', 'Giọng thương hiệu', 'Thân thiện hay chuyên gia? Xưng hô thế nào?', { defaultValue: 'Thân thiện, rõ ràng, không phóng đại.' }),
      brief('rules', 'Điều không được viết', 'Cam kết, từ ngữ, chủ đề cần tránh.'),
    ],
    examples: ['Viết 3 caption cho đợt khuyến mãi cuối tuần', 'Soạn email nhắc khách giỏ hàng bỏ quên'],
    persona: `Bạn là biên tập viên nội dung. Viết đúng giọng và các quy tắc trong knowledge/customer-care.md.
Mỗi bài đưa 3 phương án mở đầu. Không cam kết kết quả, không dùng số liệu chưa được cung cấp.
Bạn chỉ soạn bản nháp; không tự đăng hay gửi. Trả lời tiếng Việt tự nhiên.`,
  },
  {
    id: 'ops-reporter', version: 1, name: 'Báo cáo vận hành', category: 'Vận hành',
    description: 'Đọc tình hình công việc và chi phí của hệ thống, viết báo cáo ngắn mỗi ngày hoặc tuần.',
    outcome: 'Một báo cáo ngắn nêu việc kẹt, chi phí và việc cần bạn quyết.',
    capabilities: ['Tóm tắt việc đang chạy', 'Nêu việc thất bại', 'Báo chi phí theo agent', 'Đề xuất bước tiếp theo'],
    steps: ['Ưu tiên'],
    fields: [brief('focus', 'Điều bạn quan tâm nhất', 'Ví dụ: chi phí, việc chậm, chất lượng trả lời.')],
    examples: ['Báo cáo tuần này', 'Agent nào tốn nhiều nhất?'],
    persona: `Bạn là người viết báo cáo vận hành cho chủ hệ thống. Chỉ báo cáo điều có trong dữ liệu được cung cấp.
Cấu trúc: việc cần chủ quyết trước, rồi việc thất bại hoặc kẹt, rồi chi phí. Mỗi mục tối đa 3 gạch đầu dòng.
Không bịa số. Trả lời tiếng Việt, ngắn gọn.`,
  },
];
