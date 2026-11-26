#!/usr/bin/env tsx
/**
 * Pack publisher CLI. Runs on the publisher's own machine: the private signing
 * key never goes to the cloud.
 *
 *   npm run pack -- keygen --out <dir> [--key-id <id>]
 *   npm run pack -- build <dir> [--out <zip>]
 *   npm run pack -- sign <zip> --key <private.pem> --key-id <id> [--out <sig.json>]
 *   npm run pack -- publish <zip> --sig <sig.json> [--url <cloud url>]
 *   npm run pack -- download <id> <version> [--out <zip>] [--url <cloud url>] [--pubkey <base64>]
 *
 * `publish` and `download` read the session token from AGENTICOS_CLOUD_TOKEN
 * (never from the command line, so it stays out of shell history) and the
 * cloud address from --url or AGENTICOS_CLOUD_URL.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { buildPack, type ManifestTemplate } from '../src/packs/build';
import { signingMessage, type PackManifest } from '../src/packs/format';
import { checkPackZip } from '../src/packs/zip-check';
import { sha256Hex } from '../src/lib/encoding';

interface Args { positionals: string[]; flags: Record<string, string> }

function parse(argv: string[]): Args {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`Thiếu giá trị cho ${a}`);
      flags[a.slice(2)] = next;
      i++;
    } else positionals.push(a);
  }
  return { positionals, flags };
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Thiếu ${what}`);
  return value;
}

function walk(root: string, dir: string, out: { path: string; data: Uint8Array }[]) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(root, rel, out);
    else if (entry.isFile()) out.push({ path: rel, data: new Uint8Array(fs.readFileSync(path.join(root, rel))) });
  }
}

function manifestOfZip(zip: Uint8Array): PackManifest {
  const raw = unzipSync(zip, { filter: (f) => f.name === 'pack.json' })['pack.json'];
  if (!raw) throw new Error('Zip không có pack.json');
  return JSON.parse(new TextDecoder().decode(raw)) as PackManifest;
}

async function keygen(a: Args) {
  const out = need(a.flags.out, '--out <thư mục>');
  const keyId = a.flags['key-id'] ?? `k${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  fs.mkdirSync(out, { recursive: true });
  const pemPath = path.join(out, `${keyId}.pem`);
  fs.writeFileSync(pemPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64');
  console.log(`Khoá bí mật: ${pemPath} (giữ trên máy này, không đưa lên cloud, không commit)`);
  console.log(`Khoá công khai (${keyId}): ${raw}`);
  console.log(`Thêm vào PACK_SIGNING_KEYS: ${JSON.stringify({ [keyId]: raw })}`);
}

async function build(a: Args) {
  const dir = need(a.positionals[0], '<thư mục gói>');
  const template = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8')) as ManifestTemplate;
  const files: { path: string; data: Uint8Array }[] = [];
  walk(dir, 'notes', files);
  walk(dir, 'assets', files);
  const { zip, manifest } = await buildPack(template, files);
  const out = a.flags.out ?? `${manifest.id}-${manifest.version}.zip`;
  fs.writeFileSync(out, zip);
  console.log(JSON.stringify({ zip: out, id: manifest.id, version: manifest.version, files: manifest.files.length, size: zip.length, sha256: await sha256Hex(zip) }, null, 2));
}

async function sign(a: Args) {
  const zipPath = need(a.positionals[0], '<file zip>');
  const keyId = need(a.flags['key-id'], '--key-id <id>');
  const key = createPrivateKey(fs.readFileSync(need(a.flags.key, '--key <file .pem>')));
  const zip = new Uint8Array(fs.readFileSync(zipPath));
  const { manifest } = await checkPackZip(zip);
  const sha = await sha256Hex(zip);
  const signature = edSign(null, signingMessage(manifest.id, manifest.version, sha), key).toString('base64');
  const out = a.flags.out ?? `${zipPath}.sig.json`;
  fs.writeFileSync(out, `${JSON.stringify({ packId: manifest.id, version: manifest.version, sha256: sha, keyId, signature }, null, 2)}\n`);
  console.log(`Đã ký ${manifest.id}@${manifest.version} (sha256 ${sha}) → ${out}`);
}

function cloud(a: Args) {
  const url = need(a.flags.url ?? process.env.AGENTICOS_CLOUD_URL, '--url hoặc AGENTICOS_CLOUD_URL').replace(/\/+$/, '');
  const token = need(process.env.AGENTICOS_CLOUD_TOKEN, 'AGENTICOS_CLOUD_TOKEN (phiên quản trị viên)');
  return async (method: string, p: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${url}${p}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
  };
}

function fail(step: string, r: { status: number; json: Record<string, unknown> }): never {
  const err = r.json.error as { message?: string } | undefined;
  throw new Error(`${step}: HTTP ${r.status} ${err?.message ?? JSON.stringify(r.json)}`);
}

async function publish(a: Args) {
  const zipPath = need(a.positionals[0], '<file zip>');
  const sig = JSON.parse(fs.readFileSync(need(a.flags.sig, '--sig <file .sig.json>'), 'utf8')) as { keyId: string; signature: string; sha256: string };
  const zip = new Uint8Array(fs.readFileSync(zipPath));
  if ((await sha256Hex(zip)) !== sig.sha256) throw new Error('File chữ ký không khớp với zip này.');
  const manifest = manifestOfZip(zip);
  const call = cloud(a);

  const created = await call('POST', '/admin/packs', {
    id: manifest.id, module: manifest.module, name: manifest.name, summary: manifest.summary, industry: manifest.industry,
  });
  if (created.status !== 201 && created.status !== 409) fail('Tạo gói', created);

  const rel = await call('POST', `/admin/packs/${manifest.id}/releases`, { version: manifest.version, size: zip.length });
  if (rel.status !== 201) fail('Tạo bản phát hành', rel);
  const { releaseId, uploadUrl, headers } = rel.json as { releaseId: string; uploadUrl: string; headers: Record<string, string> };

  // Straight to storage with the signed URL; content-length is set by fetch from the body.
  const { 'content-length': _len, ...sendHeaders } = headers;
  const put = await fetch(uploadUrl, { method: 'PUT', headers: sendHeaders, body: zip });
  if (!put.ok) throw new Error(`Tải zip lên: HTTP ${put.status}`);

  const fin = await call('POST', `/admin/releases/${releaseId}/finalize`);
  if (fin.status !== 200) fail('Kiểm gói', fin);
  const pub = await call('POST', `/admin/releases/${releaseId}/publish`, { signature: sig.signature, keyId: sig.keyId });
  if (pub.status !== 200) fail('Phát hành', pub);
  console.log(`Đã phát hành ${manifest.id}@${manifest.version} (${releaseId}).`);
}

async function download(a: Args) {
  const id = need(a.positionals[0], '<id gói>');
  const version = need(a.positionals[1], '<phiên bản>');
  const call = cloud(a);
  const r = await call('POST', `/packs/${id}/releases/${version}/download`);
  if (r.status !== 200) fail('Xin đường tải', r);
  const info = r.json as { url: string; sha256: string; signature: string; keyId: string; size: number };
  const res = await fetch(info.url);
  if (!res.ok) throw new Error(`Tải gói: HTTP ${res.status}`);
  const zip = new Uint8Array(await res.arrayBuffer());
  const sha = await sha256Hex(zip);
  const out = a.flags.out ?? `${id}-${version}.download.zip`;
  fs.writeFileSync(out, zip);
  const result: Record<string, unknown> = { file: out, size: zip.length, sha256: sha, sha256Expected: info.sha256, sha256Match: sha === info.sha256 };
  if (a.flags.pubkey) {
    const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(a.flags.pubkey, 'base64').toString('base64url') }, format: 'jwk' });
    result.signatureValid = edVerify(null, signingMessage(id, version, sha), pub, Buffer.from(info.signature, 'base64'));
  }
  console.log(JSON.stringify(result, null, 2));
  if (sha !== info.sha256 || result.signatureValid === false) process.exitCode = 1;
}

const commands: Record<string, (a: Args) => Promise<void>> = { keygen, build, sign, publish, download };

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const run = cmd ? commands[cmd] : undefined;
  if (!run) {
    console.error('Dùng: pack <keygen|build|sign|publish|download> …  (xem đầu file scripts/pack.ts)');
    process.exit(2);
  }
  await run(parse(rest));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
