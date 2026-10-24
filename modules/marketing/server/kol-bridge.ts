// What KOL Studio may do in Marketing (provides.kolBridge). Backed by Marketing's own store; rows are
// never created as published, and only get a schedule when the owner approved the post in KOL Studio.
import type { MarketingKolBridge } from '../../_lib/kol-bridge.js';
import {
  deleteFbContentRow, getFbContent, getFbPage, getFbSetting, insertFbContent, listFbPostMetricsForPost, setFbContentOrigin, updateFbContentFields,
} from './store.js';

export function createKolBridge(): MarketingKolBridge {
  return {
    getSetting: (key) => getFbSetting(key),
    getPage(id) {
      const p = getFbPage(id);
      return p && {
        id: p.id, name: p.name, enabled: p.enabled === 1, status: p.status, graceMinutes: p.grace_minutes, followers: p.followers,
        connectionId: p.connection_id, entityId: p.entity_id, timezone: p.timezone, pictureUrl: p.picture_url,
      };
    },
    createContent(d) {
      const page = getFbPage(d.pageId);
      if (!page || page.enabled !== 1) throw new Error('Fanpage chưa được bật trong Marketing.');
      const scheduled = typeof d.scheduledAt === 'number';
      const id = insertFbContent({
        page_id: page.id, title: d.title, caption: d.caption, format: d.format, pillar: d.pillar,
        media_json: JSON.stringify(d.media ?? []), status: scheduled ? 'scheduled' : 'review',
        scheduled_at: scheduled ? d.scheduledAt : null, source: 'kol',
      });
      setFbContentOrigin(id, 'kol');
      return id;
    },
    getContent(id) {
      const c = getFbContent(id);
      return c && {
        id: c.id, pageId: c.page_id, status: c.status, scheduledAt: c.scheduled_at, fbPostId: c.fb_post_id,
        permalink: c.permalink, lastError: c.last_error, attempts: c.attempts,
      };
    },
    markContent: (id, patch, onlyStatuses) =>
      updateFbContentFields(id, { status: patch.status, last_error: patch.lastError, next_attempt_at: null }, onlyStatuses),
    withdrawContent(id) {
      if (!updateFbContentFields(id, { status: 'draft', scheduled_at: null }, ['scheduled', 'approved', 'draft', 'review'])) return !getFbContent(id);
      deleteFbContentRow(id);
      return true;
    },
    getPostMetrics: (postId) => listFbPostMetricsForPost(postId).map((m) => ({
      capturedAt: m.captured_at, videoViews3s: m.video_views_3s, impressions: m.impressions, reactions: m.reactions,
      comments: m.comments, shares: m.shares, saves: m.saves, reach: m.reach,
    })),
  };
}
