/**
 * HeyGen v3 API (https://developers.heygen.com): talking-head video from a still image (Avatar IV)
 * with a cloned or library voice. Key: Integrations › HeyGen (`api_key`), or HEYGEN_API_KEY.
 *
 *   POST /v3/assets            multipart `file` → { data: { asset_id, url } }   (≤ 32 MB)
 *   POST /v3/videos            { type: "image", image, script, voice_id, … } → { data: { video_id, status } }
 *   GET  /v3/videos/{id}       → { data: { status: pending|processing|completed|failed, video_url, subtitle_url, duration, failure_message } }
 *   GET  /v3/voices            ?type=private|public&language=&limit=&token= → { data: [...], has_more, next_token }
 */

import fs from 'node:fs';
import path from 'node:path';

import type { IntegrationDefinition, IntegrationTestResult, IntegrationValues } from '../../../../../src/integrations/types.js';
import { loadIntegrationValues } from '../../integration-values.js';

export const HEYGEN_API = 'https://api.heygen.com';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HeygenVoice {
  voiceId: string;
  name: string;
  language: string;
  gender: string;
  previewUrl: string | null;
  type: 'public' | 'private';
}

export interface HeygenVideoStatus {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  videoUrl: string | null;
  subtitleUrl: string | null;
  durationSec: number | null;
  error: string | null;
}

export class HeygenError extends Error {
  constructor(message: string, readonly status: number, readonly code: string = 'heygen') {
    super(message);
    this.name = 'HeygenError';
  }
}

export function heygenKey(): string | null {
  try {
    const v = loadIntegrationValues('heygen')?.api_key?.trim();
    if (v) return v;
  } catch { /* store unreadable: fall through */ }
  return process.env.HEYGEN_API_KEY?.trim() || null;
}

/** Vietnamese message for an HTTP failure; never echoes the key. */
function messageFor(status: number, body: unknown): string {
  const err = (body as { error?: { message?: string; code?: string } } | null)?.error;
  const detail = typeof err?.message === 'string' ? err.message.slice(0, 240) : '';
  if (status === 401 || status === 403) return 'HeyGen từ chối API key. Kiểm tra lại ở Integrations › HeyGen.';
  if (status === 402) return 'Tài khoản HeyGen hết credit.';
  if (status === 429) return 'HeyGen đang giới hạn tần suất. Thử lại sau ít phút.';
  if (status === 400) return `HeyGen không nhận yêu cầu${detail ? `: ${detail}` : '.'}`;
  return `HeyGen trả lỗi HTTP ${status}${detail ? `: ${detail}` : ''}.`;
}

export function createHeygenClient(deps: { apiKey?: () => string | null; fetchImpl?: FetchLike } = {}) {
  const key = deps.apiKey ?? heygenKey;
  const doFetch: FetchLike = deps.fetchImpl ?? fetch;

  function requireKey(): string {
    const k = key();
    if (!k) throw new HeygenError('Chưa kết nối HeyGen: dán API key ở Integrations › HeyGen.', 412, 'not_configured');
    return k;
  }

  async function call<T>(method: 'GET' | 'POST', pathname: string, init: { json?: unknown; form?: FormData; idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<T> {
    const headers: Record<string, string> = { 'x-api-key': requireKey(), Accept: 'application/json' };
    if (init.json !== undefined) headers['Content-Type'] = 'application/json';
    if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
    const timeout = AbortSignal.timeout(60_000);
    let res: Response;
    try {
      res = await doFetch(`${HEYGEN_API}${pathname}`, {
        method,
        headers,
        body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
    } catch {
      throw new HeygenError('Không kết nối được HeyGen. Kiểm tra mạng rồi thử lại.', 503, 'network');
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new HeygenError(messageFor(res.status, body), res.status);
    return body as T;
  }

  return {
    configured: () => Boolean(key()),

    async uploadImage(file: string, signal?: AbortSignal): Promise<string> {
      const buf = await fs.promises.readFile(file);
      if (buf.length > 32 * 1024 * 1024) throw new HeygenError('Ảnh quá lớn cho HeyGen (tối đa 32 MB).', 413, 'too_large');
      const ext = path.extname(file).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
      const form = new FormData();
      form.append('file', new Blob([buf], { type: mime }), `kol${ext || '.jpg'}`);
      const r = await call<{ data?: { asset_id?: string } }>('POST', '/v3/assets', { form, signal });
      const id = r.data?.asset_id;
      if (!id) throw new HeygenError('HeyGen không trả mã ảnh đã tải lên.', 502);
      return id;
    },

    async createImageVideo(input: {
      assetId: string; script: string; voiceId: string; aspect: '9:16' | '16:9' | '1:1' | '4:5';
      title: string; motionPrompt?: string; idempotencyKey: string; signal?: AbortSignal;
    }): Promise<string> {
      const r = await call<{ data?: { video_id?: string } }>('POST', '/v3/videos', {
        json: {
          type: 'image',
          image: { type: 'asset_id', asset_id: input.assetId },
          title: input.title.slice(0, 120),
          script: input.script,
          voice_id: input.voiceId,
          aspect_ratio: input.aspect,
          resolution: '1080p',
          expressiveness: 'medium',
          ...(input.motionPrompt ? { motion_prompt: input.motionPrompt.slice(0, 600) } : {}),
          caption: { file_format: 'srt' },
        },
        idempotencyKey: input.idempotencyKey,
        signal: input.signal,
      });
      const id = r.data?.video_id;
      if (!id) throw new HeygenError('HeyGen không trả mã video.', 502);
      return id;
    },

    async getVideo(videoId: string, signal?: AbortSignal): Promise<HeygenVideoStatus> {
      const r = await call<{ data?: Record<string, unknown> }>('GET', `/v3/videos/${encodeURIComponent(videoId)}`, { signal });
      const d = r.data ?? {};
      const raw = String(d.status ?? 'pending');
      const status = (['pending', 'processing', 'completed', 'failed'] as const).find((s) => s === raw) ?? 'processing';
      return {
        status,
        videoUrl: typeof d.video_url === 'string' ? d.video_url : null,
        subtitleUrl: typeof d.subtitle_url === 'string' ? d.subtitle_url : null,
        durationSec: typeof d.duration === 'number' ? d.duration : null,
        error: status === 'failed' ? String(d.failure_message ?? d.failure_code ?? 'HeyGen báo lỗi khi dựng video.').slice(0, 300) : null,
      };
    },

    async listVoices(opts: { type?: 'private' | 'public'; language?: string; limit?: number; token?: string } = {}): Promise<{ voices: HeygenVoice[]; next: string | null }> {
      const q = new URLSearchParams({ type: opts.type ?? 'private', limit: String(Math.min(100, Math.max(1, opts.limit ?? 100))) });
      if (opts.language) q.set('language', opts.language);
      if (opts.token) q.set('token', opts.token);
      const r = await call<{ data?: Record<string, unknown>[]; has_more?: boolean; next_token?: string | null }>('GET', `/v3/voices?${q.toString()}`);
      const voices = (r.data ?? []).map((v) => ({
        voiceId: String(v.voice_id ?? ''),
        name: String(v.name ?? ''),
        language: String(v.language ?? ''),
        gender: String(v.gender ?? ''),
        previewUrl: typeof v.preview_audio_url === 'string' ? v.preview_audio_url : null,
        type: v.type === 'public' ? 'public' as const : 'private' as const,
      })).filter((v) => v.voiceId);
      return { voices, next: r.has_more && r.next_token ? r.next_token : null };
    },

    /** Downloads a finished file (video or SRT) to `dest`. */
    async download(url: string, dest: string, signal?: AbortSignal): Promise<void> {
      if (!/^https:\/\//.test(url)) throw new HeygenError('Đường dẫn tải từ HeyGen không hợp lệ.', 502);
      const res = await doFetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000) });
      if (!res.ok || !res.body) throw new HeygenError(`Không tải được file từ HeyGen (HTTP ${res.status}).`, 502);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.part`;
      await fs.promises.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
      fs.renameSync(tmp, dest);
    },
  };
}

export type HeygenClient = ReturnType<typeof createHeygenClient>;

// ── Integration (Integrations page) ──────────────────────────────────

export async function testHeygen(values: IntegrationValues, signal?: AbortSignal, fetchImpl: FetchLike = fetch): Promise<IntegrationTestResult> {
  const key = values.api_key?.trim() ?? '';
  if (!key) return { ok: false, detail: 'Cần nhập API key của HeyGen.' };
  try {
    const client = createHeygenClient({ apiKey: () => key, fetchImpl });
    const { voices } = await client.listVoices({ type: 'private', limit: 100 });
    void signal;
    return {
      ok: true,
      detail: `HeyGen đã chấp nhận API key (kiểm tra bằng lệnh đọc danh sách giọng, không tốn credit). Có ${voices.length} giọng riêng trong workspace.`,
      accountLabel: 'HeyGen',
    };
  } catch (err) {
    return { ok: false, detail: err instanceof HeygenError ? err.message : 'Không kiểm tra được HeyGen. Thử lại sau.' };
  }
}

export const heygenIntegration: IntegrationDefinition = {
  id: 'heygen',
  name: 'HeyGen',
  category: 'AI tạo ảnh & video',
  description: 'Video nói chuyện từ ảnh KOL (Avatar IV) bằng giọng nhân bản của bạn, khớp khẩu hình, dài bao nhiêu cũng được. Video Studio dùng HeyGen cho cảnh KOL nói trước ống kính.',
  docsUrl: 'https://developers.heygen.com',
  authKind: 'api-key',
  setupSteps: [
    'Đăng nhập app.heygen.com bằng tài khoản có gói API (hoặc workspace của team).',
    'Mở Settings › API, tạo hoặc sao chép API key.',
    'Dán key vào ô bên dưới rồi bấm Lưu & kiểm tra. Lần kiểm tra chỉ đọc danh sách giọng, không tốn credit.',
    'Trong Video Studio › Kết nối, chọn giọng HeyGen cho từng KOL (ví dụ giọng nhân bản "TonyTrieu").',
  ],
  fields: [
    { key: 'api_key', label: 'API key HeyGen', kind: 'secret', required: true, placeholder: 'sk_…', help: 'HeyGen › Settings › API.' },
  ],
  test: (values, signal) => testHeygen(values, signal),
  commands: [],
  agentGuide: 'HeyGen renders lip-synced talking-head videos from a KOL image and a cloned voice. Agents do not call it directly; Video Studio scenes with engine "heygen" use it.',
};
