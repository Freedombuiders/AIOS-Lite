import { composioClient, safeConnectionError } from './client.js';
import type { IntegrationDefinition } from '../types.js';

export const composioIntegration: IntegrationDefinition = {
  id: 'composio', name: 'Composio', category: 'Kho ứng dụng', authKind: 'api-key',
  description: 'Kết nối dùng chung cho Google, Search Console, Gmail, Facebook và Meta Ads. Nhập API key một lần tại đây; các tính năng trong ứng dụng dùng chung khóa này.',
  docsUrl: 'https://docs.composio.dev/docs/authentication',
  setupSteps: ['Mở dashboard.composio.dev, chọn đúng dự án và sao chép Project API key.', 'Dán key bên dưới. Hệ thống kiểm tra key trước khi lưu.', 'Sau khi lưu, bấm Chọn dịch vụ trong Composio để đăng nhập Google/Search Console. Gmail và Facebook Studio cũng dùng chung khóa này.'],
  fields: [{ key: 'api_key', label: 'Composio API key', kind: 'secret', required: true, placeholder: 'Dán Project API key' }],
  async test(values, signal) {
    try {
      await composioClient(values.api_key).connectedAccounts.list({ limit: 1 }, { signal });
      return { ok: true, detail: 'API key hợp lệ. Chọn dịch vụ để liên kết tài khoản.', accountLabel: 'Dự án Composio' };
    } catch { return { ok: false, detail: safeConnectionError().message }; }
  },
  commands: [{
    name: 'accounts list', access: 'read', usage: '', description: 'List connected account IDs, toolkits and statuses without credentials.',
    async run(ctx) {
      try {
        const result = await composioClient(ctx.values.api_key).connectedAccounts.list({ limit: 100 }, { signal: ctx.signal });
        return { accounts: result.items.map(a => ({ id: a.id, toolkit: a.toolkit.slug, status: a.status })), nextCursor: result.nextCursor };
      } catch { throw safeConnectionError(); }
    },
  }],
  agentGuide: 'Lists account metadata only. Google service execution requires a separate grant for that service; this grant does not permit arbitrary tool execution.',
};
