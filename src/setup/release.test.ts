import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareVersions,
  DOWNLOAD_PREFIX,
  downloadText,
  downloadVerified,
  fetchLatestRelease,
  LATEST_RELEASE_API,
  manifestAssetOf,
  parseManifest,
  selectAsset,
  sha512Matches,
  sha512OfFile,
  SetupError,
  targetFor,
  type Fetch,
  type Release,
} from './release.js';

// Shaped like the real v1.0.4 manifests (sha512 values replaced by ones of the fake payloads below).
const ZIP = Buffer.from('fake GenBot zip bytes');
const EXE = Buffer.from('fake GenBot setup.exe bytes');
const DMG = Buffer.from('fake dmg');
const b64 = (b: Buffer) => createHash('sha512').update(b).digest('base64');

const LATEST_MAC = `version: 1.0.4
files:
  - url: GenBot-1.0.4-arm64.zip
    sha512: ${b64(ZIP)}
    size: ${ZIP.length}
  - url: GenBot-1.0.4-arm64.dmg
    sha512: ${b64(DMG)}
    size: ${DMG.length}
path: GenBot-1.0.4-arm64.zip
sha512: ${b64(ZIP)}
releaseDate: '2026-11-24T03:30:10.492Z'
`;
const LATEST_WIN = `version: 1.0.4
files:
  - url: GenBot-1.0.4-setup.exe
    sha512: ${b64(EXE)}
    size: ${EXE.length}
path: GenBot-1.0.4-setup.exe
sha512: ${b64(EXE)}
releaseDate: '2026-11-24T03:11:49.827Z'
`;

const dl = (name: string) => `${DOWNLOAD_PREFIX}v1.0.4/${name}`;
const FILES: Record<string, Buffer> = {
  'GenBot-1.0.4-arm64.zip': ZIP,
  'GenBot-1.0.4-arm64.dmg': DMG,
  'GenBot-arm64.dmg': DMG,
  'GenBot-1.0.4-setup.exe': EXE,
  'GenBot-setup.exe': EXE,
  'latest-mac.yml': Buffer.from(LATEST_MAC),
  'latest.yml': Buffer.from(LATEST_WIN),
};
const apiBody = {
  tag_name: 'v1.0.4',
  draft: false,
  prerelease: false,
  assets: [
    ...Object.entries(FILES).map(([name, b]) => ({ name, size: b.length, browser_download_url: dl(name) })),
    { name: 'evil.zip', size: 1, browser_download_url: 'https://example.com/evil.zip' },
  ],
};

/** Fake GitHub: the API, then each download redirects once to the asset CDN, as github.com does. */
function fakeGithub(over: { cdn?: (name: string) => Buffer; apiStatus?: number; apiHeaders?: Record<string, string>; redirectTo?: (name: string) => string } = {}): { fetch: Fetch; calls: string[] } {
  const calls: string[] = [];
  const f = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url === LATEST_RELEASE_API) {
      if (over.apiStatus) return new Response('{"message":"API rate limit exceeded"}', { status: over.apiStatus, headers: over.apiHeaders });
      return Response.json(apiBody);
    }
    if (url.startsWith(DOWNLOAD_PREFIX)) {
      const name = url.split('/').pop()!;
      return new Response(null, { status: 302, headers: { location: over.redirectTo?.(name) ?? `https://release-assets.githubusercontent.com/x/${name}?sig=1` } });
    }
    if (url.startsWith('https://release-assets.githubusercontent.com/x/')) {
      const name = new URL(url).pathname.split('/').pop()!;
      const body = over.cdn?.(name) ?? FILES[name];
      return body ? new Response(new Uint8Array(body)) : new Response('nope', { status: 404 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch: f as Fetch, calls };
}

const tmp: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-release-test-'));
  tmp.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('targetFor', () => {
  it('Apple silicon gets the arm64 zip from latest-mac.yml', () => {
    const t = targetFor('darwin', 'arm64');
    expect(t.ok && t.target.manifest).toBe('latest-mac.yml');
    expect(t.ok && t.target.file.test('GenBot-1.0.4-arm64.zip')).toBe(true);
    expect(t.ok && t.target.file.test('GenBot-1.0.4-arm64.dmg')).toBe(false);
  });

  it('x64 Node under Rosetta on Apple silicon still counts as Apple silicon', () => {
    expect(targetFor('darwin', 'x64', true).ok).toBe(true);
  });

  it('Intel Mac and Linux are unsupported, with what to do instead', () => {
    const intel = targetFor('darwin', 'x64', false);
    expect(intel.ok).toBe(false);
    expect(!intel.ok && intel.reason).toMatch(/Intel/);
    expect(!intel.ok && intel.instead).toMatch(/vẫn được cài/);
    const linux = targetFor('linux', 'x64');
    expect(!linux.ok && linux.reason).toMatch(/Linux/);
  });

  it('Windows gets the NSIS setup from latest.yml; ARM Windows gets a note', () => {
    const t = targetFor('win32', 'x64');
    expect(t.ok && t.target.manifest).toBe('latest.yml');
    expect(t.ok && t.target.file.test('GenBot-1.0.4-setup.exe')).toBe(true);
    expect(t.ok && t.target.file.test('GenBot-setup.exe')).toBe(false);
    const arm = targetFor('win32', 'arm64');
    expect(arm.ok && arm.note).toMatch(/x64/);
  });
});

describe('versions', () => {
  it('compares tags and plain versions', () => {
    expect(compareVersions('1.0.3', 'v1.0.4')).toBeLessThan(0);
    expect(compareVersions('v1.0.4', '1.0.4')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions(null, '1.0.0')).toBeLessThan(0);
  });
});

describe('release selection', () => {
  it('reads the latest release and keeps only assets of genbot-releases', async () => {
    const { fetch } = fakeGithub();
    const r = await fetchLatestRelease(fetch);
    expect(r.tag).toBe('v1.0.4');
    expect(r.assets.map((a) => a.name)).not.toContain('evil.zip');
  });

  it('picks the versioned installer from the manifest of the same release, for each OS', async () => {
    const { fetch } = fakeGithub();
    const release = await fetchLatestRelease(fetch);
    for (const [platform, name] of [['darwin', 'GenBot-1.0.4-arm64.zip'], ['win32', 'GenBot-1.0.4-setup.exe']] as const) {
      const t = targetFor(platform, platform === 'darwin' ? 'arm64' : 'x64');
      if (!t.ok) throw new Error('unsupported');
      const manifest = parseManifest(await downloadText(fetch, manifestAssetOf(release, t.target)));
      const sel = selectAsset(release, t.target, manifest);
      expect(sel.asset.name).toBe(name);
      expect(sel.version).toBe('1.0.4');
      expect(sel.expected.sha512).toBe(b64(FILES[name]!));
    }
  });

  it('refuses a manifest of another version, a missing manifest, or a size mismatch', () => {
    const t = targetFor('darwin', 'arm64');
    if (!t.ok) throw new Error('unsupported');
    const release: Release = { tag: 'v1.0.4', assets: apiBody.assets.slice(0, -1).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })) };
    expect(() => selectAsset(release, t.target, parseManifest(LATEST_MAC.replace('version: 1.0.4', 'version: 1.0.5')))).toThrow(/1\.0\.5/);
    expect(() => manifestAssetOf({ tag: 'v1.0.4', assets: [] }, t.target)).toThrow(/latest-mac\.yml/);
    const wrongSize = { ...release, assets: release.assets.map((a) => (a.name === 'GenBot-1.0.4-arm64.zip' ? { ...a, size: a.size + 1 } : a)) };
    expect(() => selectAsset(wrongSize, t.target, parseManifest(LATEST_MAC))).toThrow(/Kích thước/);
  });

  it('drops manifest entries whose sha512 is not a sha512', () => {
    const m = parseManifest('version: 1.0.4\nfiles:\n  - url: GenBot-1.0.4-arm64.zip\n    sha512: abc\n    size: 1\n');
    expect(m.files).toEqual([]);
  });

  it('says clearly when GitHub rate-limits', async () => {
    const { fetch } = fakeGithub({ apiStatus: 403, apiHeaders: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) } });
    const err = await fetchLatestRelease(fetch).catch((e: unknown) => e as SetupError);
    expect(err).toBeInstanceOf(SetupError);
    expect((err as SetupError).message).toMatch(/quá nhiều lần/);
    expect((err as SetupError).hint).toMatch(/Chạy lại lúc/);
  });
});

describe('downloadVerified', () => {
  async function pick(fetch: Fetch) {
    const t = targetFor('darwin', 'arm64');
    if (!t.ok) throw new Error('unsupported');
    const release = await fetchLatestRelease(fetch);
    return selectAsset(release, t.target, parseManifest(await downloadText(fetch, manifestAssetOf(release, t.target))));
  }

  it('downloads through the CDN redirect and checks sha512 from the file on disk', async () => {
    const { fetch, calls } = fakeGithub();
    const sel = await pick(fetch);
    const dest = path.join(tempDir(), sel.asset.name);
    await downloadVerified(fetch, sel.asset, sel.expected, dest);
    expect(fs.readFileSync(dest)).toEqual(ZIP);
    expect(sha512Matches(await sha512OfFile(dest), sel.expected.sha512)).toBe(true);
    expect(calls.some((u) => u.startsWith('https://release-assets.githubusercontent.com/'))).toBe(true);
  });

  it('deletes a file whose sha512 does not match, before anything opens it', async () => {
    const tampered = Buffer.from('fake GenBot zip byteZ'); // same length, different bytes
    const { fetch } = fakeGithub({ cdn: (name) => (name.endsWith('.zip') ? tampered : FILES[name]!) });
    const sel = await pick(fetch);
    const dest = path.join(tempDir(), sel.asset.name);
    await expect(downloadVerified(fetch, sel.asset, sel.expected, dest)).rejects.toThrow(/sha512/);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('refuses a redirect off GitHub and a plain-http hop', async () => {
    for (const to of ['https://evil.example.com/GenBot.zip', 'http://release-assets.githubusercontent.com/x/GenBot-1.0.4-arm64.zip']) {
      const { fetch } = fakeGithub({ redirectTo: (name) => (name.endsWith('.zip') ? to : `https://release-assets.githubusercontent.com/x/${name}`) });
      const sel = await pick(fetch);
      const dest = path.join(tempDir(), sel.asset.name);
      await expect(downloadVerified(fetch, sel.asset, sel.expected, dest)).rejects.toThrow(/dừng để an toàn/);
      expect(fs.existsSync(dest)).toBe(false);
    }
  });

  it('refuses a body longer than GitHub announced', async () => {
    const { fetch } = fakeGithub({ cdn: (name) => (name.endsWith('.zip') ? Buffer.concat([ZIP, Buffer.from('more')]) : FILES[name]!) });
    const sel = await pick(fetch);
    const dest = path.join(tempDir(), sel.asset.name);
    await expect(downloadVerified(fetch, sel.asset, sel.expected, dest)).rejects.toThrow(/lớn hơn/);
    expect(fs.existsSync(dest)).toBe(false);
  });
});
