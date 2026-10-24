/**
 * Speech for talking videos: ElevenLabs text-to-speech with the persona's
 * voiceId. Key from Integrations › ElevenLabs, or ELEVENLABS_API_KEY in .env.
 * Tests replace the synthesizer with _setSpeechForTests.
 */

import { connectionSecret } from './config.js';
import { createElevenLabsClient, DEFAULT_MODEL } from '../../../src/integrations/elevenlabs/client.js';
import { loadIntegrationValues } from './integration-values.js';
import { KolError } from './core.js';
import { wrapHttpError } from './providers/types.js';

export const TTS_MODEL = DEFAULT_MODEL;
/** Longest script for one talking video (≈ 50 s of speech). */
export const MAX_SCRIPT_CHARS = 600;

export type SpeechFn = (voiceId: string, text: string, signal?: AbortSignal) => Promise<Buffer>;

let speechOverride: SpeechFn | null = null;
let keyOverride: string | null | undefined;

/** @internal tests only. */
export function _setSpeechForTests(fn: SpeechFn | null, key: string | null | undefined = fn ? 'test-key' : undefined): void {
  speechOverride = fn;
  keyOverride = key;
}

export function elevenLabsKey(): string | null {
  if (keyOverride !== undefined) return keyOverride;
  try {
    const v = loadIntegrationValues('elevenlabs')?.api_key?.trim();
    if (v) return v;
  } catch { /* fall through */ }
  return connectionSecret('ELEVENLABS_API_KEY') || null;
}

export function voiceConfigured(): boolean {
  return Boolean(elevenLabsKey());
}

/** Throws 412 when no ElevenLabs key is available. */
export function requireVoiceKey(): string {
  const key = elevenLabsKey();
  if (!key) throw new KolError(412, 'Chưa có khóa ElevenLabs để tạo giọng nói. Nhập ở Kết nối › Integrations › ElevenLabs.', 'no_voice_key');
  return key;
}

/** mp3 bytes of `text` spoken with `voiceId`. */
export async function synthesizeSpeech(voiceId: string, text: string, signal?: AbortSignal): Promise<Buffer> {
  if (speechOverride) return speechOverride(voiceId, text, signal);
  const apiKey = requireVoiceKey();
  try {
    return await createElevenLabsClient({ apiKey, signal }).tts({ voiceId, text, modelId: TTS_MODEL });
  } catch (err) {
    throw wrapHttpError(err, 'ElevenLabs');
  }
}
