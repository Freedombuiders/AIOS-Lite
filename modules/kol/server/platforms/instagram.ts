/**
 * Instagram (Business/Creator accounts) through Composio, with local files:
 *  - photo:    INSTAGRAM_POST_IG_USER_MEDIA (image_file, caption) → creation id
 *              → INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH (max_wait_seconds 60)
 *  - carousel: INSTAGRAM_CREATE_CAROUSEL_CONTAINER (child_image_files, caption)
 *              → INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH (max_wait_seconds 60)
 *  - reel:     INSTAGRAM_POST_IG_USER_MEDIA (video_file, media_type REELS,
 *              share_to_feed) → 'processing'; later ticks poll
 *              INSTAGRAM_GET_POST_STATUS and publish once FINISHED.
 * The permalink comes from INSTAGRAM_GET_IG_MEDIA. A container is never
 * public until MEDIA_PUBLISH succeeds, so only that call can leave the
 * outcome unknown.
 */

import { execTargetOf } from '../accounts.js';
import {
  ComposioAuthError,
  ComposioConnectionExpiredError,
  ComposioRateLimitError,
  UncertainOutcomeError,
  executeTool,
  findString,
  type ExecTarget,
} from '../composio-exec.js';
import { PROCESSING_TIMEOUT_SEC, isTransientMessage, isUncertainMessage } from '../schedule-rules.js';
import type { PlatformAdapter, PublishOutcome } from './index.js';

const IMAGE_WAIT_SEC = 60;
const REEL_PUBLISH_WAIT_SEC = 30;

function creationIdOf(data: unknown): string {
  const id = findString(data, ['id', 'creation_id']);
  if (!id) throw new Error('Instagram không trả về mã container (creation id).');
  return id;
}

/**
 * MEDIA_PUBLISH is the call that makes the post public: a timeout or server
 * error there leaves the outcome unknown and must never be retried.
 */
async function publishContainer(igUserId: string, creationId: string, target: ExecTarget, waitSec: number): Promise<PublishOutcome> {
  let res: unknown;
  try {
    res = await executeTool('INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH', { ig_user_id: igUserId, creation_id: creationId, max_wait_seconds: waitSec }, target);
  } catch (err) {
    if (err instanceof ComposioConnectionExpiredError || err instanceof ComposioAuthError || err instanceof ComposioRateLimitError) throw err;
    const msg = String((err as Error)?.message ?? err);
    if (isUncertainMessage(msg) || isTransientMessage(msg)) throw new UncertainOutcomeError(msg);
    throw err;
  }
  const mediaId = findString(res, ['id', 'media_id']);
  let permalink = '';
  if (mediaId) {
    try {
      permalink = findString(await executeTool('INSTAGRAM_GET_IG_MEDIA', { ig_media_id: mediaId, fields: 'id,permalink' }, target), ['permalink']) ?? '';
    } catch {
      // Published already: a missing permalink is not a failure.
    }
  }
  return {
    kind: 'published',
    externalId: mediaId,
    permalink,
    ...(mediaId ? {} : { note: 'Đã đăng nhưng không đọc được ID bài từ Instagram, kiểm tra trên Instagram.' }),
  };
}

export const instagramAdapter: PlatformAdapter = {
  platform: 'instagram',
  pollMutates: true,

  async publish(ctx): Promise<PublishOutcome> {
    const target = execTargetOf(ctx.account);
    const ig = ctx.account.external_id;
    const images = ctx.media.filter((m) => m.kind === 'image');
    const video = ctx.media.find((m) => m.kind === 'video');

    if (ctx.post.format === 'carousel') {
      const created = await executeTool('INSTAGRAM_CREATE_CAROUSEL_CONTAINER', {
        ig_user_id: ig,
        child_image_files: images.map((m) => m.path),
        caption: ctx.caption,
      }, target);
      return publishContainer(ig, creationIdOf(created), target, IMAGE_WAIT_SEC);
    }

    if (ctx.post.format === 'reel' || ctx.post.format === 'video') {
      if (!video) return { kind: 'failed', message: 'Reel Instagram cần 1 video.' };
      const created = await executeTool('INSTAGRAM_POST_IG_USER_MEDIA', {
        ig_user_id: ig,
        video_file: video.path,
        media_type: 'REELS',
        share_to_feed: true,
        caption: ctx.caption,
      }, target);
      return { kind: 'processing', ref: { id: creationIdOf(created), since: ctx.now } };
    }

    if (!images[0]) return { kind: 'failed', message: 'Bài ảnh Instagram cần 1 ảnh.' };
    const created = await executeTool('INSTAGRAM_POST_IG_USER_MEDIA', { ig_user_id: ig, image_file: images[0].path, caption: ctx.caption }, target);
    return publishContainer(ig, creationIdOf(created), target, IMAGE_WAIT_SEC);
  },

  async poll(ctx): Promise<PublishOutcome> {
    const target = execTargetOf(ctx.account);
    const res = await executeTool('INSTAGRAM_GET_POST_STATUS', { creation_id: ctx.ref.id }, target);
    const code = (findString(res, ['status_code']) ?? findString(res, ['status']) ?? '').toUpperCase();
    const overdue = ctx.now - ctx.ref.since > PROCESSING_TIMEOUT_SEC;
    if (code === 'FINISHED') {
      // Never post late: a container that sat ready while publishing was off is dropped.
      if (overdue) return { kind: 'failed', message: 'Video Instagram đã sẵn sàng quá muộn (quá 60 phút) nên bài không được đăng muộn. Hãy đặt lại giờ.' };
      return publishContainer(ctx.account.external_id, ctx.ref.id, target, REEL_PUBLISH_WAIT_SEC);
    }
    if (code === 'PUBLISHED') {
      return { kind: 'published', externalId: null, permalink: '', note: 'Instagram báo video đã đăng nhưng không đọc được ID bài, kiểm tra trên Instagram.' };
    }
    if (code === 'ERROR' || code === 'EXPIRED') {
      const detail = findString(res, ['status']);
      return { kind: 'failed', message: `Instagram không xử lý được video (${code}${detail && detail.toUpperCase() !== code ? `: ${detail.slice(0, 160)}` : ''}). Bài chưa được đăng.` };
    }
    if (overdue) {
      return { kind: 'failed', message: 'Instagram xử lý video quá 60 phút nên bài chưa được đăng. Hãy thử lại sau.' };
    }
    return { kind: 'processing', ref: ctx.ref };
  },
};
