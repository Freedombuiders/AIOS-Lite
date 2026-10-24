// Minimal local file helpers for the media integrations (sound/voice downloads).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type Sniffed = 'mp3' | 'unknown';

export function sniffBuffer(b: Buffer): Sniffed {
  if (b.length < 4) return 'unknown';
  if (b.subarray(0, 3).toString('latin1') === 'ID3') return 'mp3';
  if (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return 'mp3';
  return 'unknown';
}

export function sniffFile(file: string): Sniffed {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(16);
      const n = fs.readSync(fd, head, 0, 16, 0);
      return sniffBuffer(head.subarray(0, n));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 'unknown';
  }
}

/** Duration in seconds via ffprobe; null when ffprobe is not installed or fails. */
export function probeAudioDuration(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
      let out = '';
      p.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      p.on('error', () => resolve(null));
      p.on('close', () => {
        const n = Number(out.trim());
        resolve(Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null);
      });
    } catch {
      resolve(null);
    }
  });
}

export const libraryDir = (root: string): string => path.join(root, 'library');
export const libraryTmpDir = (root: string): string => path.join(libraryDir(root), '.tmp');

export interface LibraryAsset {
  id: string;
  kind: string;
  name: string;
  file: string;
  durationSec: number | null;
  license?: string;
  sourceUrl?: string;
  attribution?: string;
}

/** Moves a downloaded file into <root>/library/<kind>/ and returns its record. */
export async function addFile(
  root: string,
  input: { kind: string; tempPath: string; fileName: string; meta: { name?: string; description?: string; tags?: string[]; license?: string; sourceUrl?: string; attribution?: string } },
): Promise<LibraryAsset> {
  const dir = path.join(libraryDir(root), input.kind);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, input.fileName);
  fs.copyFileSync(input.tempPath, file);
  return {
    id: randomUUID(),
    kind: input.kind,
    name: input.meta.name ?? input.fileName,
    file,
    durationSec: await probeAudioDuration(file),
    license: input.meta.license,
    sourceUrl: input.meta.sourceUrl,
    attribution: input.meta.attribution,
  };
}
