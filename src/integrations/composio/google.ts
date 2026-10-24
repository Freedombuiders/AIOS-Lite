import { composioClient, composioKey, jsonArguments, keyFingerprint, safeConnectionError } from './client.js';
import { IntegrationApiError, type IntegrationDefinition, type IntegrationValues } from '../types.js';

// An explicit read-only tool list prevents a generic execution command bypassing per-service grants.
export const GOOGLE_SERVICES = [
  { id: 'google_gmail', toolkit: 'gmail', name: 'Gmail', description: 'Tìm và đọc email, xem thông tin hộp thư.', tools: ['GMAIL_GET_PROFILE', 'GMAIL_FETCH_EMAILS'] },
  { id: 'google_calendar', toolkit: 'googlecalendar', name: 'Google Calendar', description: 'Xem lịch và tìm các sự kiện sắp tới.', tools: ['GOOGLECALENDAR_LIST_CALENDARS', 'GOOGLECALENDAR_EVENTS_LIST'] },
  { id: 'google_drive', toolkit: 'googledrive', name: 'Google Drive', description: 'Tìm kiếm tệp và thư mục trong Drive.', tools: ['GOOGLEDRIVE_LIST_FILES'] },
  { id: 'google_docs', toolkit: 'googledocs', name: 'Google Docs', description: 'Đọc nội dung tài liệu Google Docs.', tools: ['GOOGLEDOCS_GET_DOCUMENT_BY_ID'] },
  { id: 'google_sheets', toolkit: 'googlesheets', name: 'Google Sheets', description: 'Đọc dữ liệu từ bảng tính và vùng ô.', tools: ['GOOGLESHEETS_BATCH_GET'] },
  { id: 'google_tasks', toolkit: 'googletasks', name: 'Google Tasks', description: 'Xem danh sách công việc và nhiệm vụ.', tools: ['GOOGLETASKS_LIST_TASK_LISTS', 'GOOGLETASKS_LIST_TASKS'] },
  { id: 'google_search_console', toolkit: 'google_search_console', name: 'Google Search Console', description: 'Đọc lượt tìm kiếm, lượt nhấp, từ khóa, trang và sitemap của website.', tools: ['GOOGLE_SEARCH_CONSOLE_LIST_SITES', 'GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY', 'GOOGLE_SEARCH_CONSOLE_LIST_SITEMAPS', 'GOOGLE_SEARCH_CONSOLE_INSPECT_URL'] },
] as const;

export function serviceCredentials(values: IntegrationValues) {
  const key = composioKey();
  if (!values.connection_id || !values.user_id || values.key_fingerprint !== keyFingerprint(key)) {
    throw new IntegrationApiError('Cần liên kết lại dịch vụ với dự án Composio hiện tại.');
  }
  return composioClient(key);
}
export const googleIntegrations: IntegrationDefinition[] = GOOGLE_SERVICES.map(service => ({
  id: service.id, name: service.name, category: service.id === 'google_search_console' ? 'Marketing' : 'Văn phòng',
  authKind: 'oauth', ...(service.id !== 'google_search_console' ? { group: 'google' } : {}),
  description: service.description, docsUrl: `https://docs.composio.dev/toolkits/${service.toolkit}`,
  setupSteps: ['Kết nối Composio một lần bằng API key của dự án.', 'Bấm Đăng nhập Google, chọn tài khoản và duyệt các quyền trên màn hình đăng nhập.', 'Quay lại đây và bấm Kiểm tra đăng nhập. Chỉ tài khoản đã xác thực thành công mới được lưu.'],
  fields: [],
  async test(values, signal) {
    try {
      const account = await serviceCredentials(values).connectedAccounts.get(values.connection_id, { signal });
      const ok = account.status === 'ACTIVE' && !account.isDisabled && account.toolkit.slug === service.toolkit;
      return { ok, detail: ok ? 'Tài khoản đang hoạt động.' : 'Tài khoản chưa hoạt động hoặc cần đăng nhập lại.', accountLabel: service.name };
    } catch { return { ok: false, detail: safeConnectionError().message }; }
  },
  commands: service.tools.flatMap(slug => [
    { name: `schema ${slug}`, access: 'read' as const, usage: '', description: `Get the input schema for ${slug}.`,
      async run(ctx) { try { return await serviceCredentials(ctx.values).tools.getRawComposioToolBySlug(slug, undefined, { signal: ctx.signal }); } catch { throw safeConnectionError(); } } },
    { name: `run ${slug}`, access: 'read' as const, usage: "[--json '{...}']", description: `Read data using ${slug}; get its schema before supplying arguments.`,
      async run(ctx, args) {
        const input = jsonArguments(args);
        try {
          const client = serviceCredentials(ctx.values);
          const tool = await client.tools.getRawComposioToolBySlug(slug, undefined, { signal: ctx.signal });
          const result = await client.tools.execute(slug, { userId: ctx.values.user_id, connectedAccountId: ctx.values.connection_id, version: tool.version, arguments: input }, { signal: ctx.signal });
          if (!result.successful) throw safeConnectionError();
          return result.data;
        } catch { throw safeConnectionError(); }
      } },
  ]),
  agentGuide: 'Read-only Google service. Use only the listed tools. Read each tool schema before calling run with --json. Each service has its own account and grant.',
}));
