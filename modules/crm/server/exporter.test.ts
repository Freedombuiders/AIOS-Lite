import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainFolder } from '../../../src/core/types.js';
import type { ModuleManager } from '../../../src/modules/contracts.js';
import { createModuleManager } from '../../../src/modules/manager.js';
import { createTestHarness, type TestHarness } from '../../../src/modules/test-deps.js';
import { parseFrontmatter, splitFrontmatter } from '../../../src/shared/frontmatter.js';
import { readBlock } from '../../../src/shared/note-blocks.js';
import type { CareCustomersApi } from '../../care/server/customers-service.js';
import { loadCareKey } from '../../care/server/module-runtime.js';
import { createCareStores, type CareStores } from '../../care/server/persistence/index.js';
import { BATCH_SIZE, createExporter, type ExporterDeps } from './exporter.js';
import { BLOCK_LOG, BLOCK_NEED } from './note.js';

const MODULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let h: TestHarness;
let mgr: ModuleManager;
let care: CareCustomersApi;
let stores: CareStores;
let dirs: Record<string, string>;
let folder: string | undefined;
let attention: Map<string, { title: string; detail?: string }>;
let raised: string[];
let changedEvents: Array<{ folderId: string; paths: string[] }>;

beforeEach(async () => {
  h = createTestHarness({ modulesDir: MODULES_DIR });
  dirs = { 'cty-a': path.join(h.root, 'brain', 'cty-a'), 'cty-b': path.join(h.root, 'brain', 'cty-b') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  (h.deps.brain as { folders: () => BrainFolder[] }).folders = () => Object.entries(dirs).map(([id, p]) => ({ id, name: id, path: p }));
  mgr = createModuleManager(h.deps, { fromDist: false });
  (h.deps as { modules: ModuleManager }).modules = mgr;
  await mgr.add('care');
  await mgr.add('crm');
  care = mgr.provides<{ customers: CareCustomersApi }>('care')!.customers;
  const key = loadCareKey({
    dataDir: path.join(h.deps.config.dataDir, 'modules', 'care'),
    crypto: { encrypt: (p) => h.deps.cipher.encrypt(p), decrypt: (v) => h.deps.cipher.decrypt(v) },
  });
  stores = createCareStores(h.deps.db, key);
  folder = 'cty-a';
  attention = new Map();
  raised = [];
  changedEvents = [];
  h.deps.bus.on('custom', (e) => {
    if (e.name === 'brain:changed') changedEvents.push(e.payload as { folderId: string; paths: string[] });
  });
});
afterEach(async () => {
  await mgr.stop();
  h.cleanup();
});

function exporter(extra: Partial<ExporterDeps> = {}) {
  return createExporter({
    db: h.deps.db,
    notes: h.deps.notes.forModule('crm'),
    care: () => care,
    folderId: () => folder,
    attention: {
      raise: (i) => {
        raised.push(i.key);
        attention.set(i.key, i);
      },
      resolve: (k) => void attention.delete(k),
    },
    log: { warn() {}, info() {} },
    ...extra,
  });
}

const file = (rel: string, f = 'cty-a') => path.join(dirs[f]!, ...rel.split('/'));
const read = (rel: string, f = 'cty-a') => fs.readFileSync(file(rel, f), 'utf8');
const notesIn = (f = 'cty-a') => {
  const d = path.join(dirs[f]!, 'khach-hang');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.md')).sort() : [];
};
/** the file with the content of both managed blocks and the frontmatter cut out: what belongs to the person */
const humanPart = (text: string) => {
  let body = splitFrontmatter(text).body;
  for (const b of [BLOCK_NEED, BLOCK_LOG]) body = body.replace(readBlock(text, b) ?? '', '');
  return body;
};
const DAY = 86_400_000;
const due = Date.UTC(2026, 10, 28, 3, 0, 0); // 28/11/2026 10:00 in Vietnam

describe('crm: one-way export of care customers to notes', () => {
  it('a new customer gets a note with the right frontmatter and both managed blocks', async () => {
    const c = stores.customers.createCustomer({ displayName: 'Chị Lan', phone: '0901234567', tags: 'hỏi sỉ, Ô long sen' });
    stores.profiles.saveProfile(c.id, { need: { service: 'Trà sen', budget: '2tr' } }, null);
    stores.tasks.createTask({ customerId: c.id, title: 'Gửi báo giá', dueAtMs: due });
    stores.tasks.createTask({ customerId: c.id, title: 'Hỏi lại', dueAtMs: due + 3 * DAY });

    const r = await exporter().run();
    expect(r.written).toBe(1);
    expect(notesIn()).toEqual(['chi-lan.md']);
    const text = read('khach-hang/chi-lan.md');
    const { data } = parseFrontmatter(text);
    expect(data).toMatchObject({
      loai: 'khach-hang',
      id: c.id,
      ten: 'Chị Lan',
      sdt: '0901234567', // a string, not the number 901234567
      giai_doan: 'moi',
      the: ['hoi-si', 'o-long-sen'],
      viec_tiep: 'Gửi báo giá',
      han: '2026-11-28',
    });
    expect(String(data.cap_nhat)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/);
    // fields care does not hold are absent, never empty placeholders
    for (const k of ['nguon', 'gia_tri', 'da_mua', 'hang', 'zalo']) expect(data).not.toHaveProperty(k);
    expect(readBlock(text, BLOCK_NEED)).toContain('- Dịch vụ: Trà sen');
    expect(readBlock(text, BLOCK_NEED)).toContain('- Ngân sách: 2tr');
    const log = readBlock(text, BLOCK_LOG)!;
    expect(log).toContain('Tạo khách');
    expect(log).toContain('Thêm việc: Gửi báo giá');
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('# Chị Lan\n');
    expect(exporter().indexRow(c.id)).toMatchObject({ folder_id: 'cty-a', rel_path: 'khach-hang/chi-lan.md' });
    expect(exporter().indexRow(c.id)!.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a stage change updates the note; the person\'s text and frontmatter keys survive byte for byte', async () => {
    const c = stores.customers.createCustomer({ displayName: 'Anh Nam', phone: '0912' });
    const ex = exporter();
    await ex.run();
    const rel = 'khach-hang/anh-nam.md';
    // the owner edits in Obsidian: own keys, text before, between and after the blocks, CRLF-free odd spacing
    let text = read(rel);
    text = text.replace('loai: khach-hang\n', 'loai: khach-hang\nnguon: Bài đăng "Trà sen Tây Hồ"  # chủ ghi\nso_thich: [tra-xanh]\n');
    text = text.replace('# Anh Nam\n', '# Anh Nam\n\nKhách quen của chị Hà.   \n\n');
    text = text.replace('<!-- aios:end khach-can-gi -->\n', '<!-- aios:end khach-can-gi -->\n\n> Đừng gọi sau 9 giờ tối!\n');
    text += '\n## Ghi chú riêng\n\n- [ ] gửi quà Tết\n\t- tab giữ nguyên\n';
    fs.writeFileSync(file(rel), text);
    const before = humanPart(text);

    const updated = stores.customers.updateCustomer(c.id, { stage: 'quoted' }, c.revision);
    await ex.run();
    const after = read(rel);
    const { data } = parseFrontmatter(after);
    expect(data).toMatchObject({ giai_doan: 'da-bao-gia', nguon: 'Bài đăng "Trà sen Tây Hồ"', so_thich: ['tra-xanh'] });
    // the person's keys keep their values, order and comment (the shared YAML writer may normalise spacing inside the block)
    expect(after).toMatch(/\nloai: khach-hang\nnguon: Bài đăng "Trà sen Tây Hồ" +# chủ ghi\nso_thich:/);
    expect(humanPart(after)).toBe(before);
    expect(readBlock(after, BLOCK_LOG)).toContain('Đổi giai đoạn: Mới → Đã báo giá');

    // the person changed a machine-owned key by hand: overwritten on the next export of that customer, nothing raised
    fs.writeFileSync(file(rel), after.replace('giai_doan: da-bao-gia', 'giai_doan: da-chot'));
    stores.customers.updateCustomer(c.id, { phone: '0999' }, updated.revision);
    await ex.run();
    expect(parseFrontmatter(read(rel)).data).toMatchObject({ giai_doan: 'da-bao-gia', sdt: '0999', nguon: 'Bài đăng "Trà sen Tây Hồ"' });
    expect(raised).toEqual([]);
  });

  it('running the exporter twice writes once, also when the whole feed is replayed', async () => {
    const c = stores.customers.createCustomer({ displayName: 'Chị Mai', tags: 'vip' });
    stores.tasks.createTask({ customerId: c.id, title: 'Gọi lại', dueAtMs: due });
    const ex = exporter();
    expect((await ex.run()).written).toBe(1);
    const st = fs.statSync(file('khach-hang/chi-mai.md'));
    const text = read('khach-hang/chi-mai.md');
    const events = changedEvents.length;

    expect(await ex.run()).toEqual({ written: 0, seen: 0 });
    // replay every change from the start and redo the full export: still nothing written
    h.deps.db.prepare('UPDATE crm_sync_state SET feed_cursor = 0, bootstrap_done = 0, bootstrap_after = NULL').run();
    const again = await exporter().run();
    expect(again.written).toBe(0);
    expect(again.seen).toBeGreaterThan(0);
    // a no-op write in care: no feed row, nothing to do
    stores.customers.updateCustomer(c.id, { displayName: 'Chị Mai', tags: 'vip' }, c.revision);
    expect(await exporter().run()).toEqual({ written: 0, seen: 0 });

    expect(read('khach-hang/chi-mai.md')).toBe(text);
    expect(fs.statSync(file('khach-hang/chi-mai.md')).mtimeMs).toBe(st.mtimeMs);
    expect(changedEvents.length).toBe(events);
  });

  it('a crash between writing the note and saving the cursor does not create a second note', async () => {
    stores.customers.createCustomer({ displayName: 'Chị Lan' });
    await exporter().run(); // bootstrap done, cursor at the end
    const c2 = stores.customers.createCustomer({ displayName: 'Cô Hoa' });
    const crashing = exporter({
      afterNoteWrite: () => {
        throw new Error('máy tắt đột ngột');
      },
    });
    await expect(crashing.run()).rejects.toThrow('máy tắt đột ngột');
    expect(notesIn()).toEqual(['chi-lan.md', 'co-hoa.md']); // the note was written…
    expect(crashing.indexRow(c2.id)).toBeUndefined(); // …but neither its index row nor the cursor were saved
    const cursorBefore = (h.deps.db.prepare('SELECT feed_cursor FROM crm_sync_state').get() as { feed_cursor: number }).feed_cursor;
    expect(cursorBefore).toBeLessThan(care.latestCursor());

    // restart
    const r = await exporter().run();
    expect(notesIn()).toEqual(['chi-lan.md', 'co-hoa.md']);
    expect(r.written).toBe(0);
    expect(exporter().indexRow(c2.id)).toMatchObject({ rel_path: 'khach-hang/co-hoa.md' });
    expect((h.deps.db.prepare('SELECT feed_cursor FROM crm_sync_state').get() as { feed_cursor: number }).feed_cursor).toBe(care.latestCursor());
  });

  it('two folders can hold the same rel_path', async () => {
    const lan = stores.customers.createCustomer({ displayName: 'Lan' });
    await exporter().run();
    folder = 'cty-b';
    await exporter().run(); // first run for cty-b: its own full export
    expect(notesIn('cty-a')).toEqual(['lan.md']);
    expect(notesIn('cty-b')).toEqual(['lan.md']); // not lan-2.md: the path is free in this folder
    expect(exporter().indexRow(lan.id)).toMatchObject({ folder_id: 'cty-b', rel_path: 'khach-hang/lan.md' });

    const ins = h.deps.db.prepare('INSERT INTO crm_note_index (customer_id, folder_id, rel_path, exported_at) VALUES (?, ?, ?, 0)');
    ins.run('x1', 'cty-a', 'khach-hang/lan.md');
    expect(() => ins.run('x2', 'cty-a', 'khach-hang/lan.md')).toThrow(/UNIQUE/);
  });

  it('same names get -2, -3; renaming a customer does not rename the file', async () => {
    const a = stores.customers.createCustomer({ displayName: 'Chị Lan' });
    stores.customers.createCustomer({ displayName: 'Chi Lan' });
    stores.customers.createCustomer({ displayName: 'chị lan' });
    await exporter().run();
    expect(notesIn()).toEqual(['chi-lan-2.md', 'chi-lan-3.md', 'chi-lan.md']);
    const rel = exporter().indexRow(a.id)!.rel_path;
    stores.customers.updateCustomer(a.id, { displayName: 'Chị Lan Anh' }, a.revision);
    await exporter().run();
    expect(exporter().indexRow(a.id)!.rel_path).toBe(rel);
    expect(parseFrontmatter(read(rel)).data.ten).toBe('Chị Lan Anh');
    expect(notesIn()).toHaveLength(3);
  });

  it('a note the person deleted is recreated on the next change of that customer, with one attention item', async () => {
    const c = stores.customers.createCustomer({ displayName: 'Bà Tư' });
    const other = stores.customers.createCustomer({ displayName: 'Ông Ba' });
    const ex = exporter();
    await ex.run();
    fs.rmSync(file('khach-hang/ba-tu.md'));

    stores.customers.updateCustomer(other.id, { stage: 'consulting' }, other.revision);
    await ex.run();
    expect(fs.existsSync(file('khach-hang/ba-tu.md'))).toBe(false); // no change of Bà Tư: not recreated yet
    expect(care.get(c.id)).not.toBeNull(); // the customer is still there

    stores.customers.updateCustomer(c.id, { stage: 'won' }, c.revision);
    await ex.run();
    expect(parseFrontmatter(read('khach-hang/ba-tu.md')).data).toMatchObject({ id: c.id, giai_doan: 'da-chot' });
    expect(raised.filter((k) => k.startsWith('note-recreated:'))).toEqual([`note-recreated:${c.id}`]);
    expect(notesIn()).toEqual(['ba-tu.md', 'ong-ba.md']);
  });

  it('a note the person moved is followed (found by its id), not duplicated', async () => {
    const c = stores.customers.createCustomer({ displayName: 'Chú Sáu' });
    await exporter().run();
    fs.mkdirSync(file('khach-hang/si'), { recursive: true });
    fs.renameSync(file('khach-hang/chu-sau.md'), file('khach-hang/si/chu-sau.md'));
    stores.customers.updateCustomer(c.id, { stage: 'deposit' }, c.revision);
    await exporter().run();
    expect(notesIn()).toEqual([]);
    expect(parseFrontmatter(read('khach-hang/si/chu-sau.md')).data.giai_doan).toBe('dat-coc');
    expect(exporter().indexRow(c.id)!.rel_path).toBe('khach-hang/si/chu-sau.md');
    expect(raised).toEqual([]);
  });

  it('a customer deleted in care loses its note and its index row', async () => {
    const c = stores.customers.createCustomer({ displayName: 'Khách Xoá' });
    stores.tasks.createTask({ customerId: c.id, title: 'x', dueAtMs: due });
    stores.customers.createCustomer({ displayName: 'Khách Ở Lại' });
    await exporter().run();
    expect(notesIn()).toEqual(['khach-o-lai.md', 'khach-xoa.md']);
    // care has no delete path yet: a raw delete stands in for it (the feed trigger covers any DELETE)
    h.deps.db.prepare('DELETE FROM care_tasks WHERE customer_id = ?').run(c.id);
    h.deps.db.prepare('DELETE FROM care_customers WHERE id = ?').run(c.id);
    await exporter().run();
    expect(notesIn()).toEqual(['khach-o-lai.md']);
    expect(exporter().indexRow(c.id)).toBeUndefined();
  });

  it('first run exports more than 500 existing customers in batches, one commit per batch', async () => {
    const n = 620;
    h.deps.db.transaction(() => {
      for (let i = 0; i < n; i++) stores.customers.createCustomer({ displayName: `Khách số ${i}`, phone: `09${String(i).padStart(8, '0')}` });
    })();
    const r = await exporter().run();
    expect(r.written).toBe(n);
    expect(notesIn()).toHaveLength(n);
    expect((h.deps.db.prepare('SELECT COUNT(*) AS n FROM crm_note_index').get() as { n: number }).n).toBe(n);
    // notes.batch: one brain:changed (and one git commit) per batch
    expect(changedEvents).toHaveLength(Math.ceil(n / BATCH_SIZE));
    expect(exporter().status()).toMatchObject({ state: 'san-sang', bootstrapDone: true, exported: n });
  });

  it('does nothing while no folder is chosen, and says so', async () => {
    folder = undefined;
    stores.customers.createCustomer({ displayName: 'Chị Lan' });
    expect(await exporter().run()).toEqual({ written: 0, seen: 0 });
    expect(exporter().status()).toMatchObject({ state: 'chua-cau-hinh' });
    expect(notesIn()).toEqual([]);
  });

  it('a note whose YAML the person broke is skipped with an attention item, the others go on', async () => {
    const a = stores.customers.createCustomer({ displayName: 'Hỏng' });
    const b = stores.customers.createCustomer({ displayName: 'Lành' });
    await exporter().run();
    fs.writeFileSync(file('khach-hang/hong.md'), '---\nten: [chưa đóng\n---\nchữ của chủ\n');
    stores.customers.updateCustomer(a.id, { stage: 'lost' }, a.revision);
    stores.customers.updateCustomer(b.id, { stage: 'won' }, b.revision);
    await exporter().run();
    expect(read('khach-hang/hong.md')).toBe('---\nten: [chưa đóng\n---\nchữ của chủ\n');
    expect(parseFrontmatter(read('khach-hang/lanh.md')).data.giai_doan).toBe('da-chot');
    expect([...attention.keys()]).toEqual([`note-error:${a.id}`]);
  });
});

describe('crm module wiring', () => {
  it('declares its tables, needs care, and serves a read-only status and customer list', async () => {
    expect(mgr.get('crm')!.manifest).toMatchObject({ category: 'sales', requires: { modules: ['care'] }, tables: ['crm_note_index', 'crm_sync_state'] });
    const app = new Hono();
    mgr.mount(app);
    const unset = await (await app.request('/api/m/crm/status')).json();
    expect(unset).toMatchObject({ state: 'chua-cau-hinh' });

    const c = stores.customers.createCustomer({ displayName: 'Chị Lan' });
    mgr.updateSettings('crm', { folderId: 'cty-b' });
    await vi.waitFor(() => expect(notesIn('cty-b')).toEqual(['chi-lan.md']), { timeout: 8000, interval: 100 });
    const list = await (await app.request('/api/m/crm/customers')).json();
    expect(list.items).toEqual([expect.objectContaining({ id: c.id, ten: 'Chị Lan', folderId: 'cty-b', notePath: 'khach-hang/chi-lan.md' })]);
    expect((await app.request('/api/m/crm/customers', { method: 'POST' })).status).toBe(404);
  }, 15_000);
});
