import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { lessonPath, normalize, searchLessons, splitSections } from './lessons.js';

let vault: string;
const write = (rel: string, text: string) => {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'video-lessons-'));
  write('Video Studio/Bai-hoc/hook.md', '# Hook 3 giây\n\n## Nguyên tắc\nMở bằng con số cụ thể.\n\n## Không áp dụng khi\nPhong cách tâm sự.\n');
  write('Video Studio/Bai-hoc/nhip.md', '# Nhịp cắt\n\nCắt nhanh cho video công nghệ.\n');
  write('Video Studio/Kenh/kenh-a/bai-hoc/rieng.md', '# Hook riêng của kênh A\n\nLuôn mở bằng câu hỏi ngắn.\n');
  write('Video Studio/Kenh/kenh-b/bai-hoc/khac.md', '# Hook kênh B\n\nKênh B thích chữ đỏ.\n');
  write('Other/ngoai.md', '# Hook ngoài thư mục\n\nKhông được tra.\n');
});
afterEach(() => fs.rmSync(vault, { recursive: true, force: true }));

describe('lessons search', () => {
  it('finds sections with file and heading, diacritics-insensitive', () => {
    const r = searchLessons({ vaultDir: vault, query: 'mo dau con so', scope: 'shared' });
    expect(r.hits[0]).toMatchObject({ file: 'Video Studio/Bai-hoc/hook.md', heading: 'Nguyên tắc', scope: 'shared' });
    expect(r.searched).toEqual(['Video Studio']);
  });

  it('searches the shared folder (minus Kenh/) plus only this channel', () => {
    const r = searchLessons({ vaultDir: vault, query: 'hook', profileSlug: 'kenh-a' });
    const files = r.hits.map((h) => h.file);
    expect(files).toContain('Video Studio/Kenh/kenh-a/bai-hoc/rieng.md');
    expect(files).toContain('Video Studio/Bai-hoc/hook.md');
    expect(files.some((f) => f.includes('kenh-b'))).toBe(false);
    expect(files.some((f) => f.startsWith('Other/'))).toBe(false);
    expect(r.searched).toEqual(['Video Studio', 'Video Studio/Kenh/kenh-a']);
  });

  it('honours scope and ranks a channel lesson first on a tie', () => {
    expect(searchLessons({ vaultDir: vault, query: 'hook', profileSlug: 'kenh-a', scope: 'channel' }).hits.every((h) => h.scope === 'channel')).toBe(true);
    const both = searchLessons({ vaultDir: vault, query: 'hook', profileSlug: 'kenh-a' });
    expect(both.hits[0].scope).toBe('channel');
  });

  it('says so when nothing matches, and respects the limit', () => {
    expect(searchLessons({ vaultDir: vault, query: 'zzzqqq' }).note).toContain('Không có bài học khớp');
    expect(searchLessons({ vaultDir: vault, query: 'hook', limit: 1 }).hits).toHaveLength(1);
  });

  it('falls back to the bundled lessons when the vault has no Video Studio folder', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'video-empty-'));
    const bundled = path.join(vault, 'Video Studio', 'Bai-hoc');
    try {
      const r = searchLessons({ vaultDir: empty, query: 'hook', fallbackDir: bundled });
      expect(r.hits.length).toBeGreaterThan(0);
      expect(r.hits[0].scope).toBe('builtin');
      expect(r.note).toContain('dựng sẵn');
      expect(searchLessons({ vaultDir: null, query: 'hook' }).note).toContain('Không tìm thấy vault');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('finds the bundled starter lessons shipped with the skill', () => {
    const bundled = path.resolve(__dirname, '../../../skills/video-edit/references/lessons');
    for (const q of ['hook 3 giay', 'nhip cat phong cach', 'phu de tieng viet', 'b-roll', 'anh bia']) {
      const r = searchLessons({ vaultDir: null, query: q, fallbackDir: bundled });
      expect(r.hits.length, q).toBeGreaterThan(0);
    }
  });
});

describe('helpers', () => {
  it('splits sections by heading and ignores headings inside code fences', () => {
    const s = splitSections('---\nname: x\n---\n# A\ntext a\n```\n# not a heading\n```\n## B\ntext b', 'fallback');
    expect(s.map((x) => x.heading)).toEqual(['A', 'B']);
    expect(s[0].body).toContain('# not a heading');
  });

  it('builds the vault target path for a channel and for shared lessons', () => {
    expect(lessonPath({ profileSlug: 'kenh-a', fileName: 'Học từ Kênh Mẫu 2026' })).toBe('Video Studio/Kenh/kenh-a/bai-hoc/hoc-tu-kenh-mau-2026.md');
    expect(lessonPath({ shared: true, fileName: 'Hook.md' })).toBe('Video Studio/Bai-hoc/hook.md');
    expect(lessonPath({ profileSlug: null, fileName: '???' })).toBe('Video Studio/Bai-hoc/bai-hoc.md');
    expect(normalize('Đẹp Ơi')).toBe('dep oi');
  });
});
