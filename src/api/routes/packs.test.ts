// Kho dữ liệu over HTTP, with the owner token on: desktop sign-in through the callback, then preview,
// install and uninstall of the cloud's sample pack against a fake cloud.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '../../core/deps.js';
import { createTestHarness } from '../../modules/test-deps.js';
import { fakeCloud, keyPair, samplePack } from '../../packs/test-packs.js';
import { createNotes } from '../../shared/notes.js';
import { sampleBrain, testLog } from '../../shared/test-kit.js';
import { createApiServer } from '../server.js';
import { packServicesFor } from './packs.js';

const TOKEN = 'owner-token';
const ID = 'tra-va-qua-tang-co-ban';
let app: ReturnType<typeof createApiServer>['app'];
let deps: AppDeps;
let cloud: ReturnType<typeof fakeCloud>;
let root: string;
const savedKeys = process.env.AIOS_PACK_KEYS;

const req = async (method: string, url: string, body?: unknown, auth = true) => {
  const res = await app.request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
};

beforeEach(() => {
  const th = createTestHarness({ modulesDir: '/nonexistent', env: { AIOS_TOKEN: TOKEN } });
  const sb = sampleBrain();
  root = sb.root;
  deps = { ...th.deps, brain: sb.brain, modules: { mount() {} } } as unknown as AppDeps;
  deps.notes = createNotes({ brain: sb.brain, canRead: () => true, canWrite: () => true, log: testLog });
  cloud = fakeCloud();
  const kp = keyPair();
  process.env.AIOS_PACK_KEYS = JSON.stringify(kp.keys);
  const { zip } = samplePack();
  cloud.publish(ID, '1.0.0', { zip, keyId: kp.keyId, signature: kp.sign(ID, '1.0.0', zip) }, { module: 'learn', name: 'Trà và quà tặng' });
  packServicesFor(deps, { fetchImpl: cloud.fetchImpl });
  app = createApiServer(deps).app;
});
afterEach(() => {
  if (savedKeys === undefined) delete process.env.AIOS_PACK_KEYS;
  else process.env.AIOS_PACK_KEYS = savedKeys;
});

async function signIn() {
  const start = await req('POST', '/api/cloud/login/start', { cloudUrl: cloud.base });
  expect(start.status).toBe(200);
  const url = new URL(start.json.url);
  expect(url.searchParams.get('return')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/cloud\/callback$/);
  return url.searchParams.get('state')!;
}

describe('cloud sign-in over HTTP', () => {
  it('only the callback skips the owner token; a wrong state is refused and changes nothing', async () => {
    expect((await req('GET', '/api/packs/installed', undefined, false)).status).toBe(401);
    expect((await req('POST', '/api/cloud/login/start', { cloudUrl: cloud.base }, false)).status).toBe(401);
    const state = await signIn();

    const wrong = await req('GET', `/api/cloud/callback?code=${cloud.exchange.code}&state=${state}x`, undefined, false);
    expect(wrong.status).toBe(400);
    expect(wrong.text).toContain('không hợp lệ');
    expect(cloud.calls.filter((c) => c.url.endsWith('/auth/exchange'))).toEqual([]);
    expect((await req('GET', '/api/cloud/status')).json).toMatchObject({ connected: false });

    const ok = await req('GET', `/api/cloud/callback?code=${cloud.exchange.code}&state=${state}`, undefined, false);
    expect(ok.status).toBe(200);
    expect(ok.text).toContain(cloud.exchange.email);
    expect(ok.text).not.toContain(cloud.exchange.token);
    const status = await req('GET', '/api/cloud/status');
    expect(status.json).toMatchObject({ connected: true, cloudUrl: cloud.base, account: cloud.exchange.email });
    expect(status.text).not.toContain(cloud.exchange.token);
    // stored encrypted, not in the clear
    const raw = JSON.stringify(deps.db.prepare('SELECT * FROM integration_credentials').all());
    expect(raw).not.toContain(cloud.exchange.token);
  });
});

describe('Kho dữ liệu over HTTP', () => {
  it('without a cloud session the store says so (412)', async () => {
    const r = await req('GET', '/api/packs');
    expect(r.status).toBe(412);
    expect(r.json.error.message).toMatch(/Đăng nhập cloud/i);
  });

  it('list, preview, install (needs the plan), installed, uninstall', async () => {
    const state = await signIn();
    await req('GET', `/api/cloud/callback?code=${cloud.exchange.code}&state=${state}`, undefined, false);

    const list = await req('GET', '/api/packs?module=learn');
    expect(list.status).toBe(200);
    expect(list.json.items).toMatchObject([{ id: ID, installs: [], updateAvailable: false }]);
    expect((await req('GET', '/api/packs?module=care')).status).toBe(400);

    const preview = await req('POST', `/api/packs/${ID}/preview`, { version: '1.0.0', folder: 'cong-ty-b' });
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ packId: ID, folderId: 'cong-ty-b', from: null, assets: ['assets/bia.svg'] });
    expect(preview.json.counts.create).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(root, 'brain', 'cong-ty-b', 'bai-hoc'))).toBe(false);

    expect((await req('POST', `/api/packs/${ID}/install`, { version: '1.0.0', folder: 'cong-ty-b', planId: 'a'.repeat(64) })).status).toBe(409);
    expect((await req('POST', `/api/packs/${ID}/install`, { version: '1.0.0', folder: 'cong-ty-b', planId: preview.json.planId }, false)).status).toBe(401);
    const inst = await req('POST', `/api/packs/${ID}/install`, { version: '1.0.0', folder: 'cong-ty-b', planId: preview.json.planId });
    expect(inst.status).toBe(200);
    expect(inst.json.written).toHaveLength(preview.json.counts.create);
    expect((await req('GET', '/api/packs/installed')).json.items).toMatchObject([{ packId: ID, version: '1.0.0', folderId: 'cong-ty-b' }]);
    expect((await req('GET', `/api/packs/${ID}`)).json.installs[0].fileStatus.every((f: { status: string }) => f.status === 'unchanged')).toBe(true);
    expect(deps.audit.list({ action: 'pack.install' })).toHaveLength(1);

    const up = await req('POST', `/api/packs/${ID}/uninstall/preview`, { folder: 'cong-ty-b' });
    expect(up.json.counts.delete).toBe(inst.json.written.length);
    const un = await req('POST', `/api/packs/${ID}/uninstall`, { folder: 'cong-ty-b', planId: up.json.planId });
    expect(un.status).toBe(200);
    expect((await req('GET', '/api/packs/installed')).json.items).toEqual([]);
    expect((await req('POST', `/api/packs/${ID}/uninstall/preview`, { folder: 'cong-ty-b' })).status).toBe(404);
  });

  it('a yanked release is 410', async () => {
    const state = await signIn();
    await req('GET', `/api/cloud/callback?code=${cloud.exchange.code}&state=${state}`, undefined, false);
    cloud.yank(ID, '1.0.0');
    const r = await req('POST', `/api/packs/${ID}/preview`, { version: '1.0.0', folder: 'cong-ty-b' });
    expect(r.status).toBe(410);
  });
});
