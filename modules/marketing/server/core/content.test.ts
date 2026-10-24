import fs from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('path') as typeof import('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const o = require('os') as typeof import('os');
  return { mediaDir: p.join(o.tmpdir(), `fbstudio-content-test-${process.pid}`, 'media') };
});

vi.mock('../../../_lib/composio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../_lib/composio.js')>();
  return { ...actual, FB_MEDIA_DIR: mocks.mediaDir };
});

import { _initTestDatabase, getFbContent, updateFbContentFields } from '../store.js';
import {
  approveContent,
  calendarItems,
  createContent,
  deleteContentLocal,
  getContentDetail,
  listContent,
  returnContent,
  unscheduleContent,
  updateContent,
} from './content.js';
import { FbError } from './errors.js';
import { futureAt, makePage, seedContent } from './test-fixtures.js';

const user = { kind: 'user' } as const;
const agent = { kind: 'agent', id: 'main' } as const;

function fail(fn: () => unknown): FbError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(FbError);
    return err as FbError;
  }
  throw new Error('expected FbError');
}

beforeEach(() => {
  _initTestDatabase(':memory:');
  fs.rmSync(path.dirname(mocks.mediaDir), { recursive: true, force: true });
  makePage('p1');
});

describe('createContent', () => {
  it('creates a draft by default and stores the tags', () => {
    const c = createContent({ pageId: 'p1', title: ' Hello ', caption: 'x', format: 'text', pillar: 'Giáo dục', hooks: [' a ', '', 'b'] }, user);
    expect(c.status).toBe('draft');
    expect(c.title).toBe('Hello');
    expect(c.hooks).toEqual(['a', 'b']);
    expect(c.source).toBe('user');
    expect(c.pageName).toBe('Page p1');
    expect(c.origin).toBe('studio');
  });

  it('records the agent id as source', () => {
    expect(createContent({ pageId: 'p1', status: 'review' }, { kind: 'agent', id: 'video-heygen' }).source).toBe('video-heygen');
  });

  it('refuses approved/scheduled/published as an initial status', () => {
    for (const status of ['approved', 'scheduled', 'published', 'publishing'] as const) {
      expect(fail(() => createContent({ pageId: 'p1', status }, user)).status).toBe(400);
    }
  });

  it('rejects an unknown Page, a bad format and a past proposal', () => {
    expect(fail(() => createContent({ pageId: 'nope' }, user)).status).toBe(400);
    expect(fail(() => createContent({ format: 'story' as never }, user)).status).toBe(400);
    expect(fail(() => createContent({ scheduledAt: 5 }, user)).status).toBe(400);
  });

  it('only accepts media inside the studio media dir', () => {
    expect(fail(() => createContent({ media: [{ path: '/etc/passwd', kind: 'image' }] }, user)).status).toBe(400);
    expect(fail(() => createContent({ media: [{ path: path.join(mocks.mediaDir, '..', 'x.jpg'), kind: 'image' }] }, user)).status).toBe(400);
    const ok = createContent({ media: [{ path: path.join(mocks.mediaDir, '1', 'a.jpg'), kind: 'image' }] }, user);
    expect(ok.media).toHaveLength(1);
  });

  it('allows an idea without a Page', () => {
    const c = createContent({ status: 'idea', title: 'Ý tưởng' }, user);
    expect(c.pageId).toBeNull();
    expect(c.pageName).toBeNull();
  });
});

describe('approveContent', () => {
  it('moves review to approved when no time is known', () => {
    const id = seedContent({ status: 'review' });
    const c = approveContent(id, undefined);
    expect(c.status).toBe('approved');
    expect(c.scheduledAt).toBeNull();
  });

  it('schedules when a time is given and the rules pass', () => {
    const id = seedContent({ status: 'review' });
    const at = futureAt(2, '19:30');
    const c = approveContent(id, at);
    expect(c.status).toBe('scheduled');
    expect(c.scheduledAt).toBe(at);
  });

  it('uses the stored proposal when it is still in the future', () => {
    const at = futureAt(2, '10:00');
    const id = seedContent({ status: 'review', scheduled_at: at });
    expect(approveContent(id, undefined).status).toBe('scheduled');
  });

  it('ignores a stale proposal', () => {
    const id = seedContent({ status: 'missed', scheduled_at: 1000 });
    const c = approveContent(id, undefined);
    expect(c.status).toBe('approved');
    expect(c.scheduledAt).toBeNull();
  });

  it('answers 409 with a Vietnamese reason when the rules fail', () => {
    const first = seedContent({ status: 'review' });
    approveContent(first, futureAt(2, '12:00'));
    const second = seedContent({ status: 'review' });
    const err = fail(() => approveContent(second, futureAt(2, '13:00')));
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/tối thiểu 180 phút/);
    expect(fail(() => approveContent(second, futureAt(2, '23:30'))).message).toMatch(/ngoài khung/);
    expect(fail(() => approveContent(second, Math.floor(Date.now() / 1000) - 60)).message).toMatch(/đã qua/);
    expect(getFbContent(second)?.status).toBe('review');
  });

  it('enforces max posts per day', () => {
    makePage('p2', { max_posts_per_day: 2, min_gap_minutes: 0 });
    const ids = [1, 2, 3].map(() => seedContent({ page_id: 'p2', status: 'review' }));
    approveContent(ids[0], futureAt(3, '08:00'));
    approveContent(ids[1], futureAt(3, '09:00'));
    expect(fail(() => approveContent(ids[2], futureAt(3, '10:00'))).message).toMatch(/đủ 2 bài/);
  });

  it('does not count posts of other Pages or the post itself', () => {
    makePage('p2');
    const other = seedContent({ page_id: 'p2', status: 'review' });
    approveContent(other, futureAt(2, '12:00'));
    const mine = seedContent({ status: 'review' });
    expect(approveContent(mine, futureAt(2, '12:00')).status).toBe('scheduled');
    // re-approving at the same time must not collide with itself
    expect(approveContent(mine, futureAt(2, '12:00')).status).toBe('scheduled');
  });

  it('refuses scheduling on a disabled Page', () => {
    makePage('p3', { enabled: 0 });
    const id = seedContent({ page_id: 'p3', status: 'review' });
    expect(fail(() => approveContent(id, futureAt(2, '12:00'))).message).toMatch(/chưa được bật/);
    expect(approveContent(id, undefined).status).toBe('approved');
  });

  it('refuses incomplete posts', () => {
    const noMedia = seedContent({ status: 'review', format: 'video' });
    expect(fail(() => approveContent(noMedia, undefined)).status).toBe(400);
    const noPage = seedContent({ status: 'review', page_id: null });
    expect(fail(() => approveContent(noPage, undefined)).status).toBe(400);
  });

  it('refuses published, publishing and deleted posts', () => {
    for (const status of ['published', 'publishing', 'deleted']) {
      const id = seedContent({ status });
      expect(fail(() => approveContent(id, undefined)).status).toBe(409);
    }
    expect(fail(() => approveContent(9999, undefined)).status).toBe(404);
  });

  it('leaves an already scheduled post alone when no new time is given', () => {
    const at = futureAt(2, '12:00');
    const id = seedContent({ status: 'scheduled', scheduled_at: at });
    expect(approveContent(id, undefined).scheduledAt).toBe(at);
  });

  it('resets attempts and the error when re-approving a failed post', () => {
    const id = seedContent({ status: 'failed', attempts: 4, last_error: 'boom' });
    const c = approveContent(id, undefined);
    expect(c.status).toBe('approved');
    expect(c.attempts).toBe(0);
    expect(c.lastError).toBe('');
  });
});

describe('returnContent / unscheduleContent', () => {
  it('returns a post to draft with the feedback', () => {
    const id = seedContent({ status: 'review', scheduled_at: futureAt(2, '12:00') });
    const c = returnContent(id, '  Sửa hook  ');
    expect(c.status).toBe('draft');
    expect(c.feedback).toBe('Sửa hook');
    expect(c.scheduledAt).toBeNull();
  });

  it('requires feedback and a returnable state', () => {
    const id = seedContent({ status: 'review' });
    expect(fail(() => returnContent(id, '   ')).status).toBe(400);
    expect(fail(() => returnContent(seedContent({ status: 'draft' }), 'x')).status).toBe(409);
    expect(fail(() => returnContent(seedContent({ status: 'published' }), 'x')).status).toBe(409);
  });

  it('unschedules back to approved and refuses once publishing', () => {
    const id = seedContent({ status: 'scheduled', scheduled_at: futureAt(2, '12:00'), attempts: 1 });
    const c = unscheduleContent(id);
    expect(c.status).toBe('approved');
    expect(c.scheduledAt).toBeNull();
    expect(c.attempts).toBe(0);
    expect(fail(() => unscheduleContent(id)).status).toBe(409);
    expect(fail(() => unscheduleContent(seedContent({ status: 'publishing' }))).message).toMatch(/đang được đăng/);
  });
});

describe('updateContent', () => {
  it('edits fields and moves along the authoring flow', () => {
    const id = seedContent({ status: 'draft' });
    const c = updateContent(id, { caption: 'Mới', status: 'review', hooks: ['h1', 'h2', 'h3'] }, user);
    expect(c.caption).toBe('Mới');
    expect(c.status).toBe('review');
    expect(c.hooks).toHaveLength(3);
    expect(fail(() => updateContent(id, { status: 'draft' }, user)).status).toBe(409);
    expect(updateContent(seedContent({ status: 'idea' }), { status: 'draft' }, user).status).toBe('draft');
    expect(fail(() => updateContent(id, { status: 'published' }, user)).status).toBe(409);
    expect(fail(() => updateContent(id, { status: 'approved' }, user)).status).toBe(409);
  });

  it('only accepts tag edits once published and nothing while publishing', () => {
    const pub = seedContent({ status: 'published', fb_post_id: '1_2' });
    expect(updateContent(pub, { pillar: 'Case study' }, user).pillar).toBe('Case study');
    expect(fail(() => updateContent(pub, { caption: 'x' }, user)).status).toBe(409);
    expect(fail(() => updateContent(pub, { scheduledAt: futureAt(2, '12:00') }, user)).status).toBe(409);
    const live = seedContent({ status: 'publishing' });
    expect(fail(() => updateContent(live, { title: 'x' }, user)).status).toBe(409);
    expect(fail(() => updateContent(seedContent({ status: 'deleted' }), { title: 'x' }, user)).status).toBe(409);
  });

  it('stores a proposal on authoring rows and validates the future', () => {
    const id = seedContent({ status: 'review' });
    const at = futureAt(2, '12:00');
    expect(updateContent(id, { scheduledAt: at }, user).scheduledAt).toBe(at);
    expect(updateContent(id, { scheduledAt: null }, user).scheduledAt).toBeNull();
    expect(fail(() => updateContent(id, { scheduledAt: 10 }, user)).status).toBe(400);
  });

  it('reschedules approved/scheduled rows through the rules', () => {
    const id = seedContent({ status: 'approved' });
    const c = updateContent(id, { scheduledAt: futureAt(2, '12:00') }, user);
    expect(c.status).toBe('scheduled');
    const other = seedContent({ status: 'review' });
    approveContent(other, futureAt(2, '18:00'));
    expect(fail(() => updateContent(id, { scheduledAt: futureAt(2, '17:00') }, user)).status).toBe(409);
    expect(getFbContent(id)?.scheduled_at).toBe(futureAt(2, '12:00'));
    // clearing the time unschedules
    expect(updateContent(id, { scheduledAt: null }, user).status).toBe('approved');
  });

  it('refuses to make an approved post incomplete', () => {
    const id = seedContent({ status: 'approved' });
    expect(fail(() => updateContent(id, { format: 'video' }, user)).status).toBe(400);
  });

  it('reschedules failed and missed posts through the rules, resetting the attempts', () => {
    for (const [status, day] of [['failed', 4], ['missed', 5]] as const) {
      const id = seedContent({ status, attempts: 4, last_error: 'x', next_attempt_at: 5, scheduled_at: 1000 });
      const at = futureAt(day, '10:00');
      const c = updateContent(id, { scheduledAt: at }, user);
      expect(c).toMatchObject({ status: 'scheduled', scheduledAt: at, attempts: 0, lastError: '' });
    }
    const blocked = seedContent({ status: 'missed', scheduled_at: 1000 });
    expect(fail(() => updateContent(blocked, { scheduledAt: futureAt(5, '11:00') }, user)).status).toBe(409);
    expect(getFbContent(blocked)?.status).toBe('missed');
  });

  it('clears the time of failed and missed posts without changing their status', () => {
    const id = seedContent({ status: 'failed', scheduled_at: 1000 });
    const c = updateContent(id, { scheduledAt: null }, user);
    expect(c.status).toBe('failed');
    expect(c.scheduledAt).toBeNull();
  });

  it('supports undoing a deleted schedule: approve an approved post with its old time', () => {
    const id = seedContent({ status: 'scheduled', scheduled_at: futureAt(3, '12:00') });
    const old = futureAt(3, '12:00');
    expect(updateContent(id, { scheduledAt: null }, user).status).toBe('approved');
    const back = approveContent(id, old);
    expect(back).toMatchObject({ status: 'scheduled', scheduledAt: old });
  });

  it('sends an agent edit of approved content back to review when the Page needs approval', () => {
    const id = seedContent({ status: 'approved' });
    expect(updateContent(id, { caption: 'agent edit' }, agent).status).toBe('review');
    // a person editing keeps the status
    const id2 = seedContent({ status: 'approved' });
    expect(updateContent(id2, { caption: 'user edit' }, user).status).toBe('approved');
  });

  it('keeps the status for agent edits on Pages with approval off', () => {
    makePage('p4', { approval_required: 0 });
    const id = seedContent({ page_id: 'p4', status: 'approved' });
    expect(updateContent(id, { caption: 'agent edit' }, agent).status).toBe('approved');
  });

  it('answers 409 when the publisher claimed the row meanwhile', () => {
    const id = seedContent({ status: 'scheduled', scheduled_at: futureAt(2, '12:00') });
    // simulate the claim happening between the read and the write
    updateFbContentFields(id, { status: 'publishing' });
    expect(fail(() => updateContent(id, { caption: 'late' }, user)).status).toBe(409);
  });
});

describe('deleteContentLocal', () => {
  it('deletes rows and their media folder, but not while publishing', () => {
    const id = seedContent({ status: 'draft' });
    const dir = path.join(mocks.mediaDir, String(id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.jpg'), 'x');
    deleteContentLocal(id);
    expect(getFbContent(id)).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(false);
    expect(fail(() => deleteContentLocal(seedContent({ status: 'publishing' }))).status).toBe(409);
    expect(fail(() => deleteContentLocal(12345)).status).toBe(404);
  });
});

describe('listContent / getContentDetail / calendarItems', () => {
  it('filters and counts', () => {
    seedContent({ status: 'draft', title: 'Alpha', pillar: 'A' });
    seedContent({ status: 'review', title: 'Beta', pillar: 'B', format: 'photo' });
    seedContent({ status: 'review', title: 'Gamma 50%_x', pillar: 'B', page_id: null });
    const all = listContent({});
    expect(all.total).toBe(3);
    expect(all.counts.all).toBe(3);
    expect(all.counts.review).toBe(2);
    expect(all.counts.published).toBe(0);
    expect(listContent({ status: 'review' }).items).toHaveLength(2);
    const both = listContent({ status: 'draft,review' });
    expect(both.total).toBe(3);
    expect(both.counts.all).toBe(3);
    expect(listContent({ status: 'failed,missed' })).toMatchObject({ total: 0, items: [] });
    expect(fail(() => listContent({ status: 'draft,bogus' })).status).toBe(400);
    expect(listContent({ status: 'all' }).total).toBe(3);
    expect(listContent({ status: 'review' }).counts.draft).toBe(1); // counts ignore the status filter
    expect(listContent({ page: 'p1' }).total).toBe(2);
    expect(listContent({ format: 'photo' }).total).toBe(1);
    expect(listContent({ pillar: 'B' }).total).toBe(2);
    expect(listContent({ q: 'alpha' }).total).toBe(1);
    expect(listContent({ q: '50%_x' }).total).toBe(1); // LIKE wildcards are escaped
    expect(listContent({ q: '%' }).total).toBe(1);
    expect(listContent({ limit: 1 }).items).toHaveLength(1);
    expect(fail(() => listContent({ status: 'bogus' })).status).toBe(400);
  });

  it('returns detail with the publish log', () => {
    const id = seedContent();
    const d = getContentDetail(id);
    expect(d.id).toBe(id);
    expect(d.log).toEqual([]);
    expect(fail(() => getContentDetail(404)).status).toBe(404);
  });

  it('lists calendar rows in a range, including missed and failed', () => {
    const from = futureAt(1, '00:00');
    const to = futureAt(30, '00:00');
    seedContent({ status: 'scheduled', scheduled_at: futureAt(2, '09:00') });
    seedContent({ status: 'published', published_at: futureAt(3, '09:00') });
    seedContent({ status: 'missed', scheduled_at: futureAt(4, '09:00') });
    seedContent({ status: 'failed', scheduled_at: futureAt(5, '09:00') });
    seedContent({ status: 'draft', scheduled_at: futureAt(6, '09:00') });
    seedContent({ status: 'scheduled', scheduled_at: futureAt(60, '09:00') });
    seedContent({ status: 'scheduled', scheduled_at: futureAt(2, '10:00'), page_id: 'p2' });
    const items = calendarItems(from, to);
    expect(items.map((i) => i.status)).toEqual(['scheduled', 'scheduled', 'published', 'missed', 'failed']);
    expect(calendarItems(from, to, 'p1')).toHaveLength(4);
  });
});
