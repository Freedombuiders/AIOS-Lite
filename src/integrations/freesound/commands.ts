/**
 * Freesound commands for `integration-cli freesound <command>`.
 * `search` is CC0-only unless --any-license is given. `download` saves the preview
 * (128 kbps mp3, the only file the API serves without OAuth) into the Video Studio
 * library with its licence and source URL; only CC0 is accepted, or CC-BY with
 * --allow-attribution (the credit line is stored and added to captions).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { IntegrationApiError, IntegrationUsageError, type IntegrationCommand, type IntegrationCommandContext } from '../types.js';
import { assertFlags, boolFlag, enumFlag, numFlag, requirePositional, requireText } from '../arg-helpers.js';
import type { FetchImpl } from '../media-http.js';
import { safeStem, videoEditRoot } from '../media-files.js';
import { addFile, libraryTmpDir } from '../media-store.js';
import { sniffFile } from '../media-store.js';
import { createFreesoundClient, isCc0, isCcBy, type FreesoundClient, type FreesoundSound } from './client.js';

export interface FreesoundCommandDeps {
  fetchImpl?: FetchImpl;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Library root (<STORE_DIR>/video-edit by default); tests pass a temp folder. */
  root?: () => string;
}

const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;

function clientFor(ctx: IntegrationCommandContext, deps: FreesoundCommandDeps): FreesoundClient {
  const apiKey = ctx.values.api_key?.trim();
  if (!apiKey) throw new IntegrationUsageError('Chưa có API key Freesound. Chủ nhập ở trang Integrations.');
  return createFreesoundClient({ apiKey, signal: ctx.signal, fetchImpl: deps.fetchImpl, sleepImpl: deps.sleepImpl });
}

const licenseLabel = (license: string | undefined) => (isCc0(license) ? 'CC0' : isCcBy(license) ? 'CC-BY' : 'other');

function compact(s: FreesoundSound) {
  return {
    id: String(s.id), name: s.name, by: s.username, durationSec: s.duration, license: licenseLabel(s.license),
    tags: (s.tags ?? []).slice(0, 8), pageUrl: s.url, previewUrl: s.previews?.['preview-hq-mp3'] ?? s.previews?.['preview-lq-mp3'],
  };
}

export function buildFreesoundCommands(deps: FreesoundCommandDeps = {}): IntegrationCommand[] {
  const root = () => (deps.root ? deps.root() : videoEditRoot());
  return [
    {
      name: 'search',
      access: 'read',
      usage: '<query> [--min-duration s] [--max-duration s] [--limit n] [--any-license]',
      description: 'Search Freesound sound effects. Only CC0 results unless --any-license. Returns id, name, author, duration, licence, tags, page URL and preview URL.',
      async run(ctx, args) {
        assertFlags(args, ['min-duration', 'max-duration', 'limit', 'any-license']);
        const query = requireText(args, 'từ khoá tìm', 'search "whoosh" --max-duration 3');
        const res = await clientFor(ctx, deps).search({
          query,
          pageSize: numFlag(args, 'limit', { min: 1, max: 30, int: true }) ?? 10,
          minDuration: numFlag(args, 'min-duration', { min: 0 }),
          maxDuration: numFlag(args, 'max-duration', { min: 0 }),
          cc0Only: !boolFlag(args, 'any-license'),
        });
        return { query, total: res.count ?? res.results.length, sounds: res.results.map(compact) };
      },
    },
    {
      name: 'download',
      access: 'write',
      usage: '<soundId> [--kind sfx|bgm] [--allow-attribution]',
      description: 'Download a Freesound preview (mp3) into the Video Studio library with its licence and source URL. CC0 only, or CC-BY with --allow-attribution. Returns the library asset.',
      async run(ctx, args) {
        assertFlags(args, ['kind', 'allow-attribution']);
        const id = requirePositional(args, 0, 'id âm thanh', 'download 123456 --kind sfx');
        if (!/^\d{1,12}$/.test(id)) throw new IntegrationUsageError('id âm thanh phải là số, lấy từ lệnh search.');
        const kind = enumFlag(args, 'kind', ['sfx', 'bgm'] as const) ?? 'sfx';
        const client = clientFor(ctx, deps);
        const sound = await client.sound(id);

        let license = 'CC0 1.0 (Freesound)';
        let attribution: string | undefined;
        if (isCc0(sound.license)) {
          // CC0: no credit needed.
        } else if (isCcBy(sound.license) && boolFlag(args, 'allow-attribution')) {
          license = 'CC BY (Freesound)';
          attribution = `"${sound.name}" by ${sound.username ?? 'unknown'} (${sound.url ?? `freesound.org/s/${sound.id}`}), CC BY`;
        } else {
          throw new IntegrationUsageError(
            `Âm thanh ${id} dùng giấy phép ${licenseLabel(sound.license)}; chỉ nhận CC0 (hoặc CC-BY với --allow-attribution). Chọn âm thanh khác.`,
          );
        }
        const previewUrl = sound.previews?.['preview-hq-mp3'] ?? sound.previews?.['preview-lq-mp3'];
        if (!previewUrl || !/^https:\/\/[^/]*freesound\.org\//i.test(previewUrl)) {
          throw new IntegrationApiError('Freesound: không có bản nghe thử để tải.');
        }
        const data = await client.downloadPreview(previewUrl, MAX_PREVIEW_BYTES);
        const tmp = path.join(libraryTmpDir(root()), `freesound-${randomUUID()}.mp3`);
        fs.mkdirSync(path.dirname(tmp), { recursive: true });
        fs.writeFileSync(tmp, data, { mode: 0o600 });
        try {
          if (sniffFile(tmp) !== 'mp3') throw new IntegrationApiError('Freesound: file tải về không phải mp3.');
          const asset = await addFile(root(), {
            kind, tempPath: tmp, fileName: `${safeStem(sound.name, 'freesound')}-fs${sound.id}.mp3`,
            meta: {
              name: sound.name,
              description: (sound.description ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || undefined,
              tags: ['freesound', ...(sound.tags ?? []).slice(0, 6)],
              license, sourceUrl: sound.url ?? `https://freesound.org/s/${sound.id}/`, attribution,
            },
          });
          return { asset: { id: asset.id, kind: asset.kind, name: asset.name, durationSec: asset.durationSec, license: asset.license, sourceUrl: asset.sourceUrl, attribution: asset.attribution, file: asset.file } };
        } finally {
          fs.rmSync(tmp, { force: true });
        }
      },
    },
  ];
}

export const freesoundCommands: IntegrationCommand[] = buildFreesoundCommands();
