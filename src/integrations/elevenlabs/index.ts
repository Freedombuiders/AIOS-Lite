/** ElevenLabs: AI voices for narration. Key-based. */
import type { IntegrationDefinition, IntegrationTestResult, IntegrationValues } from '../types.js';
import { IntegrationApiError } from '../types.js';
import type { FetchImpl } from '../media-http.js';
import { createElevenLabsClient } from './client.js';
import { buildElevenLabsCommands, elevenlabsCommands } from './commands.js';

export interface ElevenLabsTestDeps { fetchImpl?: FetchImpl; sleepImpl?: (ms: number) => Promise<void> }

/** Checks the key by listing voices (a cheap read). Never throws. */
export async function testElevenLabs(values: IntegrationValues, signal?: AbortSignal, deps: ElevenLabsTestDeps = {}): Promise<IntegrationTestResult> {
  const apiKey = values.api_key?.trim() ?? '';
  if (!apiKey) return { ok: false, detail: 'Cần nhập API key ElevenLabs.' };
  try {
    const { voices } = await createElevenLabsClient({ apiKey, signal, ...deps }).listVoices();
    const n = (voices ?? []).length;
    return { ok: true, detail: `Đã kết nối ElevenLabs: ${n} giọng đọc.`, accountLabel: 'ElevenLabs' };
  } catch (e) {
    return { ok: false, detail: `Không kết nối được. ${e instanceof IntegrationApiError ? e.message : 'lỗi không xác định'}` };
  }
}

export const elevenlabsIntegration: IntegrationDefinition = {
  id: 'elevenlabs',
  name: 'ElevenLabs',
  category: 'Video & âm thanh',
  description: 'Giọng đọc AI chất lượng cao, có tiếng Việt. Agent chọn giọng và tạo file lời đọc cho video. Mỗi lần đọc trừ vào hạn mức ký tự của gói ElevenLabs của bạn.',
  docsUrl: 'https://elevenlabs.io/docs/api-reference/introduction',
  authKind: 'api-key',
  setupSteps: [
    'Đăng nhập elevenlabs.io, mở Developers › API Keys và bấm Create API Key.',
    'Nên chọn quyền Text to Speech và Voices (Read). Sao chép key.',
    'Dán vào ô "API key ElevenLabs" rồi bấm Lưu & kiểm tra.',
  ],
  fields: [
    { key: 'api_key', label: 'API key ElevenLabs', kind: 'secret', required: true, help: 'elevenlabs.io › Developers › API Keys.' },
  ],
  test: (values, signal) => testElevenLabs(values, signal),
  commands: elevenlabsCommands,
  agentGuide: 'ElevenLabs generates narration. Run `voices list --search vietnamese` to pick a voice id, then `tts "<text>" --voice <id> --name <stem>` which saves an mp3 under the video-edit tts folder and returns its path. Each call spends the owner\'s character quota: keep texts short and do not regenerate needlessly.',
};

export { buildElevenLabsCommands };
