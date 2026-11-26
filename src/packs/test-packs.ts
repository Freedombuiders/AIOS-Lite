// Test helpers for packs (not part of the build): a ZIP writer that can also lie (bombs, symlinks, bad paths),
// the cloud's sample pack built the way `npm run pack -- build` builds it, Ed25519 signing, and a fake cloud.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { frontMatterLoai, signingMessage, type PackManifest } from './format.js';
import { REPO_ROOT } from '../shared/test-kit.js';

export interface ZipEntry {
  name: string;
  data: Buffer | string;
  /** 0 stored, 8 deflate (default) */
  method?: 0 | 8;
  /** what the headers claim; defaults to the real size */
  declaredSize?: number;
  /** unix mode (e.g. 0o120777 for a symlink); written with "made by Unix" */
  unixMode?: number;
}

/** A plain ZIP (no data descriptors, no zip64), central directory as given. */
export function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const method = e.method ?? 8;
    const comp = method === 8 ? zlib.deflateRawSync(raw, { level: 9 }) : raw;
    const size = e.declaredSize ?? raw.length;
    const name = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(e.unixMode !== undefined ? (3 << 8) | 20 : 20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(e.unixMode !== undefined ? (e.unixMode << 16) >>> 0 : 0, 38);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

export type PackTemplate = Omit<PackManifest, 'files'>;

/** pack.json with every file's SHA-256 and each note's `loai` (what cloud/src/packs/build.ts does), zipped. */
export function buildPackZip(template: PackTemplate, files: { path: string; data: Buffer | string }[], extra: ZipEntry[] = []): { zip: Buffer; manifest: PackManifest } {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest: PackManifest = {
    ...template,
    files: sorted.map((f) => {
      const loai = f.path.startsWith('notes/') ? frontMatterLoai(f.data.toString()) : null;
      return { path: f.path, sha256: sha(f.data), ...(loai ? { loai } : {}) };
    }),
  };
  const zip = makeZip([{ name: 'pack.json', data: `${JSON.stringify(manifest, null, 2)}\n` }, ...sorted.map((f) => ({ name: f.path, data: f.data })), ...extra]);
  return { zip, manifest };
}

export const SAMPLE_PACK_DIR = path.join(REPO_ROOT, 'cloud', 'sample-packs', 'tra-va-qua-tang-co-ban');

/** The cloud's sample pack, read from cloud/sample-packs, optionally at another version / with changed files. */
export function samplePack(opts: { version?: string; edit?: (files: { path: string; data: Buffer | string }[]) => { path: string; data: Buffer | string }[] } = {}) {
  const template = JSON.parse(fs.readFileSync(path.join(SAMPLE_PACK_DIR, 'pack.json'), 'utf8')) as PackTemplate;
  const files: { path: string; data: Buffer | string }[] = [];
  const walk = (rel: string) => {
    const abs = path.join(SAMPLE_PACK_DIR, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else files.push({ path: r, data: fs.readFileSync(path.join(SAMPLE_PACK_DIR, r)) });
    }
  };
  walk('notes');
  walk('assets');
  return buildPackZip({ ...template, version: opts.version ?? template.version }, opts.edit ? opts.edit(files) : files);
}

export function keyPair(keyId = 'k-test') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64');
  return {
    keyId,
    keys: { [keyId]: raw },
    sign: (id: string, version: string, zip: Buffer) => crypto.sign(null, signingMessage(id, version, sha(zip)), privateKey).toString('base64'),
  };
}

export interface FakeRelease {
  zip: Buffer;
  signature: string;
  keyId: string;
  status?: 'published' | 'yanked';
  /** override what the cloud reports */
  sha256?: string;
}

/** An in-process fake of the cloud routes the core uses. Records every request. */
export function fakeCloud(base = 'https://cloud.test') {
  const releases = new Map<string, FakeRelease>();
  const meta = new Map<string, { module: string; name: string }>();
  const calls: { method: string; url: string; auth: string | null; body?: string }[] = [];
  const exchange = { code: 'good-code', token: 'sess-token-1', email: 'chu@example.test' };
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const latestOf = (id: string) =>
    [...releases.entries()].filter(([k, r]) => k.startsWith(`${id}@`) && r.status !== 'yanked').map(([k]) => k.split('@')[1]!).sort().at(-1);

  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    calls.push({ method: init.method ?? 'GET', url: input, auth: headers.get('authorization'), body: typeof init.body === 'string' ? init.body : undefined });
    if (url.origin === 'https://r2.test') {
      const r = releases.get(decodeURIComponent(url.pathname.slice(1)));
      return r ? new Response(new Uint8Array(r.zip), { status: 200 }) : new Response('no', { status: 404 });
    }
    if (url.origin !== base) return new Response('unknown host', { status: 599 });
    if (url.pathname === '/auth/exchange') {
      const b = JSON.parse(String(init.body)) as { code: string };
      if (b.code !== exchange.code) return json({ error: { code: 'unauthorized', message: 'Mã đăng nhập không hợp lệ, đã dùng hoặc đã hết hạn.' } }, 401);
      return json({ token: exchange.token, user: { email: exchange.email, name: null }, session: {} });
    }
    if (!headers.get('authorization')?.startsWith('Bearer ')) return json({ error: { code: 'unauthorized', message: 'no session' } }, 401);
    let m = /^\/packs\/([^/]+)\/releases\/([^/]+)\/download$/.exec(url.pathname);
    if (m) {
      const key = `${m[1]}@${decodeURIComponent(m[2]!)}`;
      const r = releases.get(key);
      if (!r) return json({ error: { code: 'not_found', message: 'Không tìm thấy bản phát hành.' } }, 404);
      if (r.status === 'yanked') return json({ error: { code: 'gone', message: 'Bản này đã bị thu hồi. Hãy tải bản mới hơn.' } }, 410);
      return json({ url: `https://r2.test/${encodeURIComponent(key)}`, expiresAt: new Date().toISOString(), sha256: r.sha256 ?? sha(r.zip), signature: r.signature, keyId: r.keyId, size: r.zip.length });
    }
    if (url.pathname === '/packs') {
      const items = [...meta.entries()].map(([id, p]) => ({ id, module: p.module, name: p.name, summary: null, industry: null, coverUrl: null, latest: { version: latestOf(id) } }));
      return json({ items: url.searchParams.get('module') ? items.filter((i) => i.module === url.searchParams.get('module')) : items });
    }
    if (url.pathname === '/packs/updates') {
      const have = (url.searchParams.get('have') ?? '').split(',').filter(Boolean);
      return json({ items: have.flatMap((h) => { const [id, v] = h.split('@') as [string, string]; const latest = latestOf(id); return latest && latest > v ? [{ id, have: v, latest, update: true, yanked: false }] : []; }) });
    }
    m = /^\/packs\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const p = meta.get(m[1]!);
      if (!p) return json({ error: { code: 'not_found', message: 'Không tìm thấy gói.' } }, 404);
      return json({ id: m[1], module: p.module, name: p.name, summary: null, industry: null, coverUrl: null, license: 'CC-BY-4.0', author: null, latest: { version: latestOf(m[1]!) }, releases: [], files: [] });
    }
    if (url.pathname === '/me') return json({ user: { email: exchange.email, name: null } });
    return json({ error: { code: 'not_found', message: 'no route' } }, 404);
  };

  return {
    base,
    calls,
    exchange,
    fetchImpl,
    publish(id: string, version: string, r: FakeRelease, info: { module?: string; name?: string } = {}) {
      releases.set(`${id}@${version}`, r);
      meta.set(id, { module: info.module ?? 'learn', name: info.name ?? id });
    },
    yank(id: string, version: string) {
      const r = releases.get(`${id}@${version}`);
      if (r) r.status = 'yanked';
    },
  };
}
