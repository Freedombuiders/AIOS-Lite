// Mock data + routes for /api/integrations (Pancake, Botcake, Composio…). No secrets.
import type { AttentionItem, IntegrationGrantSetting } from '@core/types';
import type { IntegrationApproval, IntegrationCommand, IntegrationSummary } from '../integrations';

const mins = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const cmd = (name: string, risk: IntegrationCommand['risk'], description: string, usage = ''): IntegrationCommand => ({ name, access: risk === 'read' ? 'read' : 'write', risk, usage: usage || name, description });

const pancakeCommands: IntegrationCommand[] = [
  cmd('shops list', 'read', 'Danh sách shop'), cmd('orders list', 'read', 'Liệt kê đơn hàng', 'orders list --status new'), cmd('orders get', 'read', 'Chi tiết một đơn'),
  cmd('orders create', 'write', 'Tạo đơn mới', 'orders create {json}'), cmd('orders update', 'write', 'Sửa đơn'), cmd('orders set-status', 'write', 'Đổi trạng thái đơn'),
  cmd('orders cancel', 'destructive', 'Huỷ đơn'), cmd('customers list', 'read', 'Danh sách khách'), cmd('customers get', 'read', 'Chi tiết khách'),
  cmd('customers update', 'write', 'Sửa thông tin khách'), cmd('products list', 'read', 'Danh sách sản phẩm'), cmd('products get', 'read', 'Chi tiết sản phẩm'),
  cmd('inventory list', 'read', 'Tồn kho'), cmd('conversations list', 'read', 'Hội thoại chat'), cmd('messages list', 'read', 'Tin nhắn của hội thoại'),
  cmd('messages send', 'write', 'Gửi tin nhắn cho khách'), cmd('tags set', 'write', 'Gắn nhãn hội thoại'),
];

const secret = (key: string, label: string, value = '', help?: string) => ({ key, label, kind: 'secret' as const, required: true, value, help });

export const integrations: IntegrationSummary[] = [
  {
    id: 'pancake', name: 'Pancake', category: 'Bán hàng & chat', description: 'POS và chat đa kênh: đơn hàng, khách, tồn kho, hội thoại.', docsUrl: 'https://docs.pancake.vn', authKind: 'api-key',
    setupSteps: ['Vào Pancake POS › Cấu hình › Tích hợp API.', 'Tạo API key và sao chép.', 'Dán vào ô bên dưới rồi bấm Lưu & kiểm tra.'],
    fields: [secret('apiKey', 'API key', '••••k3x9'), { key: 'shopId', label: 'Shop ID', kind: 'text', required: true, value: '1029384', placeholder: '1029384' }],
    status: 'ok', statusDetail: 'Kết nối hoạt động', accountLabel: 'Shop Hoa Sen', checkedAt: mins(12), commands: pancakeCommands,
    grantedTo: [{ agentId: 'sales-a', grant: 'ask' }, { agentId: 'main', grant: 'read' }], calls24h: 42,
  },
  {
    id: 'botcake', name: 'Botcake', category: 'Bán hàng & chat', description: 'Chatbot Messenger/Zalo: kịch bản, nhãn, gửi flow cho khách.', docsUrl: 'https://botcake.io', authKind: 'api-key',
    setupSteps: ['Mở Botcake › Cài đặt › API.', 'Tạo token và sao chép.'],
    fields: [secret('token', 'Token'), { key: 'pageId', label: 'Page ID', kind: 'text', required: true, value: '', placeholder: '1000…' }],
    status: 'not_configured', statusDetail: '', accountLabel: '', checkedAt: null,
    commands: [cmd('flows list', 'read', 'Danh sách flow'), cmd('flows send', 'write', 'Gửi flow cho khách'), cmd('tags add', 'write', 'Gắn nhãn khách')], grantedTo: [], calls24h: 0,
  },
  {
    id: 'composio', name: 'Composio', category: 'Nền tảng', description: 'Cổng kết nối Gmail, Drive, Sheets, Facebook… bằng một khoá.', authKind: 'api-key',
    setupSteps: ['Đăng ký tại composio.dev và tạo API key.'], fields: [secret('apiKey', 'COMPOSIO_API_KEY', '••••7b21')],
    status: 'ok', statusDetail: '', accountLabel: 'Tài khoản chủ', checkedAt: mins(60), commands: [cmd('tools search', 'read', 'Tìm công cụ'), cmd('tools run', 'write', 'Chạy công cụ')],
    grantedTo: [{ agentId: 'main', grant: 'ask' }], calls24h: 7,
  },
  {
    id: 'pexels', name: 'Pexels', category: 'Tài nguyên media', description: 'Tìm ảnh và video miễn phí bản quyền.', docsUrl: 'https://www.pexels.com/api/', authKind: 'api-key',
    setupSteps: ['Đăng nhập pexels.com/api và lấy key.'], fields: [secret('apiKey', 'API key')],
    status: 'error', statusDetail: 'Pexels trả 401: key không hợp lệ.', accountLabel: '', checkedAt: mins(300), commands: [cmd('photos search', 'read', 'Tìm ảnh'), cmd('videos search', 'read', 'Tìm video')], grantedTo: [], calls24h: 0,
  },
  {
    id: 'freesound', name: 'Freesound', category: 'Tài nguyên media', description: 'Tìm hiệu ứng âm thanh.', authKind: 'api-key', setupSteps: [], fields: [secret('apiKey', 'API key')],
    status: 'not_configured', statusDetail: '', accountLabel: '', checkedAt: null, commands: [cmd('sounds search', 'read', 'Tìm âm thanh')], grantedTo: [], calls24h: 0,
  },
  {
    id: 'elevenlabs', name: 'ElevenLabs', category: 'Giọng nói', description: 'Tạo giọng đọc tiếng Việt chất lượng cao.', authKind: 'api-key', setupSteps: [], fields: [secret('apiKey', 'API key')],
    status: 'not_configured', statusDetail: '', accountLabel: '', checkedAt: null, commands: [cmd('voices list', 'read', 'Danh sách giọng'), cmd('speech create', 'write', 'Tạo file giọng đọc')], grantedTo: [], calls24h: 0,
  },
  {
    id: 'fpt-ai', name: 'FPT.AI', category: 'Giọng nói', description: 'Chuyển văn bản thành giọng đọc tiếng Việt.', authKind: 'api-key', setupSteps: [], fields: [secret('apiKey', 'API key')],
    status: 'unchecked', statusDetail: '', accountLabel: '', checkedAt: null, commands: [cmd('tts create', 'write', 'Tạo giọng đọc')], grantedTo: [], calls24h: 0,
  },
];

export const approvals: IntegrationApproval[] = [
  { id: 7, integrationId: 'pancake', agentId: 'sales-a', taskId: 2, command: 'orders create', args: '{"customer":"Minh Anh","items":[{"sku":"PRO-1","qty":1}],"note":"Gói Pro"}', risk: 'write', status: 'pending', createdAt: mins(3) },
  { id: 6, integrationId: 'pancake', agentId: 'sales-a', taskId: 2, command: 'tags set', args: '{"conversation":"c1","tag":"vip"}', risk: 'write', status: 'approved', result: { ok: true, tag: 'vip' }, createdAt: mins(90), decidedAt: mins(88) },
  { id: 5, integrationId: 'pancake', agentId: 'main', taskId: null, command: 'orders cancel', args: '{"id":"A-1002"}', risk: 'destructive', status: 'rejected', createdAt: mins(300), decidedAt: mins(295) },
];

export const agentGrants: Record<string, Record<string, IntegrationGrantSetting>> = {
  'sales-a': { pancake: 'ask' },
  main: { pancake: 'read', composio: 'ask' },
};

export const approvalAttention = (): AttentionItem => ({
  key: 'integration:approval:7', kind: 'module', severity: 'warn', title: 'Sales A xin chạy pancake orders create', detail: 'Tạo đơn mới cho Minh Anh', link: '/connections?tab=approvals', createdAt: mins(3),
} as AttentionItem);
