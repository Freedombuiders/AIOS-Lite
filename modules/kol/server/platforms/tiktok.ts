/**
 * TikTok (video only): TIKTOK_UPLOAD_VIDEO with the local file, the caption,
 * `publish: true`, `is_aigc: true` (AI disclosure label) and the account's
 * privacy level (SELF_ONLY until TikTok audits the app) → publish_id →
 * 'processing'; later ticks read TIKTOK_FETCH_PUBLISH_STATUS until
 * PUBLISH_COMPLETE or FAILED.
 */

import { execTargetOf } from '../accounts.js';
import { asArr, executeTool, findRecord, findString } from '../composio-exec.js';
import { PROCESSING_TIMEOUT_SEC, UNCERTAIN_MESSAGE } from '../schedule-rules.js';
import type { PlatformAdapter, PublishOutcome } from './index.js';

/** A TikTok post id we can trust (large numeric ids lose precision when they arrive as JSON numbers). */
export function safePostId(v: unknown): string | null {
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return v.trim();
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return String(v);
  return null;
}

export function tiktokPermalink(handle: string, postId: string | null): string {
  const user = handle.replace(/^@/, '').trim();
  if (!user) return '';
  return postId ? `https://www.tiktok.com/@${user}/video/${postId}` : `https://www.tiktok.com/@${user}`;
}

export const tiktokAdapter: PlatformAdapter = {
  platform: 'tiktok',
  pollMutates: false,

  async publish(ctx): Promise<PublishOutcome> {
    const video = ctx.media.find((m) => m.kind === 'video');
    if (!video) return { kind: 'failed', message: 'TikTok cần 1 video.' };
    const res = await executeTool('TIKTOK_UPLOAD_VIDEO', {
      file_to_upload: video.path,
      caption: ctx.caption,
      publish: true,
      is_aigc: true,
      privacy_level: ctx.account.tiktok_privacy || 'SELF_ONLY',
    }, execTargetOf(ctx.account));
    const publishId = findString(res, ['publish_id']);
    // The upload went through but there is nothing to follow: it may or may not be live.
    if (!publishId) return { kind: 'failed', message: UNCERTAIN_MESSAGE, uncertain: true };
    return { kind: 'processing', ref: { id: publishId, since: ctx.now } };
  },

  async poll(ctx): Promise<PublishOutcome> {
    const res = await executeTool('TIKTOK_FETCH_PUBLISH_STATUS', { publish_id: ctx.ref.id }, execTargetOf(ctx.account));
    const rec = findRecord(res, ['status']) ?? {};
    const status = String(rec.status ?? '').toUpperCase();
    if (status === 'PUBLISH_COMPLETE') {
      const ids = asArr(rec.publicaly_available_post_id ?? rec.publicly_available_post_id);
      const postId = safePostId(ids[0]);
      return {
        kind: 'published',
        externalId: postId,
        permalink: tiktokPermalink(ctx.account.handle, postId),
        ...(postId ? {} : { note: ctx.account.tiktok_privacy === 'SELF_ONLY' ? 'Video đăng ở chế độ riêng tư (chỉ mình tôi).' : 'TikTok chưa trả về mã video công khai.' }),
      };
    }
    if (status === 'FAILED') {
      const reason = findString(res, ['fail_reason']) ?? 'không rõ lý do';
      return { kind: 'failed', message: `TikTok từ chối video: ${reason.slice(0, 200)}. Bài chưa được đăng.` };
    }
    if (status === 'SEND_TO_USER_INBOX') {
      return { kind: 'failed', message: 'TikTok đưa video vào hộp thư nháp của tài khoản thay vì đăng. Mở ứng dụng TikTok để đăng tay.' };
    }
    if (ctx.now - ctx.ref.since > PROCESSING_TIMEOUT_SEC) {
      return { kind: 'failed', message: `TikTok chưa xác nhận sau 60 phút. ${UNCERTAIN_MESSAGE}.`, uncertain: true };
    }
    return { kind: 'processing', ref: ctx.ref };
  },
};
