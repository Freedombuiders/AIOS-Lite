import { IntegrationApiError, IntegrationUsageError, type IntegrationDefinition, type IntegrationValues } from '../types.js';

export async function botcakeRequest(values: IntegrationValues, endpoint: string, signal?: AbortSignal, body?: unknown): Promise<unknown> {
  if (!/^[a-zA-Z0-9_-]+$/.test(values.page_id || '')) throw new IntegrationUsageError('Page ID chỉ chứa chữ, số, dấu gạch ngang hoặc gạch dưới.');
  try {
    const response = await fetch(`https://botcake.io/api/public_api/v1/pages/${encodeURIComponent(values.page_id)}/${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST', signal, redirect: 'error',
      headers: { 'access-token': values.api_key, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json() as { success?: boolean; status_code?: number };
    if (!response.ok || data.success === false || (data.status_code !== undefined && data.status_code >= 400)) throw new Error();
    return data;
  } catch { throw new IntegrationApiError('Botcake không chấp nhận yêu cầu. Kiểm tra Page ID, API key và quyền truy cập.'); }
}
export const botcakeIntegration: IntegrationDefinition = {
  id: 'botcake', name: 'Botcake', category: 'Nhắn tin', authKind: 'api-key',
  description: 'Khách hàng, tag và flow chatbot. Agent được cấp quyền ghi có thể gửi một flow có sẵn tới khách hàng.',
  docsUrl: 'https://developers.botcake.io/',
  setupSteps: ['Mở Botcake, chọn trang muốn kết nối.', 'Vào Cài đặt → Tích hợp → API và sao chép API key của trang.', 'Nhập Page ID và API key. Hệ thống đọc danh sách tag để kiểm tra; không gửi tin nhắn khi kết nối.'],
  fields: [
    { key: 'page_id', label: 'Page ID', kind: 'text', required: true, placeholder: 'ID trang trong Botcake' },
    { key: 'api_key', label: 'Botcake API key', kind: 'secret', required: true, help: 'Token của trang (access-token), không phải API key Pancake POS.' },
  ],
  async test(values, signal) {
    try { await botcakeRequest(values, 'get_list_tag', signal); return { ok: true, detail: 'Đọc danh sách tag thành công.', accountLabel: `Page ${values.page_id}` }; }
    catch { return { ok: false, detail: 'Không kết nối được Botcake. Kiểm tra Page ID và API key của trang.' }; }
  },
  commands: [
    ...[['tags list', 'get_list_tag', 'List tags.'], ['flows list', 'flows', 'List available flows.'], ['customers list', 'customer', 'List customers.']].map(([name, endpoint, description]) => ({
      name, access: 'read' as const, usage: '', description,
      run: (ctx: { values: IntegrationValues; signal?: AbortSignal }) => botcakeRequest(ctx.values, endpoint, ctx.signal),
    })),
    { name: 'flows send', access: 'write', usage: '<psid> <flowId>', description: 'Send an existing flow to one customer. Requires explicit user instruction to send.',
      async run(ctx, args) {
        const [psid, flowId] = args.positionals;
        if (!psid || !/^[a-zA-Z0-9_-]+$/.test(psid) || !/^\d+$/.test(flowId || '') || !Number.isSafeInteger(Number(flowId))) throw new IntegrationUsageError('Cần psid và flowId hợp lệ.');
        return botcakeRequest(ctx.values, 'flows/send_flow', ctx.signal, { psid, flow_id: Number(flowId) });
      } },
  ],
  agentGuide: 'Botcake holds page customers, tags and chatbot flows. Reading never sends messages. Send flows only when the user explicitly requests sending to that customer; never retry an uncertain send automatically.',
};
