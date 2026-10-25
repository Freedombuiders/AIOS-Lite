import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VIDEO_STYLES } from '../catalog/styles.js';
import { CURATED_FONTS } from '../library/fonts-data.js';
import {
  componentHtml, createTemplateRegistry, getTemplate, listTemplates, loadTemplateDir, templateDir, templateForPrompt,
  TemplateError, type TemplateRegistry,
} from './registry.js';

const BUILTIN = path.resolve('modules/video/templates');
const TH_VANG = path.join(BUILTIN, 'th-vang');

let userDir: string;
let reg: TemplateRegistry;

/** Copy th-vang into the owner folder under another id, then let `edit` change its manifest. */
function addPack(id: string, edit: (m: Record<string, any>) => void = () => {}, folder = id): string {
  const dir = path.join(userDir, folder);
  fs.cpSync(TH_VANG, dir, { recursive: true });
  const file = path.join(dir, 'template.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.id = id;
  edit(manifest);
  fs.writeFileSync(file, JSON.stringify(manifest));
  return dir;
}

beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-templates-'));
  reg = createTemplateRegistry({ builtinDir: () => BUILTIN, userDir: () => userDir });
});
afterEach(() => fs.rmSync(userDir, { recursive: true, force: true }));

describe('template registry', () => {
  it('lists the built-in th-vang pack and the 21 legacy styles: 22 templates', () => {
    const list = reg.list();
    expect(list).toHaveLength(22);
    expect(new Set(list.map((t) => t.id)).size).toBe(22);
    expect(list[0]).toMatchObject({ id: 'th-vang', name: 'Talking head vàng', installed: true, legacy: false, tier: 'free' });
    const legacy = list.filter((t) => t.legacy);
    expect(legacy.map((t) => t.id).sort()).toEqual(VIDEO_STYLES.map((s) => `style:${s.id}`).sort());
    expect(legacy.every((t) => !t.installed)).toBe(true);
    expect(reg.problems()).toEqual([]);
    // The default registry reads the same built-in folder.
    expect(listTemplates().filter((t) => !t.legacy).map((t) => t.id)).toContain('th-vang');
  });

  it('gives every card a sample to draw when there is no poster', () => {
    const th = reg.list().find((t) => t.id === 'th-vang')!;
    expect(th.posterUrl).toBeUndefined();
    expect(th.sample).toMatchObject({ title: 'Talking head vàng', font: 'Anton', color: '#FFD23F', tone: '#2D2A26' });
    const sp = reg.list().find((t) => t.id === 'style:sanpham')!;
    expect(sp.sample).toEqual({ kicker: 'ƯU ĐÃI', title: 'CHỐT ĐƠN NGAY', font: 'Anton', color: '#E11D48', tone: '#FFF1F2' });
    expect(sp.tags).toEqual(['Bán hàng']);
    expect(reg.list().find((t) => t.id === 'style:bds')!.tags).toContain('Bất động sản');
  });

  it('reads the full th-vang manifest: five components, five presets, fonts from the module font library', () => {
    const m = getTemplate('th-vang')!;
    expect(Object.keys(m.components).sort()).toEqual(['broll-frame', 'logo-end', 'scene-before-after', 'scene-steps', 'text-beat']);
    expect(m.animations.map((a) => a.id)).toEqual(['typewriter', 'slide-short', 'slide-up', 'pop', 'fade']);
    expect(m.components['text-beat'].animations).toBeUndefined();
    const library = new Set(CURATED_FONTS.map((f) => f.family));
    for (const family of Object.values(m.tokens.fonts)) expect(library.has(family)).toBe(true);
    expect(m.captions).toMatchObject({ fill: '#FFFFFF', stroke: { color: '#000000' }, highlight: { color: '#FFD23F', mode: 'color' } });
    expect(templateDir('th-vang')).toBe(TH_VANG);
    expect(loadTemplateDir(TH_VANG).id).toBe('th-vang');
  });

  it('wraps every VideoStyle as a legacy template that keeps its look', () => {
    const m = reg.get('style:kienthuc')!;
    expect(m).toMatchObject({ legacy: true, styleId: 'kienthuc', components: {}, animations: [], sounds: { density: 'low' } });
    expect(m.tokens.colors).toEqual({ bg: '#0F172A', text: '#F8FAFC', accent: '#FACC15' });
    expect(m.captions.highlight.mode).toBe('box');
    expect(reg.get('style:quyen')!.captions.stroke).toEqual({ color: '#000000', width: 3 });
    expect(reg.get('style:thoitrang')!.captions).toMatchObject({ maxWordsPerChunk: 1, highlight: { mode: 'pop' } });
    expect(reg.dir('style:kienthuc')).toBeNull();
    expect(reg.get('style:nope')).toBeNull();
  });

  it('loads a valid owner pack (not installed until installed) and serves its poster url', () => {
    const dir = addPack('cua-toi', (m) => { m.poster = 'poster.webp'; m.tier = 'pro'; });
    fs.writeFileSync(path.join(dir, 'poster.webp'), 'webp');
    const t = reg.list().find((x) => x.id === 'cua-toi')!;
    expect(t).toMatchObject({ installed: false, legacy: false, tier: 'pro', posterUrl: '/api/m/video/edit/templates/cua-toi/files/poster.webp' });
    expect(reg.list()).toHaveLength(23);
  });

  it('rejects broken manifests with a clear reason and leaves them out of the list', () => {
    fs.mkdirSync(path.join(userDir, 'json-hong'));
    fs.writeFileSync(path.join(userDir, 'json-hong', 'template.json'), '{ "id": ');
    fs.mkdirSync(path.join(userDir, 'thieu-manifest'));
    addPack('sai-thoi-luong', (m) => { m.components['text-beat'].duration = { min: 3, max: 4, default: 1 }; });
    addPack('thieu-token', (m) => { delete m.tokens; });
    addPack('khac-id', () => {}, 'ten-thu-muc');
    addPack('preset-la', (m) => { m.components['scene-steps'].animations = ['bay-vao']; });
    addPack('thieu-block', (m) => { m.components['text-beat'].file = 'components/khong-co.html'; });
    addPack('duong-dan-ra-ngoai', (m) => { m.rules = '../../etc/passwd'; });
    addPack('th-vang');

    const problems = Object.fromEntries(reg.problems().map((p) => [p.id, p.error]));
    expect(problems['json-hong']).toBe('Mẫu "json-hong": template.json không phải JSON hợp lệ.');
    expect(problems['thieu-manifest']).toBe('Mẫu "thieu-manifest": thiếu template.json.');
    expect(problems['sai-thoi-luong']).toContain('components.text-beat.duration: cần min ≤ default ≤ max');
    expect(problems['thieu-token']).toMatch(/^Mẫu "thieu-token": template.json chưa hợp lệ — tokens: /);
    expect(problems['ten-thu-muc']).toBe('Mẫu "ten-thu-muc": id "khac-id" phải trùng tên thư mục.');
    expect(problems['preset-la']).toContain('hiệu ứng "bay-vao" không có trong danh sách animations');
    expect(problems['thieu-block']).toBe('Mẫu "thieu-block": không thấy tệp components/khong-co.html.');
    expect(problems['duong-dan-ra-ngoai']).toContain('rules: phải là đường dẫn tương đối bên trong thư mục mẫu');
    expect(problems['th-vang']).toContain('trùng id với một mẫu cài sẵn');
    expect(reg.list()).toHaveLength(22);
    expect(reg.get('sai-thoi-luong')).toBeNull();
    expect(() => loadTemplateDir(path.join(userDir, 'json-hong'))).toThrow(TemplateError);
  });

  it('only resolves files inside the pack folder', () => {
    expect(reg.file('th-vang', 'rules.md')).toBe(fs.realpathSync(path.join(TH_VANG, 'rules.md')));
    expect(reg.file('th-vang', 'components/text-beat.html')).toBeTruthy();
    for (const bad of ['../../../package.json', '../th-vang/rules.md', 'components/../rules.md', '/etc/passwd', '.git/config', 'components', 'rules.md\0.png', '']) {
      expect(reg.file('th-vang', bad)).toBeNull();
    }
    const dir = addPack('co-symlink');
    fs.symlinkSync(path.resolve('package.json'), path.join(dir, 'leak.json'));
    expect(reg.file('co-symlink', 'leak.json')).toBeNull();
    expect(reg.file('style:kienthuc', 'rules.md')).toBeNull();
  });

  it('templateForPrompt carries the rules, components, props and presets', () => {
    const prompt = templateForPrompt('th-vang');
    const rules = fs.readFileSync(path.join(TH_VANG, 'rules.md'), 'utf8').trim();
    expect(prompt).toContain('## Mẫu edit: Talking head vàng (th-vang)');
    expect(prompt).toContain(rules);
    for (const id of ['text-beat', 'scene-steps', 'scene-before-after', 'broll-frame', 'logo-end']) expect(prompt).toContain(`- ${id} — `);
    expect(prompt).toContain('title* (markup, ≤6 từ, ≤2 dòng)');
    expect(prompt).toContain('items* (list, ≤6 từ, ≤5 mục)');
    expect(prompt).toContain('typewriter (Gõ chữ, tiếng sfx:typing)');
    expect(prompt).toContain('Phong cách nền: Kiến thức nhanh');
    expect(prompt.length).toBeLessThan(8000);

    const legacy = templateForPrompt('style:sanpham');
    expect(legacy).toContain(VIDEO_STYLES.find((s) => s.id === 'sanpham')!.promptNotes);
    expect(legacy).toContain('- compare-ab: So sánh A | B. Props: labelA, textA, labelB, textB.');
    expect(() => templateForPrompt('khong-co')).toThrow('Không tìm thấy mẫu này.');
  });

  it('componentHtml returns each block of th-vang and refuses unknown components', () => {
    for (const id of Object.keys(getTemplate('th-vang')!.components)) {
      expect(componentHtml('th-vang', id)).toContain(`data-composition-id="${id}"`);
    }
    expect(() => componentHtml('th-vang', 'khong-co')).toThrow('Mẫu "th-vang" không có component "khong-co".');
    expect(() => componentHtml('style:kienthuc', 'text-beat')).toThrow(TemplateError);
  });

  it('install remembers owner choices; built-in packs stay installed', () => {
    addPack('cua-toi');
    expect(reg.install('cua-toi')).toMatchObject({ id: 'cua-toi', installed: true });
    expect(reg.install('style:review')).toMatchObject({ id: 'style:review', installed: true, legacy: true });
    expect(reg.install('th-vang').installed).toBe(true);
    expect(reg.install('cua-toi').installed).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(userDir, 'installed.json'), 'utf8'))).toEqual({ installed: ['cua-toi', 'style:review'] });
    const again = createTemplateRegistry({ builtinDir: () => BUILTIN, userDir: () => userDir });
    expect(again.list().filter((t) => t.installed).map((t) => t.id).sort()).toEqual(['cua-toi', 'style:review', 'th-vang']);
    expect(() => reg.install('khong-co')).toThrow(TemplateError);
  });
});
