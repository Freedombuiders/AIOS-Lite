/**
 * Where the media integrations put files: generated speech in <video-edit>/tts,
 * downloaded sounds in the Video Studio library (library/store.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { IntegrationUsageError } from './types.js';

let mediaRoot = path.resolve('data', 'media');
/** Folder where media integrations save files; set by createIntegrationService (<dataDir>/media). */
export function setMediaRoot(dir: string): void { mediaRoot = dir; }
export const videoEditRoot = (): string => mediaRoot;

/** A safe file stem: letters, digits, dash and underscore only. */
export function safeStem(raw: string, fallback: string): string {
  const stem = raw.replace(/đ/g, 'd').replace(/Đ/g, 'D').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  return stem || fallback;
}

/** Writes generated audio into <root>/tts/<stem>.mp3 (never overwrites: adds -2, -3…). Returns the absolute path. */
export function saveGeneratedAudio(root: string, stem: string, data: Buffer, ext = 'mp3'): string {
  const dir = path.join(root, 'tts');
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; n < 1000; n++) {
    const file = path.join(dir, `${stem}${n === 1 ? '' : `-${n}`}.${ext}`);
    try {
      fs.writeFileSync(file, data, { flag: 'wx', mode: 0o600 });
      return file;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new IntegrationUsageError('Không tạo được tên file mới, hãy đổi --name.');
}
