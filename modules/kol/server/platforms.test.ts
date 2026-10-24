import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ kill: true }));
vi.mock('./compat.js', async (orig) => ({ ...(await orig<typeof import('./compat.js')>()), isEnabled: () => h.kill }));

import { _setFbBridgeForTests } from './fb-bridge.js';
import { _initTestDatabase, addFbPage, setFbPage, getFbContent, setFbSetting, updateFbContentFields } from './test-db.js';
import type { AccountRow } from './accounts.js';
import { ComposioRateLimitError, UncertainOutcomeError, _setToolExecutor, type ToolExecutor } from './composio-exec.js';
import { kolDb } from './core.js';
import { fbFormatOf } from './platforms/facebook.js';
import { ADAPTERS, parseRef, serializeRef, type PublishContext } from './platforms/index.js';
import { safePostId, tiktokPermalink } from './platforms/tiktok.js';
import type { PostRow, TargetRow } from './posts.js';
import type { StagedMedia } from './stage.js';
import type { PersonaDto, Platform, PostDto } from './types.js';

const T0 = Date.UTC(2026, 9, 20, 5, 0, 0) / 1000;

function account(platform: Platform, over: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'acc1', persona_id: 'p1', platform, connection_id: 'ca_1', entity_id: 'user_1', external_id: platform === 'facebook' ? 'page1' : '1784',
    handle: '@mai.ai', display_name: 'Mai', picture_url: '', enabled: 1, auto_publish: 0, max_posts_per_day: 2, min_gap_minutes: 180,
    window_start: '08:00', window_end: '22:00', timezone: 'Asia/Ho_Chi_Minh', tiktok_privacy: 'SELF_ONLY', youtube_privacy: 'public',
    youtube_category: '22', status: 'ACTIVE', followers: null, followers_at: null, created_at: T0, updated_at: T0, ...over,
  };
}

const target = (platform: Platform, over: Partial<TargetRow> = {}): TargetRow => ({
  id: 'tgt1', post_id: 'post1', account_id: 'acc1', platform, status: 'publishing', external_id: null, permalink: '', fb_content_id: null,
  publish_ref: null, error: '', attempts: 1, next_attempt_at: null, published_at: null, updated_at: T0, ...over,
});

function post(over: Partial<PostDto> = {}): PostDto {
  return {
    id: 'post1', personaId: 'p1', title: 'Đà Lạt', pillar: 'Du lịch', format: 'photo', caption: 'Chiều nay', hashtags: ['dalat'], variants: {},
    assetIds: [], assets: [], status: 'scheduled', scheduledAt: T0, publishedAt: null, brief: '', source: 'owner', sourceRef: '', feedback: '',
    targets: [], createdAt: T0, updatedAt: T0, ...over,
  };
}

const postRow = (): PostRow => ({
  id: 'post1', persona_id: 'p1', title: 'Đà Lạt', pillar: '', format: 'reel', caption: '', hashtags_json: '[]', variants_json: '{}',
  asset_ids_json: '[]', status: 'publishing', scheduled_at: T0, published_at: null, brief: '', source: 'owner', source_ref: '', feedback: '',
  created_at: T0, updated_at: T0,
});

const persona = { id: 'p1', name: 'Mai', disclosureText: 'AI' } as PersonaDto;
const image = (n: number): StagedMedia => ({ path: `/media/kol/tgt1/0${n}.jpg`, kind: 'image', mime: 'image/jpeg', width: 1080, height: 1350, durationSec: null });
const video = (w = 1080, hgt = 1920, d = 20): StagedMedia => ({ path: '/media/kol/tgt1/01.mp4', kind: 'video', mime: 'video/mp4', width: w, height: hgt, durationSec: d });

function ctx(platform: Platform, over: Partial<PublishContext> = {}): PublishContext {
  return { target: target(platform), post: post(), account: account(platform), persona, media: [image(1)], caption: 'Chiều nay\n\n#dalat\n\nAI', now: T0, ...over };
}

/** A fake executor answering per slug from a script, recording every call. */
function fake(script: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: { slug: string; args: Record<string, unknown>; target: { connectionId: string; entityId: string } }[] = [];
  const exec: ToolExecutor = async (slug, args, t) => {
    calls.push({ slug, args, target: t });
    const fn = script[slug];
    if (!fn) throw new Error(`unexpected tool ${slug}`);
    return fn(args);
  };
  _setToolExecutor(exec);
  return calls;
}

afterEach(() => _setToolExecutor(null));

describe('publish refs', () => {
  it('round-trips and rejects junk', () => {
    expect(parseRef(serializeRef({ id: '17', since: T0 }))).toEqual({ id: '17', since: T0 });
    expect(parseRef('{"id":1}')).toBeNull();
    expect(parseRef('nope')).toBeNull();
    expect(parseRef(null)).toBeNull();
  });
});

describe('instagram', () => {
  it('photo: container with image_file + caption → publish (60 s) → permalink', async () => {
    const calls = fake({
      INSTAGRAM_POST_IG_USER_MEDIA: () => ({ data: { id: 'c1' } }),
      INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH: () => ({ id: 'm1' }),
      INSTAGRAM_GET_IG_MEDIA: () => ({ id: 'm1', permalink: 'https://www.instagram.com/p/abc/' }),
    });
    const out = await ADAPTERS.instagram.publish(ctx('instagram'));
    expect(out).toEqual({ kind: 'published', externalId: 'm1', permalink: 'https://www.instagram.com/p/abc/' });
    expect(calls.map((c) => c.slug)).toEqual(['INSTAGRAM_POST_IG_USER_MEDIA', 'INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH', 'INSTAGRAM_GET_IG_MEDIA']);
    expect(calls[0].args).toEqual({ ig_user_id: '1784', image_file: '/media/kol/tgt1/01.jpg', caption: 'Chiều nay\n\n#dalat\n\nAI' });
    expect(calls[1].args).toEqual({ ig_user_id: '1784', creation_id: 'c1', max_wait_seconds: 60 });
    expect(calls[0].target).toEqual({ connectionId: 'ca_1', entityId: 'user_1' });
  });

  it('carousel: CREATE_CAROUSEL_CONTAINER with child_image_files → publish', async () => {
    const calls = fake({
      INSTAGRAM_CREATE_CAROUSEL_CONTAINER: () => ({ id: 'car1' }),
      INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH: () => ({ id: 'm2' }),
      INSTAGRAM_GET_IG_MEDIA: () => { throw new Error('permalink read failed'); },
    });
    const out = await ADAPTERS.instagram.publish(ctx('instagram', { post: post({ format: 'carousel' }), media: [image(1), image(2), image(3)] }));
    expect(out).toEqual({ kind: 'published', externalId: 'm2', permalink: '' });
    expect(calls[0].args).toMatchObject({ child_image_files: ['/media/kol/tgt1/01.jpg', '/media/kol/tgt1/02.jpg', '/media/kol/tgt1/03.jpg'] });
    expect(calls[1].args).toMatchObject({ creation_id: 'car1' });
  });

  it('reel: container (REELS, share_to_feed) → processing; poll IN_PROGRESS → still processing; FINISHED → publish', async () => {
    let calls = fake({ INSTAGRAM_POST_IG_USER_MEDIA: () => ({ id: 'cr1' }) });
    const started = await ADAPTERS.instagram.publish(ctx('instagram', { post: post({ format: 'reel' }), media: [video()] }));
    expect(started).toEqual({ kind: 'processing', ref: { id: 'cr1', since: T0 } });
    expect(calls[0].args).toEqual({ ig_user_id: '1784', video_file: '/media/kol/tgt1/01.mp4', media_type: 'REELS', share_to_feed: true, caption: 'Chiều nay\n\n#dalat\n\nAI' });

    const pollCtx = { target: target('instagram'), post: postRow(), account: account('instagram'), ref: { id: 'cr1', since: T0 }, now: T0 + 120 };
    calls = fake({ INSTAGRAM_GET_POST_STATUS: () => ({ data: { status_code: 'IN_PROGRESS' } }) });
    expect(await ADAPTERS.instagram.poll(pollCtx)).toEqual({ kind: 'processing', ref: { id: 'cr1', since: T0 } });

    calls = fake({
      INSTAGRAM_GET_POST_STATUS: () => ({ status_code: 'FINISHED' }),
      INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH: () => ({ id: 'm3' }),
      INSTAGRAM_GET_IG_MEDIA: () => ({ permalink: 'https://www.instagram.com/reel/xyz/' }),
    });
    expect(await ADAPTERS.instagram.poll(pollCtx)).toEqual({ kind: 'published', externalId: 'm3', permalink: 'https://www.instagram.com/reel/xyz/' });
    expect(calls[1].args).toMatchObject({ creation_id: 'cr1', max_wait_seconds: 30 });
    expect(ADAPTERS.instagram.pollMutates).toBe(true);
  });

  it('reel poll: ERROR fails; FINISHED too late is not published; processing timeout', async () => {
    const base = { target: target('instagram'), post: postRow(), account: account('instagram'), ref: { id: 'cr1', since: T0 } };
    fake({ INSTAGRAM_GET_POST_STATUS: () => ({ status_code: 'ERROR', status: 'Error: unsupported codec' }) });
    expect(await ADAPTERS.instagram.poll({ ...base, now: T0 + 60 })).toMatchObject({ kind: 'failed', message: expect.stringContaining('ERROR') });
    const calls = fake({ INSTAGRAM_GET_POST_STATUS: () => ({ status_code: 'FINISHED' }) });
    expect(await ADAPTERS.instagram.poll({ ...base, now: T0 + 2 * 3600 })).toMatchObject({ kind: 'failed', message: expect.stringContaining('không được đăng muộn') });
    expect(calls.map((c) => c.slug)).toEqual(['INSTAGRAM_GET_POST_STATUS']);
    fake({ INSTAGRAM_GET_POST_STATUS: () => ({ status_code: 'IN_PROGRESS' }) });
    expect(await ADAPTERS.instagram.poll({ ...base, now: T0 + 2 * 3600 })).toMatchObject({ kind: 'failed' });
  });

  it('a server error on MEDIA_PUBLISH is an uncertain outcome; a rate limit is not', async () => {
    fake({
      INSTAGRAM_POST_IG_USER_MEDIA: () => ({ id: 'c1' }),
      INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH: () => { throw new Error('Request failed with status 502 Bad Gateway'); },
    });
    await expect(ADAPTERS.instagram.publish(ctx('instagram'))).rejects.toBeInstanceOf(UncertainOutcomeError);
    fake({
      INSTAGRAM_POST_IG_USER_MEDIA: () => ({ id: 'c1' }),
      INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH: () => { throw Object.assign(new Error('Too many requests'), { status: 429 }); },
    });
    await expect(ADAPTERS.instagram.publish(ctx('instagram'))).rejects.toBeInstanceOf(ComposioRateLimitError);
  });
});

describe('tiktok', () => {
  it('UPLOAD_VIDEO with publish, is_aigc and the account privacy → processing', async () => {
    const calls = fake({ TIKTOK_UPLOAD_VIDEO: () => ({ data: { publish_id: 'v_pub_1' } }) });
    const out = await ADAPTERS.tiktok.publish(ctx('tiktok', { post: post({ format: 'reel' }), media: [video()], account: account('tiktok', { tiktok_privacy: 'PUBLIC_TO_EVERYONE' }) }));
    expect(out).toEqual({ kind: 'processing', ref: { id: 'v_pub_1', since: T0 } });
    expect(calls[0].args).toEqual({
      file_to_upload: '/media/kol/tgt1/01.mp4', caption: 'Chiều nay\n\n#dalat\n\nAI', publish: true, is_aigc: true, privacy_level: 'PUBLIC_TO_EVERYONE',
    });
  });

  it('no publish_id → failed, uncertain (never retried)', async () => {
    fake({ TIKTOK_UPLOAD_VIDEO: () => ({ ok: true }) });
    expect(await ADAPTERS.tiktok.publish(ctx('tiktok', { media: [video()] }))).toMatchObject({ kind: 'failed', uncertain: true });
  });

  it('FETCH_PUBLISH_STATUS: processing, complete (permalink), failed', async () => {
    const base = { target: target('tiktok', { status: 'processing' }), post: postRow(), account: account('tiktok'), ref: { id: 'v_pub_1', since: T0 } };
    fake({ TIKTOK_FETCH_PUBLISH_STATUS: () => ({ data: { status: 'PROCESSING_UPLOAD' } }) });
    expect(await ADAPTERS.tiktok.poll({ ...base, now: T0 + 60 })).toMatchObject({ kind: 'processing' });
    const calls = fake({ TIKTOK_FETCH_PUBLISH_STATUS: () => ({ data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['7300000000000000001'] } }) });
    expect(await ADAPTERS.tiktok.poll({ ...base, now: T0 + 60 })).toEqual({
      kind: 'published', externalId: '7300000000000000001', permalink: 'https://www.tiktok.com/@mai.ai/video/7300000000000000001',
    });
    expect(calls[0].args).toEqual({ publish_id: 'v_pub_1' });
    fake({ TIKTOK_FETCH_PUBLISH_STATUS: () => ({ status: 'FAILED', fail_reason: 'duration_check_failed' }) });
    expect(await ADAPTERS.tiktok.poll({ ...base, now: T0 + 60 })).toMatchObject({ kind: 'failed', message: expect.stringContaining('duration_check_failed') });
    fake({ TIKTOK_FETCH_PUBLISH_STATUS: () => ({ status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [] }) });
    expect(await ADAPTERS.tiktok.poll({ ...base, now: T0 + 60 })).toMatchObject({ kind: 'published', externalId: null, permalink: 'https://www.tiktok.com/@mai.ai' });
    fake({ TIKTOK_FETCH_PUBLISH_STATUS: () => ({ status: 'PROCESSING_DOWNLOAD' }) });
    expect(await ADAPTERS.tiktok.poll({ ...base, now: T0 + 2 * 3600 })).toMatchObject({ kind: 'failed', uncertain: true });
  });

  it('ids that lost precision are not trusted', () => {
    expect(safePostId(7300000000000000001)).toBeNull();
    expect(safePostId(123)).toBe('123');
    expect(safePostId('7300000000000000001')).toBe('7300000000000000001');
    expect(tiktokPermalink('', '1')).toBe('');
  });
});

describe('youtube', () => {
  it('vertical ≤ 3 min → Short: #Shorts title, tags, category, privacy, shorts permalink', async () => {
    const calls = fake({ YOUTUBE_UPLOAD_VIDEO: () => ({ data: { id: 'yt123', kind: 'youtube#video' } }) });
    const p = post({ format: 'reel', title: 'Săn mây Đà Lạt', hashtags: ['#dalat', 'travel'] });
    const out = await ADAPTERS.youtube.publish(ctx('youtube', { post: p, media: [video()], account: account('youtube', { youtube_privacy: 'unlisted', youtube_category: '19' }) }));
    expect(out).toEqual({ kind: 'published', externalId: 'yt123', permalink: 'https://www.youtube.com/shorts/yt123' });
    expect(calls[0].args).toEqual({
      title: 'Săn mây Đà Lạt #Shorts', description: 'Chiều nay\n\n#dalat\n\nAI', tags: ['dalat', 'travel'], categoryId: '19',
      privacyStatus: 'unlisted', videoFilePath: '/media/kol/tgt1/01.mp4',
    });
  });

  it('landscape → watch URL, no #Shorts', async () => {
    const calls = fake({ YOUTUBE_UPLOAD_VIDEO: () => ({ id: 'yt9' }) });
    const out = await ADAPTERS.youtube.publish(ctx('youtube', { post: post({ format: 'video' }), media: [video(1920, 1080, 600)] }));
    expect(out).toMatchObject({ permalink: 'https://www.youtube.com/watch?v=yt9' });
    expect(calls[0].args.title).toBe('Đà Lạt');
  });
});

describe('facebook (Content Studio hand-off)', () => {
  beforeEach(() => {
    _initTestDatabase();
    h.kill = true;
    setFbSetting('enabled', '1');
    addFbPage({ id: 'page1' });
  });

  it('reports "cần bật module Marketing" when Marketing provides no bridge', async () => {
    _setFbBridgeForTests(null);
    expect(await ADAPTERS.facebook.publish(ctx('facebook'))).toMatchObject({ kind: 'failed', message: expect.stringContaining('Cần bật module Marketing') });
    expect(await ADAPTERS.facebook.poll({ target: target('facebook', { fb_content_id: 1 }), post: postRow(), account: account('facebook'), ref: { id: '1', since: T0 }, now: T0 })).toMatchObject({ kind: 'processing' });
  });

  it('format mapping', () => {
    expect(fbFormatOf('carousel', 3)).toBe('album');
    expect(fbFormatOf('photo', 2)).toBe('album');
    expect(fbFormatOf('photo', 1)).toBe('photo');
    expect(fbFormatOf('reel', 0)).toBe('reel');
  });

  it('creates a scheduled fb_content row (origin kol) with the staged media and caption', async () => {
    const out = await ADAPTERS.facebook.publish(ctx('facebook', { media: [image(1), image(2)] }));
    expect(out.kind).toBe('processing');
    const id = (out as { fbContentId: number }).fbContentId;
    const row = getFbContent(id)!;
    expect(row).toMatchObject({ page_id: 'page1', status: 'scheduled', scheduled_at: T0, format: 'album', source: 'kol', origin: 'kol', caption: 'Chiều nay\n\n#dalat\n\nAI', title: 'Đà Lạt' });
    expect(JSON.parse(row.media_json)).toEqual([
      { path: '/media/kol/tgt1/01.jpg', kind: 'image', width: 1080, height: 1350 },
      { path: '/media/kol/tgt1/02.jpg', kind: 'image', width: 1080, height: 1350 },
    ]);
  });

  it('refuses when Content Studio, the kill switch or the Page is off', async () => {
    setFbSetting('enabled', '0');
    expect(await ADAPTERS.facebook.publish(ctx('facebook'))).toMatchObject({ kind: 'failed', message: expect.stringContaining('Content Studio đang tắt') });
    setFbSetting('enabled', '1');
    h.kill = false;
    expect(await ADAPTERS.facebook.publish(ctx('facebook'))).toMatchObject({ kind: 'failed', message: expect.stringContaining('FB_PUBLISH_ENABLED') });
    h.kill = true;
    setFbPage('page1', { enabled: 0 });
    expect(await ADAPTERS.facebook.publish(ctx('facebook'))).toMatchObject({ kind: 'failed' });
  });

  it('mirrors the Content Studio row: scheduled/publishing → processing, then published / failed / missed', async () => {
    const out = await ADAPTERS.facebook.publish(ctx('facebook'));
    const id = (out as { fbContentId: number }).fbContentId;
    const poll = (now: number) => ADAPTERS.facebook.poll({ target: target('facebook', { status: 'processing', fb_content_id: id }), post: postRow(), account: account('facebook'), ref: { id: String(id), since: T0 }, now });
    expect(await poll(T0 + 30)).toMatchObject({ kind: 'processing' });
    updateFbContentFields(id, { status: 'publishing' });
    expect(await poll(T0 + 60)).toMatchObject({ kind: 'processing' });
    updateFbContentFields(id, { status: 'published', fb_post_id: '111_222', permalink: 'https://www.facebook.com/111/posts/222' });
    expect(await poll(T0 + 90)).toEqual({ kind: 'published', externalId: '111_222', permalink: 'https://www.facebook.com/111/posts/222' });
    updateFbContentFields(id, { status: 'failed', last_error: 'Facebook lỗi tạm thời' });
    expect(await poll(T0 + 90)).toEqual({ kind: 'failed', message: 'Facebook lỗi tạm thời' });
    updateFbContentFields(id, { status: 'missed', last_error: 'Quá giờ' });
    expect(await poll(T0 + 90)).toEqual({ kind: 'missed', message: 'Quá giờ' });
    updateFbContentFields(id, { status: 'draft' });
    expect(await poll(T0 + 90)).toMatchObject({ kind: 'failed', message: expect.stringContaining('gỡ lịch') });
  });

  it('an untouched hand-off past grace + 15 min becomes missed (both rows)', async () => {
    const out = await ADAPTERS.facebook.publish(ctx('facebook'));
    const id = (out as { fbContentId: number }).fbContentId;
    const res = await ADAPTERS.facebook.poll({ target: target('facebook', { fb_content_id: id }), post: postRow(), account: account('facebook'), ref: { id: String(id), since: T0 }, now: T0 + 46 * 60 });
    expect(res.kind).toBe('missed');
    expect(getFbContent(id)!.status).toBe('missed');
  });

  it('a deleted Content Studio row fails the target', async () => {
    const res = await ADAPTERS.facebook.poll({ target: target('facebook', { fb_content_id: 999 }), post: postRow(), account: account('facebook'), ref: { id: '999', since: T0 }, now: T0 });
    expect(res).toMatchObject({ kind: 'failed', message: expect.stringContaining('đã bị xóa') });
  });
});
