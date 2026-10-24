import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  process.env.VIDEO_EDIT_FFMPEG = '/nonexistent/ffmpeg-for-tests';
  process.env.VIDEO_EDIT_FFPROBE = '/nonexistent/ffprobe-for-tests';
  return { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'kol-personas-')) };
});
vi.mock('./config.js', async (orig) => ({ ...(await orig<typeof import('./config.js')>()), STORE_DIR: store.dir, GOOGLE_API_KEY: '' }));

import fs from 'fs';
import path from 'path';

import { _initTestDatabase } from './test-db.js';
import { kolDir, KolError, kolDb, nowSec, resolveKolFile } from './core.js';
import {
  archivePersona, createPersona, DEFAULT_DISCLOSURE, getPersona, listPersonaIds, listPersonaSummaries, requirePersona, updatePersona,
} from './personas.js';
import { addRefFromAsset, addRefFromUpload, deleteRef, getRefFile, listRefs, patchRef } from './refs.js';

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function tempFile(bytes: Buffer, name = 'x.png'): string {
  const dir = fs.mkdtempSync(path.join(store.dir, 'up-'));
  const f = path.join(dir, name);
  fs.writeFileSync(f, bytes);
  return f;
}

async function expectStatus(p: Promise<unknown> | (() => unknown), status: number): Promise<KolError> {
  try {
    if (typeof p === 'function') p(); else await p;
  } catch (err) {
    expect(err).toBeInstanceOf(KolError);
    expect((err as KolError).status).toBe(status);
    return err as KolError;
  }
  throw new Error(`expected KolError ${status}`);
}

beforeEach(() => {
  _initTestDatabase();
});

afterAll(() => fs.rmSync(store.dir, { recursive: true, force: true }));

describe('persona CRUD and validation', () => {
  it('creates with defaults: draft, AI disclosure, autopilot off', () => {
    const p = createPersona({ name: '  Mia  ', handle: '@Mia.VN' });
    expect(p.name).toBe('Mia');
    expect(p.handle).toBe('mia.vn');
    expect(p.status).toBe('draft');
    expect(p.disclosureText).toBe(DEFAULT_DISCLOSURE);
    expect(p.consistencyThreshold).toBe(80);
    expect(p.realismPreset).toBe('pro-photo');
    expect(p.autopilot).toEqual({ enabled: false, postsPerWeek: { instagram: 5, tiktok: 3 }, leadDays: 3, requireApproval: true, imagesPerPost: 2, generateMedia: true, weeklyBudgetUsd: 5 });
    expect(p.languages).toEqual(['vi']);
    expect(listPersonaIds()).toEqual([p.id]);
  });

  it('requires a name and a clean handle', async () => {
    await expectStatus(() => createPersona({}), 400);
    await expectStatus(() => createPersona({ name: '   ' }), 400);
    const e = await expectStatus(() => createPersona({ name: 'X', handle: 'mia vn!' }), 400);
    expect(e.message).toContain('Handle');
  });

  it('rejects wrong types with a Vietnamese message', async () => {
    const e = await expectStatus(() => createPersona({ name: 'X', consistencyThreshold: 'cao' }), 400);
    expect(e.message).toContain('Ngưỡng');
  });

  it('keeps the threshold within 50–100', async () => {
    await expectStatus(() => createPersona({ name: 'X', consistencyThreshold: 40 }), 400);
    expect(createPersona({ name: 'X', consistencyThreshold: 95 }).consistencyThreshold).toBe(95);
  });

  it('keeps pillar shares at or under 100%', async () => {
    const e = await expectStatus(() => createPersona({ name: 'X', pillars: [{ name: 'A', share: 70 }, { name: 'B', share: 40 }] as never }), 400);
    expect(e.message).toContain('100%');
    const p = createPersona({ name: 'X', pillars: [{ name: 'Thời trang', share: 60 }, { name: 'Ẩm thực', share: 40 }] as never });
    expect(p.pillars.map((x) => x.share)).toEqual([60, 40]);
    expect(p.pillars.every((x) => x.id)).toBe(true);
  });

  it('needs a consent note for a licensed (real) person', async () => {
    const e = await expectStatus(() => createPersona({ name: 'X', identitySource: 'licensed' }), 400);
    expect(e.message).toContain('đồng ý');
    expect(createPersona({ name: 'X', identitySource: 'licensed', consentNote: 'Hợp đồng ký 01/10, lưu ở Drive/KOL' }).identitySource).toBe('licensed');
  });

  it('becomes active only with a disclosure and at least one anchor', async () => {
    const p = createPersona({ name: 'Mia' });
    const noAnchor = await expectStatus(() => updatePersona(p.id, { status: 'active' }), 400);
    expect(noAnchor.message).toContain('anchor');
    await addRefFromUpload(p.id, tempFile(PNG_1x1), { kind: 'anchor' });
    const noDisclosure = await expectStatus(() => updatePersona(p.id, { status: 'active', disclosureText: '  ' }), 400);
    expect(noDisclosure.message).toContain('công bố AI');
    expect(updatePersona(p.id, { status: 'active' }).status).toBe('active');
  });

  it('rejects unknown or wrong-kind models', async () => {
    const p = createPersona({ name: 'Mia' });
    await expectStatus(() => updatePersona(p.id, { imageModel: 'no-such-model' }), 400);
    await expectStatus(() => updatePersona(p.id, { imageModel: 'veo-3.1-fast-generate-preview' }), 400);
    expect(updatePersona(p.id, { imageModel: 'gemini-3-pro-image', videoModel: 'veo-3.1-fast-generate-preview' }).imageModel).toBe('gemini-3-pro-image');
  });

  it('merges nested appearance and autopilot on PATCH', () => {
    const p = createPersona({ name: 'Mia', appearance: { gender: 'female', eyes: 'brown' } as never });
    const u = updatePersona(p.id, { appearance: { eyes: 'dark brown' } as never, autopilot: { enabled: true } as never });
    expect(u.appearance.gender).toBe('female');
    expect(u.appearance.eyes).toBe('dark brown');
    expect(u.autopilot.enabled).toBe(true);
    expect(u.autopilot.leadDays).toBe(3);
  });

  it('archives on delete and keeps the row', async () => {
    const p = createPersona({ name: 'Mia' });
    archivePersona(p.id);
    expect(requirePersona(p.id).status).toBe('archived');
    await expectStatus(() => requirePersona('nope'), 404);
    expect(getPersona('nope')).toBeNull();
  });
});

describe('summaries', () => {
  it('lists counts, avatar, spend and the publish-side numbers', async () => {
    const p = createPersona({ name: 'Mia' });
    const ref = await addRefFromUpload(p.id, tempFile(PNG_1x1), { kind: 'anchor' });
    const db = kolDb();
    const now = nowSec();
    db.prepare(`INSERT INTO kol_accounts (id, persona_id, platform, connection_id, followers, created_at, updated_at) VALUES ('a1', ?, 'instagram', 'c1', 1200, ?, ?)`).run(p.id, now, now);
    db.prepare(`INSERT INTO kol_accounts (id, persona_id, platform, connection_id, followers, created_at, updated_at) VALUES ('a2', ?, 'tiktok', 'c2', 300, ?, ?)`).run(p.id, now, now);
    db.prepare(`INSERT INTO kol_posts (id, persona_id, status, created_at, updated_at) VALUES ('p1', ?, 'scheduled', ?, ?)`).run(p.id, now, now);
    db.prepare(`INSERT INTO kol_posts (id, persona_id, status, published_at, created_at, updated_at) VALUES ('p2', ?, 'published', ?, ?, ?)`).run(p.id, now - 86400, now, now);
    db.prepare(`INSERT INTO kol_posts (id, persona_id, status, published_at, created_at, updated_at) VALUES ('p3', ?, 'published', ?, ?, ?)`).run(p.id, now - 40 * 86400, now, now);
    db.prepare(`INSERT INTO kol_spend (persona_id, provider, model, kind, cost_usd, created_at) VALUES (?, 'gemini', 'm', 'image', 0.268, ?)`).run(p.id, now);
    const [s] = listPersonaSummaries();
    expect(s).toMatchObject({
      id: p.id, name: 'Mia', avatarUrl: ref.url, refCount: 1, assetCount: 0, followers: 1500, postsScheduled: 1, postsPublished30d: 1,
      spendMonthUsd: 0.268, avgConsistency: null, autopilot: false,
    });
    expect(s.platforms.sort()).toEqual(['instagram', 'tiktok']);
  });

  it('survives missing publish tables', () => {
    createPersona({ name: 'Mia' });
    kolDb().exec('DROP TABLE kol_accounts; DROP TABLE kol_posts;');
    const [s] = listPersonaSummaries();
    expect(s).toMatchObject({ platforms: [], followers: null, postsScheduled: 0, postsPublished30d: 0 });
  });
});

describe('identity pack', () => {
  it('stores an upload under the persona refs folder, sniffed, with dimensions; first anchor is primary', async () => {
    const p = createPersona({ name: 'Mia' });
    const a = await addRefFromUpload(p.id, tempFile(PNG_1x1, 'face.jpg'), { kind: 'anchor', label: 'Chính diện' });
    expect(a).toMatchObject({ kind: 'anchor', isPrimary: true, width: 1, height: 1, source: 'upload', label: 'Chính diện' });
    const file = getRefFile(a.id)!;
    expect(file.mime).toBe('image/png');
    expect(file.abs.startsWith(path.join(kolDir(), 'personas', p.id, 'refs'))).toBe(true);
    expect(file.abs.endsWith('.png')).toBe(true);
    const b = await addRefFromUpload(p.id, tempFile(PNG_1x1), { kind: 'anchor' });
    expect(b.isPrimary).toBe(false);
    const s = await addRefFromUpload(p.id, tempFile(PNG_1x1), { kind: 'sheet' });
    expect(s.isPrimary).toBe(false);
    expect(listRefs(p.id).map((r) => r.sort)).toEqual([0, 1, 2]);
  });

  it('rejects files that are not JPEG/PNG/WebP whatever their name', async () => {
    const p = createPersona({ name: 'Mia' });
    await expectStatus(addRefFromUpload(p.id, tempFile(Buffer.from('%PDF-1.7 not an image'), 'face.png'), { kind: 'anchor' }), 415);
    await expectStatus(addRefFromUpload(p.id, tempFile(Buffer.from('GIF89a......'), 'face.gif'), { kind: 'anchor' }), 415);
    await expectStatus(addRefFromUpload(p.id, tempFile(PNG_1x1), { kind: 'selfie' }), 400);
    await expectStatus(addRefFromUpload('nope', tempFile(PNG_1x1), { kind: 'anchor' }), 404);
  });

  it('keeps an oversized image when ffmpeg is unavailable (dimensions from the header)', async () => {
    const p = createPersona({ name: 'Mia' });
    const big = Buffer.from(PNG_1x1);
    big.writeUInt32BE(3000, 16);
    big.writeUInt32BE(4000, 20);
    const r = await addRefFromUpload(p.id, tempFile(big), { kind: 'angle' });
    expect(r).toMatchObject({ width: 3000, height: 4000 });
  });

  it('moves the primary flag, refuses it on non-anchors, and promotes the next anchor on delete', async () => {
    const p = createPersona({ name: 'Mia' });
    const a = await addRefFromUpload(p.id, tempFile(PNG_1x1), { kind: 'anchor' });
    const b = await addRefFromUpload(p.id, tempFile(PNG_1x1), { kind: 'anchor' });
    const s = await addRefFromUpload(p.id, tempFile(PNG_1x1), { kind: 'sheet' });
    expect(patchRef(b.id, { isPrimary: true }).isPrimary).toBe(true);
    expect(listRefs(p.id).filter((r) => r.isPrimary).map((r) => r.id)).toEqual([b.id]);
    await expectStatus(() => patchRef(s.id, { isPrimary: true }), 400);
    expect(patchRef(a.id, { sort: 9, label: 'Nghiêng' })).toMatchObject({ sort: 9, label: 'Nghiêng' });
    const file = getRefFile(b.id)!.abs;
    deleteRef(b.id);
    expect(fs.existsSync(file)).toBe(false);
    expect(listRefs(p.id).find((r) => r.id === a.id)?.isPrimary).toBe(true);
  });

  it('copies an image asset of the same persona into the pack', async () => {
    const p = createPersona({ name: 'Mia' });
    const other = createPersona({ name: 'Lan' });
    const rel = `assets/${p.id}/2026-10/as1.png`;
    fs.mkdirSync(path.dirname(resolveKolFile(rel)), { recursive: true });
    fs.writeFileSync(resolveKolFile(rel), PNG_1x1);
    const now = nowSec();
    kolDb().prepare(`INSERT INTO kol_assets (id, persona_id, kind, file, mime, created_at, updated_at) VALUES ('as1', ?, 'image', ?, 'image/png', ?, ?)`).run(p.id, rel, now, now);
    const r = await addRefFromAsset(p.id, 'as1', 'angle');
    expect(r).toMatchObject({ kind: 'angle', source: 'asset', assetId: 'as1' });
    expect(fs.existsSync(resolveKolFile(rel))).toBe(true);
    expect(getRefFile(r.id)!.abs).not.toBe(resolveKolFile(rel));
    await expectStatus(addRefFromAsset(other.id, 'as1', 'anchor'), 400);
    await expectStatus(addRefFromAsset(p.id, 'missing', 'anchor'), 404);
  });
});
