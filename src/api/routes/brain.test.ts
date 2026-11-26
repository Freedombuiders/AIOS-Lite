// PUT /api/brain/file over HTTP with the real brain and notes services.
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../core/config.js';
import type { AppDeps } from '../../core/deps.js';
import { createNotes } from '../../shared/notes.js';
import { sampleBrain, testLog } from '../../shared/test-kit.js';
import { errorBody, handleError } from '../errors.js';
import { brainRoutes } from './brain.js';

let app: Hono;
let root: string;
const audit: string[] = [];

const call = async (method: string, url: string, body?: unknown) => {
  const res = await app.request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};

beforeEach(() => {
  const sb = sampleBrain();
  root = sb.root;
  audit.length = 0;
  const notes = createNotes({ brain: sb.brain, canRead: () => false, canWrite: () => false, log: testLog });
  const config = loadConfig({ rootDir: root, loadDotEnv: false, env: {} });
  const deps = { config, db: sb.db, brain: sb.brain, notes, audit: { log: (e: { action: string }) => void audit.push(e.action) } } as unknown as AppDeps;
  app = new Hono();
  app.onError(handleError(testLog));
  app.notFound((c) => c.json(errorBody('not_found', 'x'), 404));
  brainRoutes(app, deps);
});

describe('PUT /api/brain/file', () => {
  it('saves, returns the new mtime, and the next GET/search see it', async () => {
    const got = await call('GET', '/api/brain/file?folder=cong-ty-b&path=danh-muc-tra-sen.md');
    expect(got.status).toBe(200);
    const r = await call('PUT', '/api/brain/file', { folder: 'cong-ty-b', path: 'danh-muc-tra-sen.md', content: '# Danh mục\nTrà ô long sen mới\n', expectMtimeMs: got.json.mtimeMs });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ folder: 'cong-ty-b', path: 'danh-muc-tra-sen.md', revision: String(r.json.mtimeMs) });
    expect(r.json.hash).toMatch(/^[0-9a-f]{64}$/);
    // expectHash works as well
    const again = await call('PUT', '/api/brain/file', { folder: 'cong-ty-b', path: 'danh-muc-tra-sen.md', content: '# Danh mục\nTrà ô long sen mới\n', expectHash: r.json.hash });
    expect(again.status).toBe(200);
    expect(typeof r.json.mtimeMs).toBe('number');
    expect(fs.readFileSync(path.join(root, 'brain', 'cong-ty-b', 'danh-muc-tra-sen.md'), 'utf8')).toBe('# Danh mục\nTrà ô long sen mới\n');
    expect((await call('GET', '/api/brain/file?folder=cong-ty-b&path=danh-muc-tra-sen.md')).json.mtimeMs).toBe(r.json.mtimeMs);
    expect((await call('GET', '/api/brain/search?q=long%20sen%20m%E1%BB%9Bi&folders=cong-ty-b')).json.items[0].path).toBe('danh-muc-tra-sen.md');
    expect(audit).toEqual(['brain.write', 'brain.write']);
  });

  it('accepts the web editor payload (vault + revision) and creates new notes', async () => {
    const got = await call('GET', '/api/brain/file?folder=ca-nhan&path=muc-tieu-quy.md');
    const r = await call('PUT', '/api/brain/file', { vault: 'ca-nhan', path: 'muc-tieu-quy.md', content: 'sửa', revision: String(got.json.mtimeMs) });
    expect(r.status).toBe(200);
    expect(r.json.content).toBe('sửa');
    const n = await call('PUT', '/api/brain/file', { folder: 'ca-nhan', path: 'moi/ghi-chu.md', content: '# Mới\n' });
    expect(n.status).toBe(200);
    expect(fs.existsSync(path.join(root, 'brain', 'ca-nhan', 'moi', 'ghi-chu.md'))).toBe(true);
  });

  it('returns 409 when the file changed since it was read', async () => {
    const got = await call('GET', '/api/brain/file?folder=cong-ty-b&path=danh-muc-tra-sen.md');
    const file = path.join(root, 'brain', 'cong-ty-b', 'danh-muc-tra-sen.md');
    fs.writeFileSync(file, 'sửa trong Obsidian');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    const r = await call('PUT', '/api/brain/file', { folder: 'cong-ty-b', path: 'danh-muc-tra-sen.md', content: 'bản web', expectMtimeMs: got.json.mtimeMs });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('conflict');
    expect(fs.readFileSync(file, 'utf8')).toBe('sửa trong Obsidian');
    expect((await call('PUT', '/api/brain/file', { vault: 'cong-ty-b', path: 'danh-muc-tra-sen.md', content: 'x', revision: String(got.json.mtimeMs) })).status).toBe(409);
  });

  it('returns 400 for non-markdown, escaping paths and missing fields; 404 for an unknown folder', async () => {
    expect((await call('PUT', '/api/brain/file', { folder: 'cong-ty-b', path: 'a.txt', content: 'x' })).status).toBe(400);
    expect((await call('PUT', '/api/brain/file', { folder: 'cong-ty-b', path: '../ca-nhan/x.md', content: 'x' })).status).toBe(400);
    expect((await call('PUT', '/api/brain/file', { folder: 'cong-ty-b', path: '/etc/x.md', content: 'x' })).status).toBe(400);
    expect((await call('PUT', '/api/brain/file', { path: 'a.md', content: 'x' })).status).toBe(400);
    expect((await call('PUT', '/api/brain/file', { folder: 'cong-ty-b', path: 'a.md' })).status).toBe(400);
    expect((await call('PUT', '/api/brain/file', { folder: 'cong-ty-b', path: 'a.md', content: 'x', revision: 'abc' })).status).toBe(400);
    // an existing note cannot be overwritten blind
    expect((await call('PUT', '/api/brain/file', { folder: 'cong-ty-b', path: 'danh-muc-tra-sen.md', content: 'x' })).status).toBe(400);
    expect((await call('PUT', '/api/brain/file', { folder: 'khong-co', path: 'a.md', content: 'x' })).status).toBe(404);
    expect(fs.existsSync(path.join(root, 'brain', 'ca-nhan', 'x.md'))).toBe(false);
    expect(audit).toEqual([]);
  });
});
