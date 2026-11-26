/**
 * Builds a pack zip from files in memory: fills pack.json `files` with each
 * file's SHA-256 and each note's `loai` from its front matter, then checks the
 * result with the same rules the Worker applies at finalize.
 * Used by scripts/pack.ts and by the tests.
 */
import { zipSync, type Zippable } from 'fflate';
import { encodeUtf8, sha256Hex } from '../lib/encoding';
import { frontMatterLoai, type PackManifest } from './format';
import { checkPackZip } from './zip-check';

export type ManifestTemplate = Omit<PackManifest, 'files'> & { files?: PackManifest['files'] };

/** Fixed timestamp so the same input always gives the same zip bytes. */
const MTIME = new Date(Date.UTC(2020, 0, 1));

export async function buildPack(template: ManifestTemplate, files: { path: string; data: Uint8Array }[]): Promise<{ zip: Uint8Array; manifest: PackManifest }> {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const entries: PackManifest['files'] = [];
  for (const f of sorted) {
    const entry: PackManifest['files'][number] = { path: f.path, sha256: await sha256Hex(f.data) };
    if (f.path.startsWith('notes/')) {
      const loai = frontMatterLoai(new TextDecoder().decode(f.data));
      if (loai) entry.loai = loai;
    }
    entries.push(entry);
  }
  const { files: _ignored, ...rest } = template;
  const manifest: PackManifest = { ...rest, files: entries };
  const zippable: Zippable = { 'pack.json': [encodeUtf8(`${JSON.stringify(manifest, null, 2)}\n`), { mtime: MTIME }] };
  for (const f of sorted) zippable[f.path] = [f.data, { mtime: MTIME }];
  const zip = zipSync(zippable, { level: 9 });
  await checkPackZip(zip);
  return { zip, manifest };
}
