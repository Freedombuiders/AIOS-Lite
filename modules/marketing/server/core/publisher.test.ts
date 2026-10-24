import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('path') as typeof import('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const o = require('os') as typeof import('os');
  return {
    mediaDir: p.join(o.tmpdir(), `fbstudio-publisher-test-${process.pid}`, 'media'),
    execute: vi.fn(),
    graphProxy: vi.fn(),
    hasKey: vi.fn(() => true),
    killSwitchOn: vi.fn(() => true),
    notify: vi.fn(async () => {}),
  };
});

vi.mock('../../../_lib/composio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../_lib/composio.js')>();
  return {
    ...actual,
    FB_MEDIA_DIR: mocks.mediaDir,
    execute: mocks.execute,
    graphAsPage: mocks.graphProxy,
    hasComposioKey: () => mocks.hasKey(),
  };
});
vi.mock('../settings.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../settings.js')>()), isEnabled: () => mocks.killSwitchOn() }));
vi.mock('../notify.js', () => ({ notifyOwner: mocks.notify }));

import {
  _initTestDatabase,
  claimFbContent,
  getFbContent,
  getFbPage,
  listFbPublishLog,
  setFbSetting,
  updateFbContentFields,
  updateFbPageFields,
} from '../store.js';
import {
  ComposioAuthError,
  ComposioConnectionExpiredError,
  ComposioRateLimitError,
  FbBudgetExceeded,
} from '../../../_lib/composio.js';
import { FbError } from './errors.js';
import {
  _resetPublisher,
  buildPublishCall,
  classifyFailure,
  deleteRemote,
  getPublisherState,
  permalinkFor,
  publishNow,
  publisherTick,
  publishToFacebook,
  sanitizeError,
  startPublisher,
} from './publisher.js';
import { STUCK_MESSAGE } from './state.js';
import { makePage, seedContent } from './test-fixtures.js';


const T0 = Date.UTC(2026, 9, 20, 5, 0, 0) / 1000; // 12:00 Vietnam time
const MIN = 60;

function media(name: string, size = 4): string {
  const file = path.join(mocks.mediaDir, '1', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(size, 1));
  return file;
}

function scheduled(patch: Parameters<typeof seedContent>[0] = {}): number {
  return seedContent({ status: 'scheduled', scheduled_at: T0, ...patch });
}

function row(id: number) {
  const r = getFbContent(id);
  if (!r) throw new Error('row missing');
  return r;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0 * 1000);
  _initTestDatabase(':memory:');
  fs.rmSync(path.dirname(mocks.mediaDir), { recursive: true, force: true });
  _resetPublisher();
  mocks.execute.mockReset();
  mocks.graphProxy.mockReset();
  mocks.notify.mockClear();
  mocks.hasKey.mockReturnValue(true);
  mocks.killSwitchOn.mockReturnValue(true);
  setFbSetting('enabled', '1');
  makePage('p1');
  mocks.execute.mockResolvedValue({ id: '111_222' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildPublishCall', () => {
  const base = { pageId: 'p1', caption: 'Xin chào', linkUrl: '', media: [] as Array<{ path: string; kind: 'video' | 'image' }> };

  it('text and link posts use FACEBOOK_CREATE_POST', () => {
    const text = buildPublishCall({ ...base, format: 'text' });
    expect(text).toEqual({ tool: 'FACEBOOK_CREATE_POST', args: { page_id: 'p1', published: true, message: 'Xin chào' }, publishedAs: 'text' });
    const link = buildPublishCall({ ...base, format: 'link', linkUrl: ' https://x.vn ', caption: '' });
    expect(link.args).toEqual({ page_id: 'p1', published: true, link: 'https://x.vn' });
    expect(link.publishedAs).toBe('link');
  });

  it('photos pass the local path and never schedule on Facebook', () => {
    const call = buildPublishCall({ ...base, format: 'photo', media: [{ path: '/m/1/a.jpg', kind: 'image' }] });
    expect(call.tool).toBe('FACEBOOK_CREATE_PHOTO_POST');
    expect(call.args).toEqual({ page_id: 'p1', photo: '/m/1/a.jpg', published: true, message: 'Xin chào' });
    expect(call.args).not.toHaveProperty('scheduled_publish_time');
  });

  it('videos and reels both post as a normal video', () => {
    for (const format of ['video', 'reel'] as const) {
      const call = buildPublishCall({ ...base, format, media: [{ path: '/m/1/a.mp4', kind: 'video' }] });
      expect(call.tool).toBe('FACEBOOK_CREATE_VIDEO_POST');
      expect(call.args).toEqual({ page_id: 'p1', video: '/m/1/a.mp4', published: true, description: 'Xin chào' });
      expect(call.publishedAs).toBe('video');
    }
  });

  it('builds permalinks', () => {
    expect(permalinkFor('p1', '999_111', 'photo')).toBe('https://www.facebook.com/999/posts/111');
    expect(permalinkFor('p1', '555', 'video')).toBe('https://www.facebook.com/p1/videos/555');
    expect(permalinkFor('p1', null, 'text')).toBe('');
  });
});

describe('publishToFacebook', () => {
  it('uploads an album unpublished, then posts one feed entry with the photos attached', async () => {
    const a = media('a.jpg');
    const b = media('b.jpg');
    mocks.execute.mockResolvedValueOnce({ data: { photos: [{ id: '10' }, { id: '11' }] } });
    mocks.graphProxy.mockResolvedValueOnce({ status: 200, data: { id: '999_5' } });
    const id = seedContent({ format: 'album', caption: 'Album', media_json: JSON.stringify([{ path: a, kind: 'image' }, { path: b, kind: 'image' }]) });
    const res = await publishToFacebook(row(id), getFbPage('p1')!, [{ path: a, kind: 'image' }, { path: b, kind: 'image' }]);
    expect(mocks.execute).toHaveBeenCalledWith('FACEBOOK_UPLOAD_PHOTOS_BATCH', { page_id: 'p1', photos: [a, b], published: false }, expect.objectContaining({ area: 'publish' }));
    expect(mocks.graphProxy).toHaveBeenCalledWith(
      'p1',
      { path: '/p1/feed', method: 'POST', body: { attached_media: [{ media_fbid: '10' }, { media_fbid: '11' }], published: true, message: 'Album' } },
      expect.objectContaining({ connectionId: 'ca_p1' }),
    );
    expect(res).toMatchObject({ postId: '999_5', publishedAs: 'album' });
  });

  it('does not publish anything when the photo ids cannot be read', async () => {
    const a = media('a.jpg');
    const b = media('b.jpg');
    mocks.execute.mockResolvedValueOnce({ weird: true });
    const id = seedContent({ format: 'album' });
    await expect(publishToFacebook(row(id), getFbPage('p1')!, [{ path: a, kind: 'image' }, { path: b, kind: 'image' }])).rejects.toBeInstanceOf(FbError);
    expect(mocks.graphProxy).not.toHaveBeenCalled();
  });

  it('posts a one-photo album as a photo', async () => {
    const a = media('a.jpg');
    const id = seedContent({ format: 'album' });
    const res = await publishToFacebook(row(id), getFbPage('p1')!, [{ path: a, kind: 'image' }]);
    expect(mocks.execute.mock.calls[0][0]).toBe('FACEBOOK_CREATE_PHOTO_POST');
    expect(res.publishedAs).toBe('photo');
  });
});

describe('classifyFailure / sanitizeError', () => {
  it('maps typed errors', () => {
    expect(classifyFailure(new FbBudgetExceeded(10, 10)).kind).toBe('defer');
    expect(classifyFailure(new ComposioConnectionExpiredError()).kind).toBe('expired');
    expect(classifyFailure(new ComposioRateLimitError()).kind).toBe('retryable');
    expect(classifyFailure(new ComposioAuthError()).kind).toBe('fatal');
    expect(classifyFailure(new Error('HTTP 502 Bad Gateway')).kind).toBe('retryable');
    expect(classifyFailure(new Error('(#100) Invalid parameter')).kind).toBe('fatal');
    expect(classifyFailure(new FbError(400, 'Thiếu tệp')).kind).toBe('fatal');
  });

  it('redacts tokens and bounds the length', () => {
    const msg = sanitizeError(new Error(`bad access_token=EAAB${'x'.repeat(40)} and "access_token":"abcdef123"`));
    expect(msg).not.toMatch(/EAAB/);
    expect(msg).not.toMatch(/abcdef123/);
    expect(sanitizeError('y'.repeat(1000)).length).toBe(300);
  });
});

describe('publisherTick', () => {
  it('publishes a due text post, records it and logs the attempt', async () => {
    const id = scheduled({ caption: 'Hello' });
    await publisherTick();
    const r = row(id);
    expect(r.status).toBe('published');
    expect(r.fb_post_id).toBe('111_222');
    expect(r.permalink).toBe('https://www.facebook.com/111/posts/222');
    expect(r.published_as).toBe('text');
    expect(r.attempts).toBe(1);
    expect(r.published_at).toBe(T0);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const log = listFbPublishLog(id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: 'publish', tool: 'FACEBOOK_CREATE_POST', ok: 1, detail: '111_222' });
    expect(getPublisherState().lastTickAt).toBe(T0);
  });

  it('publishes a video from the local media dir', async () => {
    const file = media('clip.mp4');
    const id = scheduled({ format: 'video', media_json: JSON.stringify([{ path: file, kind: 'video' }]) });
    mocks.execute.mockResolvedValue({ id: '777' });
    await publisherTick();
    expect(mocks.execute).toHaveBeenCalledWith(
      'FACEBOOK_CREATE_VIDEO_POST',
      { page_id: 'p1', video: file, published: true, description: 'Nội dung' },
      { area: 'publish', connectionId: 'ca_p1', entityId: 'ent1' },
    );
    expect(row(id)).toMatchObject({ status: 'published', published_as: 'video', permalink: 'https://www.facebook.com/p1/videos/777' });
  });

  it('fails a post whose media file is missing without calling Facebook', async () => {
    const id = scheduled({ format: 'photo', media_json: JSON.stringify([{ path: path.join(mocks.mediaDir, '1', 'gone.jpg'), kind: 'image' }]) });
    await publisherTick();
    expect(row(id).status).toBe('failed');
    expect(row(id).last_error).toMatch(/Không tìm thấy tệp/);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it('leaves posts that are not due yet alone', async () => {
    const future = scheduled({ scheduled_at: T0 + 10 * MIN });
    const waiting = scheduled({ attempts: 1, next_attempt_at: T0 + 2 * MIN });
    const draft = seedContent({ status: 'approved', scheduled_at: T0 - MIN });
    await publisherTick();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(row(future).status).toBe('scheduled');
    expect(row(waiting).status).toBe('scheduled');
    expect(row(draft).status).toBe('approved');
  });

  it('publishes within the grace window and marks later first attempts missed', async () => {
    const ok = scheduled({ scheduled_at: T0 - 29 * MIN });
    const late = scheduled({ scheduled_at: T0 - 31 * MIN });
    await publisherTick();
    expect(row(ok).status).toBe('published');
    expect(row(late).status).toBe('missed');
    expect(row(late).last_error).toMatch(/không đăng muộn/);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toMatch(/lỡ giờ đăng/);
    expect(listFbPublishLog(late)[0].action).toBe('missed');
  });

  it('honours a per-Page grace window', async () => {
    updateFbPageFields('p1', { grace_minutes: 5 });
    const id = scheduled({ scheduled_at: T0 - 6 * MIN });
    await publisherTick();
    expect(row(id).status).toBe('missed');
  });

  it('retries transient failures after 2, 5 and 15 minutes, then fails and notifies', async () => {
    mocks.execute.mockRejectedValue(new Error('Request failed with status 503'));
    const id = scheduled();
    const delays = [2, 5, 15];
    for (let i = 0; i < 3; i++) {
      await publisherTick();
      const r = row(id);
      expect(r.status).toBe('scheduled');
      expect(r.attempts).toBe(i + 1);
      expect(r.next_attempt_at).toBe(Math.floor(Date.now() / 1000) + delays[i] * MIN);
      // not retried before its time
      vi.setSystemTime(Date.now() + (delays[i] * MIN - 1) * 1000);
      await publisherTick();
      expect(mocks.execute).toHaveBeenCalledTimes(i + 1);
      vi.setSystemTime(Date.now() + 1000);
    }
    await publisherTick();
    const r = row(id);
    expect(r.status).toBe('failed');
    expect(r.attempts).toBe(4);
    expect(r.last_error).toMatch(/lỗi tạm thời/);
    expect(mocks.execute).toHaveBeenCalledTimes(4);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(listFbPublishLog(id)).toHaveLength(4);
  });

  it('does not apply the grace window to retries', async () => {
    mocks.execute.mockRejectedValueOnce(new ComposioRateLimitError('slow down'));
    const id = scheduled();
    await publisherTick();
    expect(row(id).status).toBe('scheduled');
    vi.setSystemTime((T0 + 45 * MIN) * 1000); // far past the 30 minute grace
    await publisherTick();
    expect(row(id).status).toBe('published');
  });

  it('fails permanent errors at once', async () => {
    mocks.execute.mockRejectedValue(new Error('(#100) Invalid parameter'));
    const id = scheduled();
    await publisherTick();
    expect(row(id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('marks the Page EXPIRED on an expired connection, notifies once and holds the other posts', async () => {
    mocks.execute.mockRejectedValue(new ComposioConnectionExpiredError());
    const first = scheduled({ scheduled_at: T0 - MIN });
    const second = scheduled();
    await publisherTick();
    expect(row(first).status).toBe('failed');
    expect(getFbPage('p1')?.status).toBe('EXPIRED');
    // the Page is expired now, so the next post is not sent and keeps waiting
    expect(row(second).status).toBe('scheduled');
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const pageNotices = mocks.notify.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith('Kết nối Facebook của Fanpage'));
    expect(pageNotices).toHaveLength(1);
    expect(mocks.notify).toHaveBeenCalledTimes(2); // one for the Page, one for the failed post
  });

  it('keeps posts of an expired or disabled Page waiting, then marks them missed after the grace window', async () => {
    updateFbPageFields('p1', { status: 'EXPIRED' });
    const id = scheduled({ scheduled_at: T0 - 5 * MIN });
    await publisherTick();
    expect(row(id).status).toBe('scheduled');
    expect(mocks.execute).not.toHaveBeenCalled();
    vi.setSystemTime((T0 + 40 * MIN) * 1000);
    await publisherTick();
    expect(row(id).status).toBe('missed');

    updateFbPageFields('p1', { status: 'ACTIVE', enabled: 0 });
    const id2 = scheduled({ scheduled_at: Math.floor(Date.now() / 1000) - MIN });
    await publisherTick();
    expect(row(id2).status).toBe('scheduled');
  });

  it('puts a claim back without counting an attempt when the API budget is spent', async () => {
    mocks.execute.mockRejectedValue(new FbBudgetExceeded(600, 600));
    const id = scheduled();
    await publisherTick();
    const r = row(id);
    expect(r.status).toBe('scheduled');
    expect(r.attempts).toBe(0);
    expect(r.next_attempt_at).toBe(T0 + 60);
    expect(mocks.notify).not.toHaveBeenCalled();
    // due again a minute later
    mocks.execute.mockResolvedValue({ id: '5_6' });
    vi.setSystemTime((T0 + 61) * 1000);
    await publisherTick();
    expect(row(id).status).toBe('published');
  });

  it('claims atomically: a row can only be claimed once', () => {
    const id = scheduled();
    expect(claimFbContent(id, ['scheduled'])).toBe(true);
    expect(claimFbContent(id, ['scheduled'])).toBe(false);
    expect(row(id)).toMatchObject({ status: 'publishing', attempts: 1 });
  });

  it('skips rows another process already claimed', async () => {
    const id = scheduled();
    claimFbContent(id, ['scheduled']);
    await publisherTick();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(row(id).status).toBe('publishing');
  });

  it('does not overlap ticks', async () => {
    let release: (v: unknown) => void = () => {};
    mocks.execute.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    scheduled();
    const first = publisherTick();
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
    await publisherTick(); // returns immediately: a tick is in flight
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    release({ id: '1_2' });
    await first;
  });

  it('respects the studio switch, the kill switch and a missing key', async () => {
    const id = scheduled();
    setFbSetting('enabled', '0');
    await publisherTick();
    setFbSetting('enabled', '1');
    mocks.killSwitchOn.mockReturnValue(false);
    await publisherTick();
    mocks.killSwitchOn.mockReturnValue(true);
    mocks.hasKey.mockReturnValue(false);
    await publisherTick();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(row(id).status).toBe('scheduled');
    mocks.hasKey.mockReturnValue(true);
    await publisherTick();
    expect(row(id).status).toBe('published');
  });

  it('fails rows stuck in publishing for over 10 minutes and never reposts them', async () => {
    const stuck = seedContent({ status: 'publishing', scheduled_at: T0 - 20 * MIN, attempts: 1 });
    const fresh = seedContent({ status: 'publishing', scheduled_at: T0 - 5 * MIN, attempts: 1 });
    // updated_at is the claim time
    updateFbContentFields(stuck, { status: 'publishing' });
    vi.setSystemTime((T0 + 11 * MIN) * 1000);
    updateFbContentFields(fresh, { status: 'publishing' }); // touch: claimed just now
    await publisherTick();
    expect(row(stuck)).toMatchObject({ status: 'failed', last_error: STUCK_MESSAGE });
    expect(row(fresh).status).toBe('publishing');
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(listFbPublishLog(stuck)[0].action).toBe('recover');
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });
});

describe('startPublisher', () => {
  it('starts one worker and reports it as running only while enabled', () => {
    expect(getPublisherState().running).toBe(false);
    startPublisher();
    startPublisher();
    expect(getPublisherState().running).toBe(true);
    setFbSetting('enabled', '0');
    expect(getPublisherState().running).toBe(false);
    _resetPublisher();
  });
});

describe('publishNow', () => {
  it('claims, returns publishing and finishes in the background', async () => {
    const id = seedContent({ status: 'approved' });
    const dto = await publishNow(id);
    expect(dto.status).toBe('publishing');
    await vi.waitFor(() => expect(row(id).status).toBe('published'));
    expect(row(id).attempts).toBe(1);
  });

  it('restarts the attempt count for failed and missed posts', async () => {
    const id = seedContent({ status: 'failed', attempts: 4, last_error: 'x' });
    await publishNow(id);
    await vi.waitFor(() => expect(row(id).status).toBe('published'));
    expect(row(id)).toMatchObject({ attempts: 1, last_error: '' });
  });

  it('refuses wrong states, a missing key, a disabled or expired Page and incomplete posts', async () => {
    await expect(publishNow(seedContent({ status: 'review' }))).rejects.toMatchObject({ status: 409 });
    await expect(publishNow(seedContent({ status: 'published' }))).rejects.toMatchObject({ status: 409 });
    await expect(publishNow(seedContent({ status: 'publishing' }))).rejects.toMatchObject({ status: 409 });
    await expect(publishNow(99999)).rejects.toMatchObject({ status: 404 });
    await expect(publishNow(seedContent({ status: 'approved', format: 'video' }))).rejects.toMatchObject({ status: 400 });
    mocks.hasKey.mockReturnValue(false);
    await expect(publishNow(seedContent({ status: 'approved' }))).rejects.toMatchObject({ status: 503 });
    mocks.hasKey.mockReturnValue(true);
    updateFbPageFields('p1', { enabled: 0 });
    await expect(publishNow(seedContent({ status: 'approved' }))).rejects.toMatchObject({ status: 409 });
    updateFbPageFields('p1', { enabled: 1, status: 'EXPIRED' });
    await expect(publishNow(seedContent({ status: 'approved' }))).rejects.toMatchObject({ status: 409 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('refuses while the publish kill switch is off', async () => {
    mocks.killSwitchOn.mockReturnValue(false);
    const id = seedContent({ status: 'approved' });
    await expect(publishNow(id)).rejects.toMatchObject({ status: 409 });
    expect(row(id).status).toBe('approved');
  });

  it('releases the claim when the budget is spent', async () => {
    mocks.execute.mockRejectedValue(new FbBudgetExceeded(600, 600));
    const id = seedContent({ status: 'approved' });
    await publishNow(id);
    await vi.waitFor(() => expect(row(id).status).toBe('approved'));
    expect(row(id).attempts).toBe(0);
    expect(row(id).scheduled_at).toBeNull();
    expect(row(id).last_error).toMatch(/ngân sách/);
  });
});

describe('deleteRemote', () => {
  it('deletes on Facebook and marks the row deleted', async () => {
    const id = seedContent({ status: 'published', fb_post_id: '999_111' });
    mocks.graphProxy.mockResolvedValue({ status: 200, data: { success: true } });
    const dto = await deleteRemote(id);
    expect(dto.status).toBe('deleted');
    expect(mocks.graphProxy).toHaveBeenCalledWith(expect.any(String), { method: 'DELETE', path: '/999_111' }, expect.objectContaining({ connectionId: 'ca_p1' }));
    expect(listFbPublishLog(id)[0]).toMatchObject({ action: 'delete_remote', ok: 1 });
  });

  it('refuses posts that are not published or have no Facebook id', async () => {
    await expect(deleteRemote(seedContent({ status: 'scheduled' }))).rejects.toMatchObject({ status: 409 });
    await expect(deleteRemote(seedContent({ status: 'published', fb_post_id: null }))).rejects.toMatchObject({ status: 409 });
    mocks.hasKey.mockReturnValue(false);
    await expect(deleteRemote(seedContent({ status: 'published', fb_post_id: '1_1' }))).rejects.toMatchObject({ status: 503 });
  });

  it('treats an already removed post as deleted, but surfaces other errors', async () => {
    const gone = seedContent({ status: 'published', fb_post_id: '1_1' });
    mocks.graphProxy.mockRejectedValueOnce(new Error('Object with ID 1_1 does not exist'));
    expect((await deleteRemote(gone)).status).toBe('deleted');

    const bad = seedContent({ status: 'published', fb_post_id: '2_2' });
    mocks.graphProxy.mockRejectedValueOnce(new Error('(#200) Permissions error'));
    await expect(deleteRemote(bad)).rejects.toMatchObject({ status: 502 });
    expect(row(bad).status).toBe('published');
    expect(listFbPublishLog(bad)[0].ok).toBe(0);
  });

  it('expires the Page on an expired connection', async () => {
    const id = seedContent({ status: 'published', fb_post_id: '3_3' });
    mocks.graphProxy.mockRejectedValueOnce(new ComposioConnectionExpiredError());
    await expect(deleteRemote(id)).rejects.toMatchObject({ status: 409 });
    expect(getFbPage('p1')?.status).toBe('EXPIRED');
    expect(row(id).status).toBe('published');
  });
});
