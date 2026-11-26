import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractLinks, linkSlug } from './brain.js';
import { memDb, sampleBrain } from './test-kit.js';
import { migrateCore, openDb } from '../core/db.js';

const linksOf = (db: ReturnType<typeof memDb>, folder: string, src: string) =>
  (db.prepare('SELECT dst_slug FROM brain_links WHERE folder_id = ? AND src_path = ? ORDER BY dst_slug').all(folder, src) as { dst_slug: string }[]).map((r) => r.dst_slug);

describe('wiki links', () => {
  it('extracts [[slug]], [[slug|label]], [[slug#heading]], embeds and links in frontmatter', () => {
    const text = [
      '---',
      'cong_thuc: "[[huong-dan-3-buoc]]"',
      'bang_chung: ["[[2026-11-24-uop-tra-sen]]", "[[2026-11-19-o-long-lanh|bài Ô long]]"]',
      '---',
      'Xem [[Khach-Hang/Chi-Lan.md|chị Lan]] và [[huong-dan-3-buoc#Bước 2]], ảnh ![[bia]].',
      'Không phải liên kết: [[]] [[ ]] [x](y) [[a',
    ].join('\n');
    expect(extractLinks(text).sort()).toEqual(['2026-11-19-o-long-lanh', '2026-11-24-uop-tra-sen', 'bia', 'huong-dan-3-buoc', 'khach-hang/chi-lan'].sort());
    expect(linkSlug(' ./Bai-Hoc/X.MD ')).toBe('bai-hoc/x');
  });

  it('indexes links, replaces them when the note changes, drops them when it is deleted', async () => {
    const { brain, db, root } = sampleBrain();
    const dir = path.join(root, 'brain', 'cong-ty-b');
    fs.writeFileSync(path.join(dir, 'bai-hoc.md'), '# Bài học\nTheo [[danh-muc-tra-sen]] và [[chinh-sach-dai-ly|chính sách]].\n');
    await brain.reindex();
    expect(linksOf(db, 'cong-ty-b', 'bai-hoc.md')).toEqual(['chinh-sach-dai-ly', 'danh-muc-tra-sen']);
    expect(brain.backlinks('cong-ty-b', 'danh-muc-tra-sen.md')).toEqual(['bai-hoc.md']);
    expect(brain.backlinks('cong-ty-a', 'danh-muc-tra-sen.md')).toEqual([]);

    fs.writeFileSync(path.join(dir, 'bai-hoc.md'), '# Bài học\nChỉ còn [[bao-cao-doanh-thu-quy-3]].\n');
    brain.indexPaths('cong-ty-b', ['bai-hoc.md']);
    expect(linksOf(db, 'cong-ty-b', 'bai-hoc.md')).toEqual(['bao-cao-doanh-thu-quy-3']);
    expect(brain.backlinks('cong-ty-b', 'danh-muc-tra-sen.md')).toEqual([]);

    // a link with a folder part also counts as a backlink
    fs.mkdirSync(path.join(dir, 'khach-hang'));
    fs.writeFileSync(path.join(dir, 'khach-hang', 'chi-lan.md'), '# Chị Lan\n');
    fs.writeFileSync(path.join(dir, 'ghi.md'), '[[khach-hang/chi-lan]] [[chi-lan]]');
    await brain.reindex();
    expect(brain.backlinks('cong-ty-b', 'khach-hang/chi-lan.md')).toEqual(['ghi.md']);

    fs.unlinkSync(path.join(dir, 'bai-hoc.md'));
    await brain.reindex();
    expect(linksOf(db, 'cong-ty-b', 'bai-hoc.md')).toEqual([]);
    fs.unlinkSync(path.join(dir, 'ghi.md'));
    brain.indexPaths('cong-ty-b', ['ghi.md']);
    expect(brain.backlinks('cong-ty-b', 'khach-hang/chi-lan.md')).toEqual([]);
  });

  it('migration makes notes indexed before brain_links existed get re-read', async () => {
    const db = openDb(':memory:');
    migrateCore(db);
    const { brain } = sampleBrain(db);
    await brain.reindex();
    expect((await brain.reindex()).indexed).toBe(0);
    db.exec('UPDATE brain_docs SET mtime_ms = -1'); // what 003_brain_links does to rows indexed before it
    expect((await brain.reindex()).indexed).toBeGreaterThan(0);
  });
});
