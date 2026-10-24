/** Pexels: free stock video and photos for B-roll. Key-based. */
import type { IntegrationDefinition, IntegrationTestResult, IntegrationValues } from '../types.js';
import { IntegrationApiError } from '../types.js';
import type { FetchImpl } from '../media-http.js';
import { createPexelsClient } from './client.js';
import { buildPexelsCommands, pexelsCommands } from './commands.js';

export interface PexelsTestDeps { fetchImpl?: FetchImpl; sleepImpl?: (ms: number) => Promise<void> }

/** Checks the key with one cheap authenticated call. Never throws. */
export async function testPexels(values: IntegrationValues, signal?: AbortSignal, deps: PexelsTestDeps = {}): Promise<IntegrationTestResult> {
  const apiKey = values.api_key?.trim() ?? '';
  if (!apiKey) return { ok: false, detail: 'Cần nhập API key Pexels.' };
  try {
    await createPexelsClient({ apiKey, signal, ...deps }).curated();
    return { ok: true, detail: 'Đã kết nối Pexels.', accountLabel: 'Pexels' };
  } catch (e) {
    // Never echo an unknown error: a fetch error can contain the request URL.
    return { ok: false, detail: `Không kết nối được. ${e instanceof IntegrationApiError ? e.message : 'lỗi không xác định'}` };
  }
}

export const pexelsIntegration: IntegrationDefinition = {
  id: 'pexels',
  name: 'Pexels',
  category: 'Video & âm thanh',
  description: 'Kho video và ảnh stock miễn phí. Agent tìm cảnh B-roll theo từ khoá để chèn vào video. Pexels cho dùng trong video của bạn nhưng không cho dựng lại thành kho stock, nên app chỉ tìm và xem, không lưu vào kho.',
  docsUrl: 'https://www.pexels.com/api/documentation/',
  authKind: 'api-key',
  setupSteps: [
    'Đăng nhập pexels.com, mở pexels.com/api và bấm "Request API Key" (miễn phí).',
    'Điền mục đích sử dụng, sao chép API key được cấp.',
    'Dán vào ô "API key Pexels" rồi bấm Lưu & kiểm tra. Giới hạn mặc định khoảng 200 lượt gọi mỗi giờ.',
  ],
  fields: [
    { key: 'api_key', label: 'API key Pexels', kind: 'secret', required: true, help: 'pexels.com/api › Your API Key.' },
  ],
  test: (values, signal) => testPexels(values, signal),
  commands: pexelsCommands,
  agentGuide: 'Pexels holds free stock videos and photos. Use `videos search` to find B-roll for a video plan and `photos search` for stills; each result has a page URL and a direct link. Credit the author when the style asks for it. Do not bulk-download into the library: Pexels licence forbids rebuilding a stock library.',
};

export { buildPexelsCommands };
