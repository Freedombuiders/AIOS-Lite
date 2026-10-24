/** Freesound: sound effects with Creative Commons licences. Key-based. */
import type { IntegrationDefinition, IntegrationTestResult, IntegrationValues } from '../types.js';
import { IntegrationApiError } from '../types.js';
import type { FetchImpl } from '../media-http.js';
import { createFreesoundClient } from './client.js';
import { buildFreesoundCommands, freesoundCommands } from './commands.js';

export interface FreesoundTestDeps { fetchImpl?: FetchImpl; sleepImpl?: (ms: number) => Promise<void> }

/** Checks the key with one cheap authenticated search. Never throws. */
export async function testFreesound(values: IntegrationValues, signal?: AbortSignal, deps: FreesoundTestDeps = {}): Promise<IntegrationTestResult> {
  const apiKey = values.api_key?.trim() ?? '';
  if (!apiKey) return { ok: false, detail: 'Cần nhập API key Freesound.' };
  try {
    await createFreesoundClient({ apiKey, signal, ...deps }).ping();
    return { ok: true, detail: 'Đã kết nối Freesound.', accountLabel: 'Freesound' };
  } catch (e) {
    return { ok: false, detail: `Không kết nối được. ${e instanceof IntegrationApiError ? e.message : 'lỗi không xác định'}` };
  }
}

export const freesoundIntegration: IntegrationDefinition = {
  id: 'freesound',
  name: 'Freesound',
  category: 'Video & âm thanh',
  description: 'Kho tiếng động do cộng đồng đăng. Agent tìm tiếng theo từ khoá (mặc định chỉ lấy CC0) và lưu bản nghe thử vào kho của Video Studio kèm giấy phép và link nguồn. Nhãn CC0 do người đăng tự gán, nên link nguồn được lưu làm bằng chứng.',
  docsUrl: 'https://freesound.org/docs/api/',
  authKind: 'api-key',
  setupSteps: [
    'Đăng nhập freesound.org, mở freesound.org/apiv2/apply và tạo "API credentials".',
    'Sao chép giá trị "Client secret / API key" (chuỗi dài, dùng làm token).',
    'Dán vào ô "API key Freesound" rồi bấm Lưu & kiểm tra.',
    'Lưu ý: API chỉ cho tải bản nghe thử mp3 128 kbps nếu không đăng nhập OAuth, đủ dùng cho tiếng động ngắn.',
  ],
  fields: [
    { key: 'api_key', label: 'API key Freesound', kind: 'secret', required: true, help: 'freesound.org/apiv2/apply › Client secret / API key.' },
  ],
  test: (values, signal) => testFreesound(values, signal),
  commands: freesoundCommands,
  agentGuide: 'Freesound holds sound effects. `search` returns CC0 results by default; `download <id>` saves the mp3 preview into the Video Studio library (kind sfx or bgm) with licence and source URL, after which use the returned asset id in the plan. Never download non-CC0 sounds unless the owner accepts a credit line (--allow-attribution).',
};

export { buildFreesoundCommands };
