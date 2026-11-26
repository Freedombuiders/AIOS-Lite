/** Pack fixtures for tests: notes, raw zips (including malformed ones) and an Ed25519 signer. */
import { zipSync, type Zippable } from 'fflate';
import { encodeUtf8, sha256Hex, toBase64Url } from '../src/lib/encoding';
import { buildPack, type ManifestTemplate } from '../src/packs/build';
import { signingMessage } from '../src/packs/format';

export const note = (loai: string, body = 'Nội dung.') => encodeUtf8(`---\nloai: ${loai}\ntrang_thai: gia-thuyet\n---\n\n${body}\n`);

export const template = (over: Partial<ManifestTemplate> = {}): ManifestTemplate => ({
  id: 'tra-va-qua-tang-co-ban',
  version: '1.0.0',
  name: 'Trà và quà tặng: bộ khởi đầu',
  module: 'learn',
  summary: 'Bài học nội dung cho shop trà',
  license: 'CC-BY-4.0',
  author: 'AgenticOS',
  ...over,
});

export function goodPack(over: Partial<ManifestTemplate> = {}) {
  return buildPack(template(over), [
    { path: 'notes/bai-hoc/video-huong-dan-ngan.md', data: note('bai-hoc') },
    { path: 'notes/cong-thuc/huong-dan-3-buoc.md', data: note('cong-thuc') },
    { path: 'assets/bia.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
  ]);
}

/** A zip built by hand, with a manifest whose `files` is computed from `declare` (defaults to every file). */
export async function rawPack(
  files: Record<string, Uint8Array>,
  opts: { manifest?: Partial<ManifestTemplate>; declare?: { path: string; data?: Uint8Array; loai?: string; sha256?: string }[] } = {},
): Promise<Uint8Array> {
  type Decl = { path: string; data?: Uint8Array; loai?: string; sha256?: string };
  const declare: Decl[] = opts.declare ?? Object.entries(files).map(([path, data]) => ({ path, data, loai: path.startsWith('notes/') ? new TextDecoder().decode(data).match(/loai: (\S+)/)?.[1] : undefined }));
  const listed = [];
  for (const d of declare) {
    listed.push({ path: d.path, sha256: d.sha256 ?? await sha256Hex(d.data ?? files[d.path] ?? new Uint8Array()), ...(d.loai ? { loai: d.loai } : {}) });
  }
  const zippable: Zippable = { 'pack.json': encodeUtf8(JSON.stringify({ ...template(opts.manifest), files: listed })) };
  for (const [path, data] of Object.entries(files)) zippable[path] = data;
  return zipSync(zippable);
}

export interface Signer { keyId: string; publicKey: string; sign(packId: string, version: string, sha: string): Promise<string> }

export async function makeSigner(keyId = 'k2026'): Promise<Signer> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer);
  const b64 = (u: Uint8Array) => toBase64Url(u).replace(/-/g, '+').replace(/_/g, '/');
  return {
    keyId,
    publicKey: b64(raw),
    async sign(packId, version, sha) {
      return b64(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, signingMessage(packId, version, sha))));
    },
  };
}
