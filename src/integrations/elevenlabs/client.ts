/** ElevenLabs API (voices and text to speech). The key goes in the xi-api-key header. */
import { readBytes, send, sendJson, type HttpOptions } from '../media-http.js';

export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1';
export const DEFAULT_MODEL = 'eleven_multilingual_v2';
export const MAX_TTS_CHARS = 5000;
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;

export interface ElevenLabsClientOptions extends HttpOptions { apiKey: string }

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  category?: string;
  description?: string;
  preview_url?: string;
  labels?: Record<string, string>;
}

export interface TtsParams { voiceId: string; text: string; modelId?: string; stability?: number; similarity?: number }

export function createElevenLabsClient(opts: ElevenLabsClientOptions) {
  const headers = { 'xi-api-key': opts.apiKey };
  return {
    listVoices: () => sendJson<{ voices: ElevenLabsVoice[] }>({ service: 'ElevenLabs', secret: opts.apiKey, url: `${ELEVENLABS_BASE_URL}/voices`, headers }, opts),
    /** Returns mp3 bytes (44.1 kHz, 128 kbps). */
    async tts(p: TtsParams): Promise<Buffer> {
      const res = await send({
        service: 'ElevenLabs', secret: opts.apiKey, method: 'POST',
        url: `${ELEVENLABS_BASE_URL}/text-to-speech/${encodeURIComponent(p.voiceId)}?output_format=mp3_44100_128`,
        headers: { ...headers, Accept: 'audio/mpeg' },
        json: {
          text: p.text, model_id: p.modelId ?? DEFAULT_MODEL,
          voice_settings: { stability: p.stability ?? 0.5, similarity_boost: p.similarity ?? 0.75 },
        },
      }, { ...opts, timeoutMs: opts.timeoutMs ?? 120_000 });
      return readBytes(res, MAX_AUDIO_BYTES, 'ElevenLabs');
    },
  };
}
export type ElevenLabsClient = ReturnType<typeof createElevenLabsClient>;
