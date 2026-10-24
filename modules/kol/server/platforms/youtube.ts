/**
 * YouTube (video only): one YOUTUBE_UPLOAD_VIDEO call with the local file.
 * Title from the YouTube variant or the post title (≤ 100, " #Shorts" for a
 * vertical clip of at most 3 minutes), description = the full caption with
 * the disclosure, tags from the hashtags, the account's category and privacy.
 */

import { execTargetOf } from '../accounts.js';
import { youtubeTags, youtubeTitle } from '../captions.js';
import { executeTool, findString } from '../composio-exec.js';
import { isShort } from '../schedule-rules.js';
import type { PlatformAdapter, PublishOutcome } from './index.js';

export function youtubePermalink(videoId: string, short: boolean): string {
  return short ? `https://www.youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`;
}

export const youtubeAdapter: PlatformAdapter = {
  platform: 'youtube',
  pollMutates: false,

  async publish(ctx): Promise<PublishOutcome> {
    const video = ctx.media.find((m) => m.kind === 'video');
    if (!video) return { kind: 'failed', message: 'YouTube cần 1 video.' };
    const short = isShort(video);
    const res = await executeTool('YOUTUBE_UPLOAD_VIDEO', {
      title: youtubeTitle(ctx.post, short),
      description: ctx.caption,
      tags: youtubeTags(ctx.post),
      categoryId: ctx.account.youtube_category || '22',
      privacyStatus: ctx.account.youtube_privacy || 'public',
      videoFilePath: video.path,
    }, execTargetOf(ctx.account));
    const id = findString(res, ['id', 'videoId', 'video_id']);
    if (!id) {
      return { kind: 'published', externalId: null, permalink: '', note: 'Đã tải video lên nhưng không đọc được ID video, kiểm tra trên YouTube Studio.' };
    }
    return { kind: 'published', externalId: id, permalink: youtubePermalink(id, short) };
  },

  async poll(ctx): Promise<PublishOutcome> {
    // Uploads finish in one call; a processing YouTube target only exists after a crash mid-way.
    return { kind: 'failed', message: 'Không theo dõi được video YouTube này. Kiểm tra trên YouTube Studio trước khi thử lại.', uncertain: ctx.ref.id !== '' };
  },
};
