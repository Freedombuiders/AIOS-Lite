import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  process.env.VIDEO_EDIT_FFMPEG = '/nonexistent/ffmpeg-for-tests';
  return { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'kol-library-')) };
});
vi.mock('./config.js', async (orig) => ({ ...(await orig<typeof import('./config.js')>()), STORE_DIR: store.dir, GOOGLE_API_KEY: '' }));

import fs from 'fs';
import path from 'path';

import { _initTestDatabase } from './test-db.js';
import { KolError, kolDb } from './core.js';
import {
  createLibraryItem, deleteLibraryItem, getLibraryFile, getLibraryItem, listLibrary, patchLibraryItem, resolveCameraSetup, resolveLibraryItems,
  seedBuiltinLibrary, setLibraryImage,
} from './library.js';
import { BUILTIN_LIBRARY, RETIRED_BUILTINS, REVISED_BUILTINS } from './library-seed.js';
import { createPersona } from './personas.js';
import { createTemplate, deleteTemplate, getTemplateFile, listTemplates, patchTemplate } from './templates.js';
import type { LibraryKind } from './types.js';

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const tempPng = () => {
  const f = path.join(fs.mkdtempSync(path.join(store.dir, 'up-')), 'x.png');
  fs.writeFileSync(f, PNG_1x1);
  return f;
};

function status(fn: () => unknown): number {
  try { fn(); } catch (err) { expect(err).toBeInstanceOf(KolError); return (err as KolError).status; }
  return 200;
}

beforeEach(() => {
  _initTestDatabase();
});

afterAll(() => fs.rmSync(store.dir, { recursive: true, force: true }));

describe('builtin seed', () => {
  it('has the promised breadth per kind and about 250+ items', () => {
    const count = (k: LibraryKind) => BUILTIN_LIBRARY.filter((i) => i.kind === k).length;
    expect(count('expression')).toBeGreaterThanOrEqual(90);
    expect(count('hair')).toBeGreaterThanOrEqual(30);
    expect(count('outfit')).toBeGreaterThanOrEqual(40);
    expect(count('scene')).toBeGreaterThanOrEqual(40);
    expect(count('pose')).toBeGreaterThanOrEqual(20);
    expect(count('look')).toBeGreaterThanOrEqual(20);
    expect(count('effect')).toBeGreaterThanOrEqual(10);
    expect(count('camera')).toBeGreaterThanOrEqual(40);
    expect(BUILTIN_LIBRARY.length).toBeGreaterThanOrEqual(250);
  });

  it('uses unique stable ids, Vietnamese names and English prompt fragments', () => {
    const ids = BUILTIN_LIBRARY.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('b-expr-tongue-out');
    for (const i of BUILTIN_LIBRARY) {
      expect(i.id).toMatch(/^b-(expr|hair|outfit|scene|pose|look|effect|camera)-[a-z0-9-]+$/);
      expect(i.name.trim().length).toBeGreaterThan(1);
      expect(i.group.trim().length).toBeGreaterThan(1);
      expect(i.prompt.length).toBeGreaterThan(8);
      // English fragments: no Vietnamese tone marks except proper nouns like áo dài / nón lá / Thê Húc.
      expect(i.prompt.replace(/áo dài|áo bà ba|áo tứ thân|áo nhật bình|nón lá|yếm|Thê Húc|cách tân|phở|Tết/gi, '')).not.toMatch(/[ạảãậầấẩẫăắằặẳẵẹẻẽếềệểễịỉĩọỏõốồộổỗơớờợởỡụủũưứừựửữỵỷỹỳđ]/i);
    }
    const groups = new Set(BUILTIN_LIBRARY.filter((i) => i.kind === 'expression').map((i) => i.group));
    for (const g of ['Cử chỉ & phản ứng', 'Trung tính & suy nghĩ', 'Xã hội & giao tiếp', 'Cảm xúc mạnh', 'Selfie & camera']) expect(groups.has(g)).toBe(true);
  });

  it('includes Vietnamese settings and outfits, cinematic looks and phone cameras', () => {
    const names = BUILTIN_LIBRARY.map((i) => i.name).join(' | ');
    for (const n of ['Áo dài', 'Phố cổ Hà Nội', 'Rooftop Sài Gòn', 'Đà Lạt', 'Kodak Portra 400', 'Fuji Pro 400H', 'Wong Kar-wai', 'Autochrome', 'Flash editorial', 'Selfie camera trước', 'Chân dung 85mm', 'Street 35mm', 'Selfie gương']) {
      expect(names).toContain(n);
    }
  });

  it('seeds once, is idempotent, and never overwrites the owner’s edits', () => {
    const first = listLibrary();
    expect(first.length).toBe(BUILTIN_LIBRARY.length);
    expect(seedBuiltinLibrary()).toBe(0);
    patchLibraryItem('b-expr-wink', { prompt: 'a cheeky wink' });
    kolDb().prepare("DELETE FROM kol_library WHERE id = 'b-expr-tongue-out'").run();
    expect(seedBuiltinLibrary()).toBe(1);
    expect(getLibraryItem('b-expr-wink')?.prompt).toBe('a cheeky wink');
    expect(getLibraryItem('b-expr-tongue-out')?.builtin).toBe(true);
  });

  it('keeps camera fragments on one axis each, grouped by axis', () => {
    const cams = BUILTIN_LIBRARY.filter((i) => i.kind === 'camera');
    expect(new Set(cams.map((i) => i.group))).toEqual(new Set(['Điện thoại', 'Máy ảnh & ống kính', 'Cỡ cảnh', 'Góc máy', 'Chuyển động máy (video)']));
    for (const i of cams) expect(i.tags.includes('video')).toBe(i.group === 'Chuyển động máy (video)');
    // A lens or device fragment must not also set the framing or the angle.
    for (const i of cams.filter((c) => c.group === 'Điện thoại' || c.group === 'Máy ảnh & ống kính')) {
      if (i.id === 'b-camera-macro-face') continue;
      expect(i.prompt).not.toMatch(/\b(low|high)[ -]angle|eye[ -]level|medium shot|full[ -]body/i);
    }
  });

  it('moves untouched revised builtins to the new text, keeps edited ones, retires old ones and restores seed order', () => {
    const rev = (id: string) => REVISED_BUILTINS.find((r) => r.id === id)!;
    const setOld = (id: string) => {
      const r = rev(id);
      kolDb().prepare('UPDATE kol_library SET grp = ?, name = ?, prompt = ? WHERE id = ?').run(r.group, r.name, r.prompt, id);
    };
    listLibrary();
    setOld('b-camera-phone-ultrawide');
    setOld('b-camera-50mm');
    kolDb().prepare("UPDATE kol_library SET name = 'Ống 50 của tôi' WHERE id = 'b-camera-50mm'").run();
    const retired = RETIRED_BUILTINS[0];
    kolDb().prepare(`INSERT INTO kol_library (id, persona_id, kind, grp, name, prompt, file, tags_json, builtin, sort, created_at, updated_at)
      VALUES (?, NULL, 'camera', ?, ?, ?, NULL, '[]', 1, 99, 0, 0)`).run(retired.id, retired.group, retired.name, retired.prompt);
    kolDb().prepare("UPDATE kol_library SET sort = 500 WHERE id = 'b-camera-static'").run();

    expect(seedBuiltinLibrary()).toBe(0);
    const wide = getLibraryItem('b-camera-phone-ultrawide')!;
    expect(wide.name).toBe('Siêu rộng 0.5x');
    expect(wide.prompt).not.toContain('low angle');
    expect(getLibraryItem('b-camera-50mm')?.name).toBe('Ống 50 của tôi');
    expect(getLibraryItem(retired.id)).toBeNull();
    const cams = listLibrary({ kind: 'camera' });
    expect(cams.map((c) => c.id)).toEqual(BUILTIN_LIBRARY.filter((i) => i.kind === 'camera').map((i) => i.id));

    // An edited retired builtin is handed to the owner instead of deleted.
    kolDb().prepare(`INSERT INTO kol_library (id, persona_id, kind, grp, name, prompt, file, tags_json, builtin, sort, created_at, updated_at)
      VALUES (?, NULL, 'camera', ?, 'Khung dọc của tôi', ?, NULL, '[]', 1, 99, 0, 0)`).run(retired.id, retired.group, retired.prompt);
    seedBuiltinLibrary();
    expect(getLibraryItem(retired.id)).toMatchObject({ builtin: false, name: 'Khung dọc của tôi' });
    deleteLibraryItem(retired.id);
  });
});

describe('library CRUD', () => {
  it('filters by kind and shows a persona its own items plus the global ones', () => {
    const mia = createPersona({ name: 'Mia' });
    const lan = createPersona({ name: 'Lan' });
    const mine = createLibraryItem({ kind: 'outfit', group: 'Của Mia', name: 'Đầm xanh', prompt: 'a teal silk slip dress', personaId: mia.id });
    const global = createLibraryItem({ kind: 'outfit', group: '', name: 'Áo khoác', prompt: 'a cropped tweed jacket' });
    expect(global.group).toBe('Của tôi');
    const forMia = listLibrary({ kind: 'outfit', personaId: mia.id }).map((i) => i.id);
    expect(forMia).toContain(mine.id);
    expect(forMia).toContain(global.id);
    expect(listLibrary({ kind: 'outfit', personaId: lan.id }).map((i) => i.id)).not.toContain(mine.id);
    expect(listLibrary({ kind: 'outfit' }).every((i) => i.kind === 'outfit' && i.personaId === null)).toBe(true);
    expect(status(() => listLibrary({ kind: 'shoes' }))).toBe(400);
  });

  it('validates input in Vietnamese', () => {
    expect(status(() => createLibraryItem({ kind: 'outfit', group: '', name: '', prompt: 'x' }))).toBe(400);
    expect(status(() => createLibraryItem({ kind: 'hat', group: '', name: 'Nón', prompt: 'x' }))).toBe(400);
    expect(status(() => createLibraryItem({ kind: 'outfit', group: '', name: 'X', prompt: 'x', personaId: 'missing' }))).toBe(404);
  });

  it('lets builtins be edited but not deleted or re-kinded; owner items can be deleted', () => {
    expect(patchLibraryItem('b-outfit-ao-dai-white', { name: 'Áo dài trắng (sửa)' }).name).toBe('Áo dài trắng (sửa)');
    expect(status(() => patchLibraryItem('b-outfit-ao-dai-white', { kind: 'scene' }))).toBe(400);
    expect(status(() => deleteLibraryItem('b-outfit-ao-dai-white'))).toBe(409);
    const own = createLibraryItem({ kind: 'pose', group: 'Của tôi', name: 'Ngồi xe máy', prompt: 'sitting sideways on a parked scooter' });
    deleteLibraryItem(own.id);
    expect(getLibraryItem(own.id)).toBeNull();
    expect(status(() => deleteLibraryItem(own.id))).toBe(404);
  });

  it('stores a reference image for an item and replaces the old file', async () => {
    const item = await setLibraryImage('b-outfit-ao-dai-white', tempPng());
    expect(item.imageUrl).toBe('/api/kol/media/library/b-outfit-ao-dai-white');
    const first = getLibraryFile(item.id)!.abs;
    await setLibraryImage(item.id, tempPng());
    const second = getLibraryFile(item.id)!.abs;
    expect(second).not.toBe(first);
    expect(fs.existsSync(first)).toBe(false);
  });

  it('resolves selection ids by kind and refuses another persona’s items', () => {
    const mia = createPersona({ name: 'Mia' });
    const lan = createPersona({ name: 'Lan' });
    const lanOnly = createLibraryItem({ kind: 'hair', group: '', name: 'Tóc Lan', prompt: 'pixie', personaId: lan.id });
    const r = resolveLibraryItems({ outfit: 'b-outfit-ao-dai-white', expression: 'b-expr-wink' }, mia.id);
    expect(r.outfit?.name).toBe('Áo dài trắng nữ sinh');
    expect(r.expression?.kind).toBe('expression');
    expect(status(() => resolveLibraryItems({ outfit: 'b-expr-wink' }, mia.id))).toBe(400);
    expect(status(() => resolveLibraryItems({ hair: lanOnly.id }, mia.id))).toBe(400);
    expect(status(() => resolveLibraryItems({ scene: 'missing' }, mia.id))).toBe(404);
  });

  it('joins a camera setup of several items into one slot, in the order given', () => {
    const mia = createPersona({ name: 'Mia' });
    expect(resolveCameraSetup([], mia.id)).toBeNull();
    expect(resolveCameraSetup([undefined, 'b-camera-low-angle'], mia.id)?.id).toBe('b-camera-low-angle');
    const setup = resolveCameraSetup(['b-camera-85mm-portrait', 'b-camera-shot-mcu', 'b-camera-low-angle', 'b-camera-shot-mcu'], mia.id)!;
    expect(setup.kind).toBe('camera');
    expect(setup.name).toBe('Chân dung 85mm f/1.4 · Cận trung · Góc thấp');
    expect(setup.prompt).toBe(
      '85mm f/1.4 portrait lens: shallow depth of field, creamy background separation, flattering facial proportions; '
      + 'medium close-up framing from the chest up, head and shoulders in frame; low-angle shot looking up at the subject, empowering perspective',
    );
    expect(status(() => resolveCameraSetup(['b-camera-50mm', 'b-outfit-ao-dai-white'], mia.id))).toBe(400);
    expect(status(() => resolveCameraSetup(['b-camera-50mm', 'missing'], mia.id))).toBe(404);
    const six = ['b-camera-50mm', 'b-camera-shot-cu', 'b-camera-eye-level', 'b-camera-static', 'b-camera-orbit', 'b-camera-pan'];
    expect(status(() => resolveCameraSetup(six, mia.id))).toBe(400);
  });
});

describe('templates', () => {
  it('stores singles and carousel sets in order, patches and deletes', async () => {
    const single = await createTemplate(tempPng(), { name: 'Cà phê sáng', notes: 'ánh sáng cửa sổ' });
    expect(single).toMatchObject({ kind: 'single', setId: null, position: 0, width: 1, height: 1, source: 'upload', name: 'Cà phê sáng' });
    const c1 = await createTemplate(tempPng(), { kind: 'carousel' }, 'slide-a.png');
    expect(c1.setId).toBeTruthy();
    expect(c1.name).toBe('slide-a');
    const c2 = await createTemplate(tempPng(), { kind: 'carousel', setId: c1.setId! });
    expect(c2).toMatchObject({ setId: c1.setId, position: 1 });
    const list = listTemplates();
    const setIdx = list.filter((t) => t.setId === c1.setId).map((t) => t.position);
    expect(setIdx).toEqual([0, 1]);
    expect(patchTemplate(single.id, { name: 'Mới', tags: ['cafe'] })).toMatchObject({ name: 'Mới', tags: ['cafe'] });
    const abs = getTemplateFile(single.id)!.abs;
    deleteTemplate(single.id);
    expect(fs.existsSync(abs)).toBe(false);
    await expect(createTemplate(tempPng(), { kind: 'gallery' })).rejects.toMatchObject({ status: 400 });
  });
});
