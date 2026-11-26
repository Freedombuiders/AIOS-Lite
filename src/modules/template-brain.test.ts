// The template module writes a brain note through ctx.brain.notes (never fs.writeFile).
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { errorBody, handleError } from '../api/errors.js';
import type { AppDeps } from '../core/deps.js';
import { createNotes } from '../shared/notes.js';
import { REPO_ROOT, sampleBrain, testLog } from '../shared/test-kit.js';
import template from '../../modules/_template/server/index.js';
import { createModuleContext } from './context.js';
import type { ModuleManifest } from './sdk.js';
import { createTestHarness, type TestHarness } from './test-deps.js';

let h: TestHarness;
let app: Hono;
let brainRoot: string;

beforeEach(() => {
  h = createTestHarness();
  const sb = sampleBrain(h.deps.db);
  brainRoot = path.join(sb.root, 'brain');
  const deps = h.deps as AppDeps & { brain: AppDeps['brain']; notes: AppDeps['notes'] };
  deps.brain = sb.brain;
  deps.notes = createNotes({ brain: sb.brain, canRead: () => false, canWrite: () => false, log: testLog, bus: deps.bus });
  const dir = path.join(REPO_ROOT, 'modules', '_template');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf8')) as ModuleManifest;
  const ctx = createModuleContext(deps, manifest, dir, { stops: new Set() }, {
    settings: { all: () => ({}), patch() {} } as never,
    provides: () => undefined,
    isEnabled: () => true,
  });
  app = new Hono();
  app.onError(handleError(testLog));
  app.notFound((c) => c.json(errorBody('not_found', 'x'), 404));
  template.routes!(app, ctx);
});
afterEach(() => h.cleanup());

const post = async (body: unknown) => {
  const res = await app.request('/brain-note', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};

describe('_template module and ctx.brain.notes', () => {
  it('creates a note signed by the module, indexed and searchable', async () => {
    const r = await post({ folder: 'cong-ty-b', slug: 'thu-nghiem', text: 'ghi chú từ module mẫu' });
    expect(r.status).toBe(201);
    expect(r.json.path).toBe('ghi-chu-mau/thu-nghiem.md');
    const text = fs.readFileSync(path.join(brainRoot, 'cong-ty-b', 'ghi-chu-mau', 'thu-nghiem.md'), 'utf8');
    expect(text).toMatch(/^---\nnguon: module:_template\n/);
    expect(h.deps.brain.search('ghi chu tu module mau').map((x) => x.path)).toEqual(['ghi-chu-mau/thu-nghiem.md']);
    // a second create of the same note is a conflict, not an overwrite
    expect((await post({ folder: 'cong-ty-b', slug: 'thu-nghiem', text: 'x' })).status).toBe(409);
    expect((await post({ folder: 'khong-co', slug: 'a' })).status).toBe(400);
  });

  it('a module acting for an agent is held to that agent\'s globs', () => {
    const ctxNotes = h.deps.notes.forModule('_template');
    expect(() => ctxNotes.asAgent('main').create({ folderId: 'cong-ty-b', relPath: 'x.md' }, {}, '', { message: 'x' })).toThrow(/không có quyền ghi/);
  });
});
