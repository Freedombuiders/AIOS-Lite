/**
 * FPT.AI commands for `integration-cli fptai <command>`. `tts` saves an mp3 under <video-edit>/tts.
 */
import { IntegrationApiError, IntegrationUsageError, type IntegrationCommand, type IntegrationCommandContext } from '../types.js';
import { assertFlags, numFlag, requireText, strFlag } from '../arg-helpers.js';
import type { FetchImpl } from '../media-http.js';
import { safeStem, saveGeneratedAudio, videoEditRoot } from '../media-files.js';
import { probeAudioDuration } from '../media-store.js';
import { sniffBuffer } from '../media-store.js';
import { createFptClient, FPT_VOICES, MAX_TTS_CHARS, type FptClient } from './client.js';

export interface FptCommandDeps {
  fetchImpl?: FetchImpl;
  sleepImpl?: (ms: number) => Promise<void>;
  root?: () => string;
}

function clientFor(ctx: IntegrationCommandContext, deps: FptCommandDeps): FptClient {
  const apiKey = ctx.values.api_key?.trim();
  if (!apiKey) throw new IntegrationUsageError('Chưa có API key FPT.AI. Chủ nhập ở trang Integrations.');
  return createFptClient({ apiKey, signal: ctx.signal, fetchImpl: deps.fetchImpl, sleepImpl: deps.sleepImpl });
}

export function buildFptCommands(deps: FptCommandDeps = {}): IntegrationCommand[] {
  const root = () => (deps.root ? deps.root() : videoEditRoot());
  return [
    {
      name: 'voices',
      access: 'read',
      usage: '',
      description: 'List the FPT.AI Vietnamese voices (id, name, gender, region). No network call.',
      async run(_ctx, args) {
        assertFlags(args, []);
        return { voices: FPT_VOICES };
      },
    },
    {
      name: 'tts',
      access: 'write',
      usage: `<text> [--voice ${FPT_VOICES[0].id}] [--speed -3..3] [--name file-stem]`,
      description: `Generate Vietnamese speech with FPT.AI (up to ${MAX_TTS_CHARS} characters) and save an mp3 under the video-edit tts folder. Spends the account's character quota. Returns file path, size and duration.`,
      async run(ctx, args) {
        assertFlags(args, ['voice', 'speed', 'name']);
        const text = requireText(args, 'đoạn văn cần đọc', 'tts "Xin chào các bạn" --voice banmai');
        if (text.length > MAX_TTS_CHARS) throw new IntegrationUsageError(`Đoạn văn dài ${text.length} ký tự, tối đa ${MAX_TTS_CHARS}. Chia nhỏ rồi đọc từng phần.`);
        const voice = strFlag(args, 'voice') ?? 'banmai';
        if (!FPT_VOICES.some((v) => v.id === voice)) throw new IntegrationUsageError(`Giọng "${voice}" không có. Dùng: ${FPT_VOICES.map((v) => v.id).join(', ')}.`);
        const speed = numFlag(args, 'speed', { min: -3, max: 3, int: true });
        const audio = await clientFor(ctx, deps).tts({ text, voice, speed });
        if (sniffBuffer(audio) !== 'mp3') throw new IntegrationApiError('FPT.AI: file tải về không phải mp3.');
        const stem = safeStem(strFlag(args, 'name') ?? '', `fptai-${voice}-${Date.now()}`);
        const file = saveGeneratedAudio(root(), stem, audio);
        return { file, bytes: audio.length, durationSec: await probeAudioDuration(file), characters: text.length, voice };
      },
    },
  ];
}

export const fptCommands: IntegrationCommand[] = buildFptCommands();
