/**
 * Facebook: delegated to Facebook Content Studio. The target becomes an
 * fb_content row (status 'scheduled', origin 'kol') on the linked Page with
 * the staged media; Content Studio's own publisher posts it, and every KOL
 * tick mirrors that row's status, post id, permalink and error back into the
 * target. Analytics and comment AI then work for free.
 */

import { isEnabled } from '../compat.js';
import { fbBridge, NEEDS_MARKETING } from '../fb-bridge.js';
import type { PostFormat } from '../types.js';
import type { PlatformAdapter, PublishOutcome } from './index.js';

/** Content Studio format for a KOL post. */
export function fbFormatOf(format: PostFormat, images: number): 'photo' | 'album' | 'video' | 'reel' | 'text' {
  switch (format) {
    case 'carousel': return 'album';
    case 'photo': return images > 1 ? 'album' : 'photo';
    case 'reel': return 'reel';
    case 'video': return 'video';
    case 'text': return 'text';
  }
}

/** Extra minutes past Content Studio's own grace before an untouched hand-off is given up. */
const HANDOFF_SLACK_MIN = 15;

export const facebookAdapter: PlatformAdapter = {
  platform: 'facebook',
  pollMutates: false,

  async publish(ctx): Promise<PublishOutcome> {
    const bridge = fbBridge();
    if (!bridge) return { kind: 'failed', message: NEEDS_MARKETING };
    if (bridge.getSetting('enabled') !== '1') {
      return { kind: 'failed', message: 'Facebook Content Studio đang tắt nên không đăng được lên Fanpage. Bật lại ở Marketing › Pages rồi thử lại.' };
    }
    if (!isEnabled('FB_PUBLISH_ENABLED')) {
      return { kind: 'failed', message: 'Đăng bài Facebook đang bị tắt (công tắc FB_PUBLISH_ENABLED của module Marketing).' };
    }
    const page = bridge.getPage(ctx.account.external_id);
    if (!page || !page.enabled) return { kind: 'failed', message: 'Fanpage chưa được bật trong Marketing › Pages.' };
    if (page.status !== 'ACTIVE') return { kind: 'failed', message: `Kết nối Facebook của Fanpage "${page.name}" đã hết hạn. Đồng bộ lại ở Marketing › Pages.` };

    const images = ctx.media.filter((m) => m.kind === 'image').length;
    const media = ctx.media.map((m) => ({
      path: m.path,
      kind: m.kind,
      ...(m.width ? { width: m.width } : {}),
      ...(m.height ? { height: m.height } : {}),
      ...(m.durationSec ? { durationS: m.durationSec } : {}),
    }));
    // The owner already approved this post in KOL Studio, so it is queued for the approved time.
    const id = bridge.createContent({
      pageId: page.id,
      title: ctx.post.title || ctx.persona.name,
      caption: ctx.caption,
      format: fbFormatOf(ctx.post.format, images),
      pillar: ctx.post.pillar,
      media,
      scheduledAt: ctx.now,
    });
    return { kind: 'processing', ref: { id: String(id), since: ctx.now }, fbContentId: id };
  },

  async poll(ctx): Promise<PublishOutcome> {
    const bridge = fbBridge();
    if (!bridge) return { kind: 'processing', ref: ctx.ref };
    const fbId = ctx.target.fb_content_id ?? Number(ctx.ref.id);
    const row = Number.isInteger(fbId) ? bridge.getContent(fbId) : undefined;
    if (!row) return { kind: 'failed', message: 'Bài trong Facebook Content Studio đã bị xóa nên không đăng.' };
    switch (row.status) {
      case 'published':
        return {
          kind: 'published',
          externalId: row.fbPostId,
          permalink: row.permalink,
          ...(row.fbPostId ? {} : { note: row.lastError || 'Đã đăng nhưng không đọc được ID bài từ Facebook.' }),
        };
      case 'failed':
        return { kind: 'failed', message: row.lastError || 'Facebook Content Studio đăng thất bại.' };
      case 'missed':
        return { kind: 'missed', message: row.lastError || 'Facebook Content Studio lỡ giờ đăng.' };
      case 'deleted':
        return { kind: 'failed', message: 'Bài đã bị xóa trong Facebook Content Studio.' };
      case 'publishing':
        return { kind: 'processing', ref: ctx.ref };
      case 'scheduled': {
        const page = row.pageId ? bridge.getPage(row.pageId) : undefined;
        const limit = (row.scheduledAt ?? ctx.ref.since) + ((page?.graceMinutes ?? 30) + HANDOFF_SLACK_MIN) * 60;
        if (ctx.now > limit && row.attempts === 0) {
          const message = 'Facebook Content Studio không đăng bài đúng giờ (Studio đang tắt, Fanpage tắt hoặc FB_PUBLISH_ENABLED=false) nên bài không được đăng muộn.';
          if (bridge.markContent(row.id, { status: 'missed', lastError: message }, ['scheduled'])) {
            return { kind: 'missed', message };
          }
        }
        return { kind: 'processing', ref: ctx.ref };
      }
      default:
        return { kind: 'failed', message: 'Bài đã bị gỡ lịch trong Facebook Content Studio.' };
    }
  },
};
