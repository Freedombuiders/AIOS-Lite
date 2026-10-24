/**
 * ElevenLabs commands for `integration-cli elevenlabs <command>`.
 * `tts` writes an mp3 into <video-edit>/tts and returns its path; it spends the owner's character quota.
 */
import { IntegrationApiError, IntegrationUsageError, type IntegrationCommand, type IntegrationCommandContext } from '../types.js';
import { assertFlags, numFlag, requireText, strFlag } from '../arg-helpers.js';
import type { FetchImpl } from '../media-http.js';
import { safeStem, saveGeneratedAudio, videoEditRoot } from '../media-files.js';
import { probeAudioDuration } from '../media-store.js';
import { sniffBuffer } from '../media-store.js';
import { createElevenLabsClient, DEFAULT_MODEL, MAX_TTS_CHARS, type ElevenLabsClient } from './client.js';

export interface ElevenLabsCommandDeps {
  fetchImpl?: FetchImpl;
  sleepImpl?: (ms: number) => Promise<void>;
  root?: () => string;
}

function clientFor(ctx: IntegrationCommandContext, deps: ElevenLabsCommandDeps): ElevenLabsClient {
  const apiKey = ctx.values.api_key?.trim();
  if (!apiKey) throw new IntegrationUsageError('Chưa có API key ElevenLabs. Chủ nhập ở trang Integrations.');
  return createElevenLabsClient({ apiKey, signal: ctx.signal, fetchImpl: deps.fetchImpl, sleepImpl: deps.sleepImpl });
}

export function buildElevenLabsCommands(deps: ElevenLabsCommandDeps = {}): IntegrationCommand[] {
  const root = () => (deps.root ? deps.root() : videoEditRoot());
  return [
    {
      name: 'voices list',
      access: 'read',
      usage: '[--search text] [--limit n]',
      description: 'List the ElevenLabs voices available to the account: voice_id, name, category, labels (accent, gender, language) and a preview URL.',
      async run(ctx, args) {
        assertFlags(args, ['search', 'limit']);
        const search = strFlag(args, 'search')?.toLowerCase();
        const limit = numFlag(args, 'limit', { min: 1, max: 100, int: true }) ?? 30;
        const { voices } = await clientFor(ctx, deps).listVoices();
        const rows = (voices ?? [])
          .filter((v) => !search || `${v.name} ${v.category ?? ''} ${Object.values(v.labels ?? {}).join(' ')}`.toLowerCase().includes(search))
          .slice(0, limit)
          .map((v) => ({ voiceId: v.voice_id, name: v.name, category: v.category, labels: v.labels, previewUrl: v.preview_url }));
        return { total: (voices ?? []).length, voices: rows };
      },
    },
    {
      name: 'tts',
      access: 'write',
      usage: '<text> --voice <voiceId> [--model id] [--name file-stem] [--stability 0..1] [--similarity 0..1]',
      description: `Generate speech from text with ElevenLabs (up to ${MAX_TTS_CHARS} characters) and save an mp3 under the video-edit tts folder. Spends the account's character quota. Returns file path, size and duration.`,
      async run(ctx, args) {
        assertFlags(args, ['voice', 'model', 'name', 'stability', 'similarity']);
        const text = requireText(args, 'đoạn văn cần đọc', 'tts "Xin chào các bạn" --voice 21m00Tcm4TlvDq8ikWAM');
        if (text.length > MAX_TTS_CHARS) throw new IntegrationUsageError(`Đoạn văn dài ${text.length} ký tự, tối đa ${MAX_TTS_CHARS}. Chia nhỏ rồi đọc từng phần.`);
        const voice = strFlag(args, 'voice');
        if (!voice) throw new IntegrationUsageError('Thiếu --voice <voiceId>. Xem danh sách bằng: voices list');
        if (!/^[A-Za-z0-9]{8,40}$/.test(voice)) throw new IntegrationUsageError('voiceId không hợp lệ, lấy từ lệnh voices list.');
        const audio = await clientFor(ctx, deps).tts({
          voiceId: voice, text, modelId: strFlag(args, 'model'),
          stability: numFlag(args, 'stability', { min: 0, max: 1 }), similarity: numFlag(args, 'similarity', { min: 0, max: 1 }),
        });
        if (sniffBuffer(audio) !== 'mp3') throw new IntegrationApiError('ElevenLabs: phản hồi không phải âm thanh mp3.');
        const stem = safeStem(strFlag(args, 'name') ?? '', `elevenlabs-${voice.slice(0, 6)}-${Date.now()}`);
        const file = saveGeneratedAudio(root(), stem, audio);
        return { file, bytes: audio.length, durationSec: await probeAudioDuration(file), characters: text.length, model: strFlag(args, 'model') ?? DEFAULT_MODEL, voiceId: voice };
      },
    },
  ];
}

export const elevenlabsCommands: IntegrationCommand[] = buildElevenLabsCommands();
