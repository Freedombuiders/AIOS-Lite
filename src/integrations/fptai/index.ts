/** FPT.AI: Vietnamese text to speech. Key-based. */
import type { IntegrationDefinition, IntegrationTestResult, IntegrationValues } from '../types.js';
import { IntegrationApiError } from '../types.js';
import { scrub, type FetchImpl } from '../media-http.js';
import { createFptClient } from './client.js';
import { buildFptCommands, fptCommands } from './commands.js';

export interface FptTestDeps { fetchImpl?: FetchImpl; sleepImpl?: (ms: number) => Promise<void> }

/**
 * FPT.AI has no account endpoint, so the test submits a three-word synthesis (about 10 characters of quota)
 * and checks the answer. It does not wait for or download the audio. Never throws.
 */
export async function testFptAi(values: IntegrationValues, signal?: AbortSignal, deps: FptTestDeps = {}): Promise<IntegrationTestResult> {
  const apiKey = values.api_key?.trim() ?? '';
  if (!apiKey) return { ok: false, detail: 'Cần nhập API key FPT.AI.' };
  try {
    const job = await createFptClient({ apiKey, signal, ...deps }).request({ text: 'Xin chào bạn', voice: 'banmai' });
    if (job.error !== undefined && job.error !== 0) return { ok: false, detail: `Không kết nối được. FPT.AI: ${scrub(String(job.message ?? 'key không hợp lệ'), apiKey).slice(0, 160)}` };
    return { ok: true, detail: 'Đã kết nối FPT.AI (đã thử đọc một câu ngắn, tốn khoảng 12 ký tự hạn mức).', accountLabel: 'FPT.AI' };
  } catch (e) {
    return { ok: false, detail: `Không kết nối được. ${e instanceof IntegrationApiError ? e.message : 'lỗi không xác định'}` };
  }
}

export const fptaiIntegration: IntegrationDefinition = {
  id: 'fptai',
  name: 'FPT.AI',
  category: 'Video & âm thanh',
  description: 'Giọng đọc tiếng Việt (Ban Mai, Lê Minh, Lan Nhi…). Agent đọc lời dẫn thành file mp3 cho video. Mỗi lần đọc trừ hạn mức ký tự của gói FPT.AI của bạn.',
  docsUrl: 'https://docs.fpt.ai/docs/vi/documentation/text-to-speech',
  authKind: 'api-key',
  setupSteps: [
    'Đăng nhập console.fpt.ai, tạo ứng dụng "Text to Speech" (có gói miễn phí giới hạn ký tự).',
    'Sao chép API key của ứng dụng.',
    'Dán vào ô "API key FPT.AI" rồi bấm Lưu & kiểm tra. Bước kiểm tra đọc thử một câu ngắn nên tốn khoảng 12 ký tự hạn mức.',
  ],
  fields: [
    { key: 'api_key', label: 'API key FPT.AI', kind: 'secret', required: true, help: 'console.fpt.ai › ứng dụng Text to Speech › API key.' },
  ],
  test: (values, signal) => testFptAi(values, signal),
  commands: fptCommands,
  agentGuide: 'FPT.AI reads Vietnamese text aloud. `voices` lists voice ids; `tts "<text>" --voice banmai --name <stem>` saves an mp3 under the video-edit tts folder and returns its path (it can take up to 40 s to be ready). Each call spends the owner\'s character quota: keep texts short and do not regenerate needlessly.',
};

export { buildFptCommands };
