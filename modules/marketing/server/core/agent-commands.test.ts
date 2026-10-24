import fs from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('path') as typeof import('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const o = require('os') as typeof import('os');
  const root = p.join(o.tmpdir(), `fbstudio-cli-test-${process.pid}`);
  return { root, mediaDir: p.join(root, 'media'), srcDir: p.join(root, 'src') };
});

vi.mock('../../../_lib/composio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../_lib/composio.js')>();
  return { ...actual, FB_MEDIA_DIR: mocks.mediaDir };
});

import { _initTestDatabase, getFbContent, updateFbContentFields } from '../store.js';
import { CliUsageError, parseArgs, runCommand } from './agent-commands.js';
import { FbError } from './errors.js';
import { initTestDbWithRawAccess } from './test-db.js';
import { futureAt, makePage, seedContent } from './test-fixtures.js';
import { formatLocal } from './time.js';

function src(name: string, content = 'data'): string {
  fs.mkdirSync(mocks.srcDir, { recursive: true });
  const file = path.join(mocks.srcDir, name);
  fs.writeFileSync(file, content);
  return file;
}

function run(...argv: string[]): any {
  return runCommand(argv, 'main');
}

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected an error');
}

const local = (at: number): string => formatLocal(at, 'Asia/Ho_Chi_Minh');

beforeEach(() => {
  _initTestDatabase(':memory:');
  fs.rmSync(mocks.root, { recursive: true, force: true });
  makePage('p1');
});

describe('parseArgs', () => {
  it('parses positionals, repeated flags and --flag=value', () => {
    const a = parseArgs(['add', '--page', 'Page p1', '--hook', 'one', '--hook=two', '--media', 'a.mp4', '--media', 'b.mp4', '--title', 'T']);
    expect(a.command).toBe('add');
    expect(a.flags.get('hook')).toEqual(['one', 'two']);
    expect(a.flags.get('media')).toEqual(['a.mp4', 'b.mp4']);
    expect(a.flags.get('page')).toEqual(['Page p1']);
    expect(parseArgs(['schedule', '12', '2026-10-20 19:30']).positional).toEqual(['12', '2026-10-20 19:30']);
    expect(parseArgs(['pages', '--all']).flags.has('all')).toBe(true);
  });

  it('rejects unknown flags, missing values and duplicated single flags', () => {
    expect(() => parseArgs(['add', '--bogus', 'x'])).toThrow(CliUsageError);
    expect(() => parseArgs(['add', '--title'])).toThrow(/cần một giá trị/);
    expect(() => parseArgs(['add', '--title', '--page', 'p'])).toThrow(/cần một giá trị/);
    expect(() => parseArgs(['add', '--title', 'a', '--title', 'b'])).toThrow(/chỉ được dùng một lần/);
  });

  it('keeps values that merely start with a dash', () => {
    expect(parseArgs(['add', '--caption', '- gạch đầu dòng']).flags.get('caption')).toEqual(['- gạch đầu dòng']);
  });
});

describe('runCommand errors', () => {
  it('explains unknown commands', () => {
    expect(thrown(() => run('publish', '1'))).toBeInstanceOf(CliUsageError);
    expect(thrown(() => run())).toBeInstanceOf(CliUsageError);
    expect(thrown(() => run('show')).message).toMatch(/mã bài/);
    expect(thrown(() => run('show', 'abc'))).toBeInstanceOf(CliUsageError);
    expect(thrown(() => run('show', '404'))).toBeInstanceOf(FbError);
  });
});

describe('pages', () => {
  it('lists enabled Pages with voice, pillars and rules; --all includes the rest', () => {
    makePage('p2', { enabled: 0 });
    makePage('p3', { brand_voice: 'Thân thiện', pillars_json: JSON.stringify([{ name: 'Giáo dục', targetPct: 50 }]), approval_required: 0 });
    const enabled = run('pages');
    expect(enabled.map((p: any) => p.id)).toEqual(['p1', 'p3']);
    const p3 = enabled.find((p: any) => p.id === 'p3');
    expect(p3).toMatchObject({ brandVoice: 'Thân thiện', approvalRequired: false, window: '07:00-22:00', timezone: 'Asia/Ho_Chi_Minh' });
    expect(p3.pillars).toEqual([{ name: 'Giáo dục', targetPct: 50 }]);
    expect(run('pages', '--all')).toHaveLength(3);
  });
});

describe('add', () => {
  it('creates a review item on Pages that need approval and keeps the time as a proposal', () => {
    const at = futureAt(2, '19:30');
    const out = run('add', '--page', 'p1', '--format', 'text', '--title', 'Bài A', '--caption', 'Nội dung', '--pillar', 'Giáo dục', '--hook-type', 'câu hỏi', '--cta', 'Inbox',
      '--campaign', 'Thu 2026', '--hook', 'h1', '--hook', 'h2', '--hook', 'h3', '--schedule', local(at));
    expect(out.ok).toBe(true);
    expect(out.approvalRequired).toBe(true);
    expect(out.content).toMatchObject({ status: 'review', source: 'main', scheduledAt: at, scheduledLocal: local(at), page: 'Page p1' });
    const row = getFbContent(out.content.id)!;
    expect(row).toMatchObject({ pillar: 'Giáo dục', hook_type: 'câu hỏi', cta: 'Inbox', campaign: 'Thu 2026', status: 'review' });
    expect(JSON.parse(row.hooks_json)).toEqual(['h1', 'h2', 'h3']);
  });

  it('does not validate the proposal against the Page rules when approval is on', () => {
    const out = run('add', '--page', 'p1', '--format', 'text', '--title', 'T', '--schedule', local(futureAt(2, '23:30')));
    expect(out.content.status).toBe('review');
  });

  it('copies media into the post folder and records its source agent', () => {
    const file = src('clip one.mp4');
    const out = runCommand(['add', '--page', 'p1', '--format', 'video', '--title', 'V', '--media', file], 'video-heygen') as { content: { id: number } };
    const id = out.content.id;
    const row = getFbContent(id)!;
    const media = JSON.parse(row.media_json);
    expect(row.source).toBe('video-heygen');
    expect(media).toHaveLength(1);
    expect(media[0].kind).toBe('video');
    expect(media[0].path.startsWith(path.join(mocks.mediaDir, String(id)) + path.sep)).toBe(true);
    expect(fs.existsSync(media[0].path)).toBe(true);
    expect(path.basename(media[0].path)).not.toContain(' ');
    expect(fs.existsSync(file)).toBe(true); // the original stays
  });

  it('--agent overrides the calling agent id', () => {
    const out = run('add', '--page', 'p1', '--format', 'text', '--title', 'T', '--agent', 'writer');
    expect(getFbContent(out.content.id)?.source).toBe('writer');
  });

  it('removes the post again when a media file is missing or unsupported', () => {
    expect(thrown(() => run('add', '--page', 'p1', '--format', 'video', '--title', 'V', '--media', '/nope/missing.mp4'))).toBeInstanceOf(FbError);
    expect(thrown(() => run('add', '--page', 'p1', '--format', 'video', '--title', 'V', '--media', src('notes.txt'))).message).toMatch(/loại tệp/);
    expect(run('list').total).toBe(0);
  });

  it('goes straight to approved, or scheduled, when the Page has approval off', () => {
    makePage('p2', { approval_required: 0 });
    const plain = run('add', '--page', 'p2', '--format', 'text', '--title', 'A', '--caption', 'x');
    expect(plain.content.status).toBe('approved');
    expect(plain.approvalRequired).toBe(false);
    const at = futureAt(2, '10:00');
    const timed = run('add', '--page', 'p2', '--format', 'text', '--title', 'B', '--caption', 'x', '--schedule', local(at));
    expect(timed.content).toMatchObject({ status: 'scheduled', scheduledAt: at });
  });

  it('rejects a time that breaks the rules before creating anything (approval off)', () => {
    makePage('p2', { approval_required: 0 });
    const err = thrown(() => run('add', '--page', 'p2', '--format', 'text', '--title', 'A', '--caption', 'x', '--schedule', local(futureAt(2, '23:30'))));
    expect(err).toBeInstanceOf(FbError);
    expect(err.message).toMatch(/ngoài khung/);
    expect(run('list').total).toBe(0);
  });

  it('keeps an incomplete post in review with a warning (approval off)', () => {
    makePage('p2', { approval_required: 0 });
    const out = run('add', '--page', 'p2', '--format', 'video', '--title', 'No file');
    expect(out.content.status).toBe('review');
    expect(out.warnings[0]).toMatch(/Chưa duyệt tự động được/);
  });

  it('validates arguments', () => {
    expect(thrown(() => run('add', '--format', 'text', '--title', 'T'))).toBeInstanceOf(CliUsageError);
    expect(thrown(() => run('add', '--page', 'p1', '--title', 'T')).message).toMatch(/--format/);
    expect(thrown(() => run('add', '--page', 'p1', '--format', 'story', '--title', 'T'))).toBeInstanceOf(CliUsageError);
    expect(thrown(() => run('add', '--page', 'p1', '--format', 'text', '--title', 'T', '--schedule', '20/10 19:30')).message).toMatch(/YYYY-MM-DD HH:MM/);
    expect(thrown(() => run('add', '--page', 'p1', '--format', 'text', '--title', 'T', '--schedule', '2020-01-01 10:00'))).toBeInstanceOf(FbError);
    expect(thrown(() => run('add', '--page', 'nope', '--format', 'text', '--title', 'T'))).toBeInstanceOf(FbError);
  });
});

describe('resolvePage', () => {
  it('matches by id, exact name and an accent-insensitive unique fragment', () => {
    makePage('1001', { name: 'Tony Hoàng Learn AI Automation' });
    makePage('1002', { name: 'BIM Speed' });
    makePage('1003', { name: 'Page nine' });
    const byName = (ref: string): string => run('add', '--page', ref, '--format', 'text', '--title', 't').content.pageId;
    expect(byName('1001')).toBe('1001');
    expect(byName('BIM Speed')).toBe('1002');
    expect(byName('tony hoang')).toBe('1001');
    expect(byName('bim')).toBe('1002');
    expect(thrown(() => byName('Page')).message).toMatch(/khớp nhiều/); // matches 'Page p1' and 'Page nine'
    expect(thrown(() => byName('zzz')).message).toMatch(/Không tìm thấy/);
  });
});

describe('update', () => {
  it('edits tags and hooks and replaces media', () => {
    const add = run('add', '--page', 'p1', '--format', 'photo', '--title', 'Ảnh', '--media', src('a.jpg'));
    const id = add.content.id;
    const out = run('update', String(id), '--caption', 'Sửa', '--hook', 'x', '--hook', 'y', '--pillar', 'Case study', '--media', src('b.png'), '--media', src('c.png'));
    expect(out.content.id).toBe(id);
    const row = getFbContent(id)!;
    expect(row.caption).toBe('Sửa');
    expect(JSON.parse(row.hooks_json)).toEqual(['x', 'y']);
    expect(row.pillar).toBe('Case study');
    const media = JSON.parse(row.media_json);
    expect(media.map((m: any) => path.basename(m.path).replace(/^[^-]+-\d+-/, ''))).toEqual(['b.png', 'c.png']);
  });

  it('reuses files that are already in the post folder', () => {
    const add = run('add', '--page', 'p1', '--format', 'photo', '--title', 'Ảnh', '--media', src('a.jpg'));
    const existing = JSON.parse(getFbContent(add.content.id)!.media_json)[0].path;
    run('update', String(add.content.id), '--media', existing, '--title', 'Mới');
    expect(JSON.parse(getFbContent(add.content.id)!.media_json)[0].path).toBe(existing);
    expect(fs.readdirSync(path.dirname(existing))).toHaveLength(1);
  });

  it('sends approved content of an approval-required Page back to review', () => {
    const id = seedContent({ status: 'approved' });
    expect(run('update', String(id), '--caption', 'Agent sửa').content.status).toBe('review');
  });

  it('needs something to change and refuses published posts', () => {
    const id = seedContent({ status: 'draft' });
    expect(thrown(() => run('update', String(id))).message).toMatch(/ít nhất một cờ/);
    const pub = seedContent({ status: 'published', fb_post_id: '1_1' });
    expect(thrown(() => run('update', String(pub), '--caption', 'x'))).toBeInstanceOf(FbError);
    expect(run('update', String(pub), '--pillar', 'Tag mới').content.pillar).toBe('Tag mới');
  });
});

describe('schedule', () => {
  it('keeps a proposal while the owner has not approved (approval on)', () => {
    const id = seedContent({ status: 'review' });
    const at = futureAt(2, '19:00');
    const out = run('schedule', String(id), local(at));
    expect(out.content).toMatchObject({ status: 'review', scheduledAt: at });
    expect(out.note).toMatch(/chờ chủ kênh duyệt/);
  });

  it('schedules approved posts through the Page rules', () => {
    const id = seedContent({ status: 'approved' });
    const at = futureAt(2, '19:00');
    expect(run('schedule', String(id), local(at)).content).toMatchObject({ status: 'scheduled', scheduledAt: at });
    const other = seedContent({ status: 'approved' });
    const err = thrown(() => run('schedule', String(other), local(futureAt(2, '20:00'))));
    expect(err).toBeInstanceOf(FbError);
    expect(err.message).toMatch(/tối thiểu/);
    expect(getFbContent(other)?.status).toBe('approved');
  });

  it('approves and schedules on Pages with approval off', () => {
    makePage('p2', { approval_required: 0 });
    const id = seedContent({ page_id: 'p2', status: 'review' });
    const at = futureAt(2, '19:00');
    const out = run('schedule', String(id), local(at));
    expect(out.content).toMatchObject({ status: 'scheduled', scheduledAt: at });
    expect(out.note).toBeUndefined();
  });

  it('validates arguments', () => {
    expect(thrown(() => run('schedule', '1'))).toBeInstanceOf(CliUsageError);
    expect(thrown(() => run('schedule', 'x', '2026-10-20 10:00'))).toBeInstanceOf(CliUsageError);
    const id = seedContent({ status: 'approved' });
    expect(thrown(() => run('schedule', String(id), 'tomorrow'))).toBeInstanceOf(CliUsageError);
    expect(thrown(() => run('schedule', String(seedContent({ page_id: null })), '2030-01-01 10:00'))).toBeInstanceOf(FbError);
  });
});

describe('list / show', () => {
  it('lists compactly with counts and owner feedback, filtered by status and Page', () => {
    seedContent({ status: 'draft', feedback: 'Sửa hook', title: 'A' });
    seedContent({ status: 'review', title: 'B' });
    const all = run('list');
    expect(all.total).toBe(2);
    expect(all.counts).toMatchObject({ all: 2, draft: 1, review: 1 });
    expect(all.items.find((i: any) => i.title === 'A').feedback).toBe('Sửa hook');
    expect(all.items[0]).not.toHaveProperty('caption');
    expect(run('list', '--status', 'review').items).toHaveLength(1);
    expect(run('list', '--page', 'Page p1').items).toHaveLength(2);
    expect(thrown(() => run('list', '--status', 'weird'))).toBeInstanceOf(FbError);
  });

  it('shows one post in full with local time', () => {
    const at = futureAt(2, '09:15');
    const id = seedContent({ status: 'scheduled', scheduled_at: at, caption: 'Đầy đủ' });
    const out = run('show', String(id));
    expect(out).toMatchObject({ id, caption: 'Đầy đủ', scheduledLocal: local(at), log: [] });
  });
});

describe('insights', () => {
  it('says when there is no data yet', () => {
    const out = run('insights', '--page', 'p1');
    expect(out.analyst).toBeNull();
    expect(out.topPosts).toEqual([]);
    expect(out.note).toMatch(/Chưa có dữ liệu/);
    expect(out.page).toMatchObject({ id: 'p1', pillars: [] });
  });

  it('returns the latest Analyst summary and the top posts by engagement rate', () => {
    const raw = initTestDbWithRawAccess();
    makePage('p1', { brand_voice: 'Vui' });
    const now = Math.floor(Date.now() / 1000);
    const a = seedContent({ status: 'published', title: 'Thấp', published_at: now - 86400, fb_post_id: 'x_1', pillar: 'A' });
    const b = seedContent({ status: 'published', title: 'Cao', published_at: now - 2 * 86400, fb_post_id: 'x_2', pillar: 'B' });
    seedContent({ status: 'published', title: 'Không số liệu', published_at: now - 3 * 86400, fb_post_id: 'x_3' });
    updateFbContentFields(a, {});
    raw.exec(`INSERT INTO fb_post_metrics (post_id, page_id, milestone, captured_at, reach, reactions, comments, shares) VALUES ('x_1','p1','24h',${now},1000,10,0,0)`);
    raw.exec(`INSERT INTO fb_post_metrics (post_id, page_id, milestone, captured_at, reach, reactions, comments, shares) VALUES ('x_2','p1','24h',${now},1000,60,10,10)`);
    raw.prepare(`INSERT INTO fb_insights (page_id, kind, body_json, created_at) VALUES ('p1','channel',?,?)`).run(JSON.stringify({ summary: ['s1', 's2', 's3'], actions: ['a1'] }), now);
    const out = run('insights', '--page', 'p1');
    expect(out.analyst).toEqual({ summary: ['s1', 's2', 's3'], actions: ['a1'], createdAt: now });
    expect(out.topPosts.map((p: any) => p.title)).toEqual(['Cao', 'Thấp']);
    expect(out.topPosts[0].er).toBeCloseTo(8, 5);
    expect(out.page.brandVoice).toBe('Vui');
    void b;
    raw.close();
  });
});
