// GenBot builds come from one public repo only: github.com/Freedombuiders/genbot-releases. This file finds the latest
// release through the GitHub API (no token), picks the asset for this machine, reads its sha512 from the
// electron-updater manifest of the SAME release (latest-mac.yml / latest.yml), downloads it into a temp dir and checks
// size and sha512 before anything opens it. Every URL and every redirect is checked against an allowlist.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';

export const GENBOT_OWNER = 'Freedombuiders';
export const GENBOT_REPO = 'genbot-releases';
export const LATEST_RELEASE_API = `https://api.github.com/repos/${GENBOT_OWNER}/${GENBOT_REPO}/releases/latest`;
/** Every asset must live under this prefix. */
export const DOWNLOAD_PREFIX = `https://github.com/${GENBOT_OWNER}/${GENBOT_REPO}/releases/download/`;
const USER_AGENT = 'open-agenticos-setup';
/** GitHub serves release files from its asset CDN after a redirect. */
const REDIRECT_HOSTS = [/^github\.com$/, /^objects\.githubusercontent\.com$/, /^release-assets\.githubusercontent\.com$/, /^[a-z0-9-]+\.githubusercontent\.com$/];
const MAX_REDIRECTS = 5;
const MAX_MANIFEST_BYTES = 64 * 1024;
/** The largest GenBot build is ~330 MB today; refuse anything absurd before writing it. */
export const MAX_ASSET_BYTES = 1024 * 1024 * 1024;

export type Fetch = typeof fetch;

export class SetupError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export interface ReleaseAsset {
  name: string;
  size: number;
  url: string;
}

export interface Release {
  tag: string;
  assets: ReleaseAsset[];
}

export interface ManifestFile {
  url: string;
  sha512: string;
  size: number;
}

export interface Manifest {
  version: string;
  files: ManifestFile[];
}

/** What to download for this machine. */
export interface GenbotTarget {
  os: 'mac' | 'win';
  manifest: 'latest-mac.yml' | 'latest.yml';
  /** matches the manifest entry (and asset) to install */
  file: RegExp;
}

export type TargetResult = { ok: true; target: GenbotTarget; note?: string } | { ok: false; reason: string; instead: string };

/**
 * GenBot ships Apple-silicon macOS (.zip for installs, .dmg for people) and x64 Windows (NSIS .exe). `armMac` is the
 * hardware answer (sysctl hw.optional.arm64), so an x64 Node under Rosetta still counts as Apple silicon.
 */
export function targetFor(platform: NodeJS.Platform, arch: string, armMac = arch === 'arm64'): TargetResult {
  if (platform === 'darwin') {
    if (!armMac) {
      return {
        ok: false,
        reason: 'GenBot chưa có bản cho Mac chip Intel (chỉ có bản Apple Silicon M1 trở lên).',
        instead: 'Open AgenticOS vẫn được cài. Để có bot, chạy GenBot trên một Mac Apple Silicon hoặc máy Windows trong cùng mạng, rồi ở Đội AI · Bot điền địa chỉ https:// của máy đó.',
      };
    }
    return { ok: true, target: { os: 'mac', manifest: 'latest-mac.yml', file: /^GenBot-\d+\.\d+\.\d+(?:[-+][\w.]+)?-arm64\.zip$/ } };
  }
  if (platform === 'win32') {
    const note = arch === 'arm64' ? 'Máy Windows ARM: GenBot chỉ có bản x64, Windows 11 chạy được qua giả lập nhưng chậm hơn.' : undefined;
    return { ok: true, target: { os: 'win', manifest: 'latest.yml', file: /^GenBot-\d+\.\d+\.\d+(?:[-+][\w.]+)?-setup\.exe$/ }, ...(note ? { note } : {}) };
  }
  return {
    ok: false,
    reason: `GenBot chưa có bản cho ${platform === 'linux' ? 'Linux' : platform}.`,
    instead: 'Open AgenticOS vẫn được cài. Để có bot, chạy GenBot trên một Mac Apple Silicon hoặc máy Windows, rồi ở Đội AI · Bot điền địa chỉ https:// của máy đó.',
  };
}

// ------------------------------------------------------------------ versions

/** "v1.0.4" / "1.0.4" → [1,0,4]; null when it does not parse. */
export function parseVersion(v: string | undefined | null): [number, number, number] | null {
  const m = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})/.exec((v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** <0 when a is older than b. Unparsable versions sort first. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

// ------------------------------------------------------------------ GitHub API

function checkAssetUrl(url: string): void {
  if (!url.startsWith(DOWNLOAD_PREFIX)) throw new SetupError(`Địa chỉ tải không thuộc ${GENBOT_OWNER}/${GENBOT_REPO}; dừng để an toàn.`);
}

function rateLimitError(res: Response): SetupError {
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  const when = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : 'khoảng một giờ nữa';
  return new SetupError(
    `GitHub tạm chặn vì mạng này đã hỏi quá nhiều lần (giới hạn 60 lần mỗi giờ khi không đăng nhập).`,
    `Chạy lại lúc ${when}. Hoặc tải tay GenBot ở https://github.com/${GENBOT_OWNER}/${GENBOT_REPO}/releases/latest, cài xong rồi chạy lại "npm run setup".`,
  );
}

export async function fetchLatestRelease(doFetch: Fetch = fetch): Promise<Release> {
  let res: Response;
  try {
    res = await doFetch(LATEST_RELEASE_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT, 'x-github-api-version': '2022-11-28' }, redirect: 'error' });
  } catch (e) {
    throw new SetupError(`Không kết nối được GitHub (${(e as Error).message}).`, 'Kiểm tra mạng rồi chạy lại "npm run setup".');
  }
  if ((res.status === 403 || res.status === 429) && (res.headers.get('x-ratelimit-remaining') === '0' || res.status === 429)) throw rateLimitError(res);
  if (!res.ok) throw new SetupError(`GitHub trả lỗi ${res.status} khi hỏi bản GenBot mới nhất.`, 'Chạy lại sau ít phút.');
  const data = (await res.json()) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  if (typeof data.tag_name !== 'string' || !Array.isArray(data.assets)) throw new SetupError('GitHub trả dữ liệu bản phát hành không đúng dạng.');
  const assets: ReleaseAsset[] = [];
  for (const a of data.assets as { name?: unknown; size?: unknown; browser_download_url?: unknown }[]) {
    if (typeof a?.name !== 'string' || typeof a.browser_download_url !== 'string' || typeof a.size !== 'number') continue;
    if (!a.browser_download_url.startsWith(DOWNLOAD_PREFIX)) continue;
    assets.push({ name: a.name, size: a.size, url: a.browser_download_url });
  }
  return { tag: data.tag_name, assets };
}

// ------------------------------------------------------------------ manifest

const SHA512_B64 = /^[A-Za-z0-9+/]{86}==$/;

export function parseManifest(text: string): Manifest {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    throw new SetupError('File kiểm tra (latest*.yml) của GenBot không đọc được.');
  }
  const d = doc as { version?: unknown; files?: unknown };
  if (typeof d?.version !== 'string' && typeof d?.version !== 'number') throw new SetupError('File kiểm tra của GenBot thiếu số phiên bản.');
  if (!Array.isArray(d.files)) throw new SetupError('File kiểm tra của GenBot thiếu danh sách file.');
  const files: ManifestFile[] = [];
  for (const f of d.files as { url?: unknown; sha512?: unknown; size?: unknown }[]) {
    if (typeof f?.url !== 'string' || typeof f.sha512 !== 'string' || !SHA512_B64.test(f.sha512)) continue;
    files.push({ url: f.url, sha512: f.sha512, size: typeof f.size === 'number' ? f.size : -1 });
  }
  return { version: String(d.version), files };
}

export interface Selection {
  version: string;
  asset: ReleaseAsset;
  manifestAsset: ReleaseAsset;
}

/** Manifest asset of the release for this target. */
export function manifestAssetOf(release: Release, target: GenbotTarget): ReleaseAsset {
  const m = release.assets.find((a) => a.name === target.manifest);
  if (!m) throw new SetupError(`Bản ${release.tag} không có file kiểm tra ${target.manifest}; không cài khi chưa kiểm được sha512.`);
  checkAssetUrl(m.url);
  return m;
}

/** Picks the installer from the manifest of the same release, so the sha512 always belongs to the file downloaded. */
export function selectAsset(release: Release, target: GenbotTarget, manifest: Manifest): { asset: ReleaseAsset; expected: ManifestFile; version: string } {
  if (compareVersions(manifest.version, release.tag) !== 0) {
    throw new SetupError(`File kiểm tra ghi phiên bản ${manifest.version} nhưng bản phát hành là ${release.tag}; dừng để an toàn.`);
  }
  const expected = manifest.files.find((f) => target.file.test(f.url));
  if (!expected) throw new SetupError(`File kiểm tra ${target.manifest} không có bản cài cho máy này.`);
  const asset = release.assets.find((a) => a.name === expected.url);
  if (!asset) throw new SetupError(`Bản ${release.tag} thiếu file ${expected.url}.`);
  checkAssetUrl(asset.url);
  if (expected.size >= 0 && asset.size !== expected.size) throw new SetupError(`Kích thước ${asset.name} trên GitHub khác file kiểm tra; dừng để an toàn.`);
  if (asset.size > MAX_ASSET_BYTES) throw new SetupError(`${asset.name} lớn bất thường (${asset.size} byte); dừng để an toàn.`);
  return { asset, expected, version: manifest.version };
}

// ------------------------------------------------------------------ download

function allowedHop(url: URL): boolean {
  return url.protocol === 'https:' && REDIRECT_HOSTS.some((re) => re.test(url.hostname));
}

/** GET with manual redirects, each hop https and on GitHub's hosts. */
async function getFollowing(doFetch: Fetch, start: string): Promise<Response> {
  let url = new URL(start);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowedHop(url)) throw new SetupError(`Bị chuyển tới ${url.host}, không phải máy chủ của GitHub; dừng để an toàn.`);
    let res: Response;
    try {
      res = await doFetch(url.href, { headers: { 'user-agent': USER_AGENT, accept: 'application/octet-stream' }, redirect: 'manual' });
    } catch (e) {
      throw new SetupError(`Tải từ GitHub bị ngắt (${(e as Error).message}).`, 'Kiểm tra mạng rồi chạy lại "npm run setup".');
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new SetupError('GitHub chuyển hướng mà không có địa chỉ.');
      url = new URL(loc, url);
      continue;
    }
    if (res.status === 403 || res.status === 429) throw rateLimitError(res);
    if (!res.ok || !res.body) throw new SetupError(`GitHub trả lỗi ${res.status} khi tải file.`);
    return res;
  }
  throw new SetupError('Bị chuyển hướng quá nhiều lần khi tải; dừng để an toàn.');
}

export async function downloadText(doFetch: Fetch, asset: ReleaseAsset): Promise<string> {
  checkAssetUrl(asset.url);
  if (asset.size > MAX_MANIFEST_BYTES) throw new SetupError(`${asset.name} lớn bất thường; dừng để an toàn.`);
  const res = await getFollowing(doFetch, asset.url);
  const text = await res.text();
  if (text.length > MAX_MANIFEST_BYTES) throw new SetupError(`${asset.name} lớn bất thường; dừng để an toàn.`);
  return text;
}

export function sha512Matches(actualBase64: string, expectedBase64: string): boolean {
  const a = Buffer.from(actualBase64, 'base64');
  const b = Buffer.from(expectedBase64, 'base64');
  return a.length === 64 && b.length === 64 && a.equals(b);
}

export async function sha512OfFile(file: string): Promise<string> {
  const hash = createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('base64');
}

/**
 * Streams the asset to `dest` (a file in a fresh temp dir), then re-reads the file from disk and compares its sha512
 * and size with the manifest. Throws, and deletes `dest`, on any mismatch: the caller opens the file only on success.
 */
export async function downloadVerified(
  doFetch: Fetch,
  asset: ReleaseAsset,
  expected: ManifestFile,
  dest: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  checkAssetUrl(asset.url);
  const res = await getFollowing(doFetch, asset.url);
  const out = await fs.promises.open(dest, 'wx', 0o600);
  let done = 0;
  try {
    try {
      const reader = res.body!.getReader();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        done += value.byteLength;
        if (done > MAX_ASSET_BYTES || (asset.size > 0 && done > asset.size)) {
          await reader.cancel().catch(() => undefined);
          throw new SetupError(`${asset.name} lớn hơn kích thước GitHub báo; dừng để an toàn.`);
        }
        await out.write(value);
        onProgress?.(done, asset.size);
      }
    } finally {
      await out.close();
    }
    if (asset.size > 0 && done !== asset.size) throw new SetupError(`${asset.name} tải về thiếu (${done}/${asset.size} byte).`, 'Chạy lại "npm run setup".');
    const actual = await sha512OfFile(dest);
    if (!sha512Matches(actual, expected.sha512)) {
      throw new SetupError(`${asset.name} tải về không khớp sha512 trong ${expected.url === asset.name ? 'file kiểm tra' : 'manifest'}; đã xoá, không mở.`, 'Chạy lại "npm run setup". Nếu vẫn lỗi, báo cho người phát hành GenBot.');
    }
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw e;
  }
}
