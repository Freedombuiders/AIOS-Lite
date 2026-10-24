/**
 * FPT.AI text to speech v5 (Vietnamese voices). The key goes in the `api-key` header.
 * The API answers with a URL of the mp3 that becomes available a few seconds later.
 */
import { IntegrationApiError } from '../types.js';
import { readBytes, scrub, send, sendJson, type HttpOptions } from '../media-http.js';

export const FPT_TTS_URL = 'https://api.fpt.ai/hmi/tts/v5';
export const MAX_TTS_CHARS = 5000;
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;

export const FPT_VOICES = [
  { id: 'banmai', name: 'Ban Mai', gender: 'nữ', region: 'Bắc' },
  { id: 'thuminh', name: 'Thu Minh', gender: 'nữ', region: 'Bắc' },
  { id: 'myan', name: 'Mỹ An', gender: 'nữ', region: 'Trung' },
  { id: 'lannhi', name: 'Lan Nhi', gender: 'nữ', region: 'Nam' },
  { id: 'linhsan', name: 'Linh San', gender: 'nữ', region: 'Nam' },
  { id: 'leminh', name: 'Lê Minh', gender: 'nam', region: 'Bắc' },
  { id: 'giahuy', name: 'Gia Huy', gender: 'nam', region: 'Trung' },
  { id: 'minhquang', name: 'Minh Quang', gender: 'nam', region: 'Nam' },
  { id: 'ngoclam', name: 'Ngọc Lam', gender: 'nữ', region: 'Trung' },
] as const;

export interface FptClientOptions extends HttpOptions { apiKey: string }

export interface FptSynthesis { async?: string; error?: number; message?: string; request_id?: string }

export interface FptTtsParams { text: string; voice?: string; speed?: number }

export function createFptClient(opts: FptClientOptions) {
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const request = (p: FptTtsParams) => sendJson<FptSynthesis>({
    service: 'FPT.AI', secret: opts.apiKey, method: 'POST', url: FPT_TTS_URL, body: p.text,
    headers: { 'api-key': opts.apiKey, voice: p.voice ?? 'banmai', speed: String(p.speed ?? 0), format: 'mp3', 'Cache-Control': 'no-cache', 'Content-Type': 'text/plain; charset=utf-8' },
  }, opts);
  return {
    /** Submits a synthesis request (no download). Used by the connection test with a few characters. */
    request,
    /** Submits, then polls the result URL until the mp3 exists (up to ~40 s). */
    async tts(p: FptTtsParams): Promise<Buffer> {
      const job = await request(p);
      if (job.error !== undefined && job.error !== 0) throw new IntegrationApiError(`FPT.AI: ${scrub(String(job.message ?? 'lỗi tạo giọng đọc'), opts.apiKey).slice(0, 200)}`);
      const url = job.async ?? '';
      if (!/^https:\/\/([a-z0-9-]+\.)*fpt\.ai\//i.test(url)) throw new IntegrationApiError('FPT.AI: phản hồi không có link âm thanh hợp lệ.');
      for (let attempt = 0; attempt < 20; attempt++) {
        await sleep(attempt === 0 ? 1500 : 2000);
        try {
          const res = await send({ service: 'FPT.AI', secret: opts.apiKey, url, headers: { Accept: 'audio/mpeg' } }, opts);
          const bytes = await readBytes(res, MAX_AUDIO_BYTES, 'FPT.AI');
          if (bytes.length > 0) return bytes;
        } catch (err) {
          // 404 means the file is not ready yet; anything else is a real failure.
          if (!(err instanceof IntegrationApiError) || err.status !== 404) throw err;
        }
      }
      throw new IntegrationApiError('FPT.AI: giọng đọc chưa sẵn sàng sau 40 giây, thử lại sau.');
    },
  };
}
export type FptClient = ReturnType<typeof createFptClient>;
