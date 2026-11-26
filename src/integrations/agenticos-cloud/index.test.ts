import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationUsageError } from '../types.js';
import { agenticosCloudIntegration, buildCloudCommands, testCloud } from './index.js';
import { normaliseCloudUrl } from './client.js';

const TOKEN = 'machine-session-token-abc123';
const values = { cloud_url: 'https://cloud.example.com/', session_token: TOKEN };
let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cloud-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function file(name: string, bytes: number[], size = 64): string {
  const buf = Buffer.alloc(size);
  Buffer.from(bytes).copy(buf);
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

/** A fake cloud + R2: records every request. */
function fakeCloud() {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, method: init?.method ?? 'GET', headers, body: init?.body });
    if (url === 'https://cloud.example.com/uploads' && init?.method === 'POST') {
      return Response.json({ id: 'upl_1', uploadUrl: 'https://acc.r2.cloudflarestorage.com/b/u/x/post-media/upl_1.jpg?X-Amz-Signature=s', headers: { 'content-type': 'image/jpeg', 'content-length': '64' } }, { status: 201 });
    }
    if (url.startsWith('https://acc.r2.cloudflarestorage.com/')) return new Response(null, { status: 200 });
    if (url === 'https://cloud.example.com/uploads/upl_1/complete') return Response.json({ id: 'upl_1', url: 'https://acc.r2.cloudflarestorage.com/read', expiresAt: '2026-11-27T09:00:00.000Z' });
    if (url === 'https://cloud.example.com/me') return Response.json({ user: { email: 'chu@example.com', name: 'Chủ' } });
    return Response.json({ error: { code: 'not_found', message: 'Không có đường này.' } }, { status: 404 });
  });
  return { calls, fetchImpl };
}

const command = (name: string, deps = {}) => buildCloudCommands(deps).find((c) => c.name === name)!;

describe('agenticos-cloud integration', () => {
  it('uploads a photo: asks for a signed URL, PUTs straight to storage, completes, returns the read URL', async () => {
    const { calls, fetchImpl } = fakeCloud();
    const photo = file('anh bia.jpg', [0xff, 0xd8, 0xff, 0xe0]);
    const out = await command('upload', { fetchImpl }).run({ agentId: 'main', values }, { positionals: [photo], flags: {} });
    expect(out).toEqual({ id: 'upl_1', url: 'https://acc.r2.cloudflarestorage.com/read', expiresAt: '2026-11-27T09:00:00.000Z', contentType: 'image/jpeg', size: 64, purpose: 'post-media' });
    expect(calls.map((c) => `${c.method} ${c.url.split('?')[0]}`)).toEqual([
      'POST https://cloud.example.com/uploads',
      'PUT https://acc.r2.cloudflarestorage.com/b/u/x/post-media/upl_1.jpg',
      'POST https://cloud.example.com/uploads/upl_1/complete',
    ]);
    expect(JSON.parse(String(calls[0].body))).toEqual({ contentType: 'image/jpeg', size: 64, purpose: 'post-media' });
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    // The storage PUT carries no session token and the signed content type.
    expect(calls[1].headers.authorization).toBeUndefined();
    expect(calls[1].headers['content-type']).toBe('image/jpeg');
    expect((calls[1].body as Uint8Array).length).toBe(64);
  });

  it('recognises the type from the bytes, not the extension, and refuses non-media before any request', async () => {
    const { calls, fetchImpl } = fakeCloud();
    const disguised = path.join(dir, 'secrets.jpg');
    fs.writeFileSync(disguised, 'OPENAI_API_KEY=sk-123');
    await expect(command('upload', { fetchImpl }).run({ agentId: 'main', values }, { positionals: [disguised], flags: {} })).rejects.toBeInstanceOf(IntegrationUsageError);
    await expect(command('upload', { fetchImpl }).run({ agentId: 'main', values }, { positionals: [path.join(dir, 'missing.png')], flags: {} })).rejects.toBeInstanceOf(IntegrationUsageError);
    expect(calls).toHaveLength(0);
    const png = file('a.bin', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await command('upload', { fetchImpl }).run({ agentId: 'main', values }, { positionals: [png], flags: { purpose: 'avatar' } });
    expect(JSON.parse(String(calls[0].body))).toMatchObject({ contentType: 'image/png', purpose: 'avatar' });
  });

  it('never puts the session token in an error', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: { message: `bad token ${TOKEN}` } }, { status: 401 }));
    const res = await testCloud(values, undefined, { fetchImpl });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain(TOKEN);
    const photo = file('a.jpg', [0xff, 0xd8, 0xff]);
    await expect(command('upload', { fetchImpl }).run({ agentId: 'main', values }, { positionals: [photo], flags: {} }))
      .rejects.toSatisfy((e: Error) => !e.message.includes(TOKEN));
  });

  it('checks the connection with GET /me', async () => {
    const { fetchImpl } = fakeCloud();
    expect(await testCloud(values, undefined, { fetchImpl })).toMatchObject({ ok: true, accountLabel: 'chu@example.com' });
    expect((await testCloud({ cloud_url: 'https://cloud.example.com' }, undefined, { fetchImpl })).ok).toBe(false);
  });

  it('accepts https, or http only on localhost', () => {
    expect(normaliseCloudUrl('https://cloud.example.com/')).toBe('https://cloud.example.com');
    expect(normaliseCloudUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(() => normaliseCloudUrl('http://cloud.example.com')).toThrow(IntegrationUsageError);
    expect(() => normaliseCloudUrl('https://u:p@cloud.example.com')).toThrow(IntegrationUsageError);
    expect(() => normaliseCloudUrl('')).toThrow(IntegrationUsageError);
  });

  it('marks delete as destructive and upload as a write; stores the token as a secret', () => {
    expect(agenticosCloudIntegration.commands.find((c) => c.name === 'uploads delete')).toMatchObject({ access: 'write', risk: 'destructive' });
    expect(agenticosCloudIntegration.commands.find((c) => c.name === 'upload')?.access).toBe('write');
    expect(agenticosCloudIntegration.fields.find((f) => f.key === 'session_token')?.kind).toBe('secret');
  });

  it('validates upload ids before calling', async () => {
    const { calls, fetchImpl } = fakeCloud();
    await expect(command('uploads delete', { fetchImpl }).run({ agentId: 'main', values }, { positionals: ['../me'], flags: {} })).rejects.toBeInstanceOf(IntegrationUsageError);
    expect(calls).toHaveLength(0);
  });
});
