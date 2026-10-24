// Test helper: the compat test database plus an in-memory fake of Marketing's `kolBridge` provides
// (modules/_lib/kol-bridge.ts). Rows keep Marketing's snake_case column names so tests read like its tables.
import type { KolBridgeContent, MarketingKolBridge } from '../../_lib/kol-bridge.js';
import { _initTestDatabase as initCompat } from './compat.js';
import { _setFbBridgeForTests } from './fb-bridge.js';

type Row = Record<string, any>;
const fake = { pages: new Map<string, Row>(), contents: new Map<number, Row>(), settings: new Map<string, string>(), metrics: new Map<string, Row[]>(), seq: 0 };

const bridge: MarketingKolBridge = {
  getSetting: (k) => fake.settings.get(k),
  getPage(id) {
    const p = fake.pages.get(id);
    return p && {
      id: p.id, name: p.name, enabled: p.enabled === 1, status: p.status, graceMinutes: p.grace_minutes, followers: p.followers,
      connectionId: p.connection_id, entityId: p.entity_id, timezone: p.timezone, pictureUrl: p.picture_url,
    };
  },
  createContent(d) {
    const scheduled = typeof d.scheduledAt === 'number';
    return insertFbContent({
      page_id: d.pageId, title: d.title, caption: d.caption, format: d.format, pillar: d.pillar, media_json: JSON.stringify(d.media),
      status: scheduled ? 'scheduled' : 'review', scheduled_at: scheduled ? d.scheduledAt : null, source: 'kol', origin: 'kol',
    });
  },
  getContent(id): KolBridgeContent | undefined {
    const c = fake.contents.get(id);
    return c && { id: c.id, pageId: c.page_id, status: c.status, scheduledAt: c.scheduled_at, fbPostId: c.fb_post_id, permalink: c.permalink, lastError: c.last_error, attempts: c.attempts };
  },
  markContent: (id, p, only) => updateFbContentFields(id, { status: p.status, last_error: p.lastError }, only),
  withdrawContent(id) {
    if (!updateFbContentFields(id, { status: 'draft', scheduled_at: null }, ['scheduled', 'approved', 'draft', 'review'])) return !fake.contents.has(id);
    fake.contents.delete(id);
    return true;
  },
  getPostMetrics: (postId) => (fake.metrics.get(postId) ?? []).map((m) => ({
    capturedAt: m.captured_at, videoViews3s: m.video_views_3s, impressions: m.impressions, reactions: m.reactions,
    comments: m.comments, shares: m.shares, saves: m.saves, reach: m.reach,
  })),
};

export function _initTestDatabase(): void {
  initCompat();
  for (const m of [fake.pages, fake.contents, fake.settings, fake.metrics]) m.clear();
  fake.seq = 0;
  _setFbBridgeForTests(bridge);
}

export function addFbPage(row: Row): void {
  fake.pages.set(row.id, { name: 'Mai Page', connection_id: 'ca_fb', entity_id: 'u1', enabled: 1, status: 'ACTIVE', timezone: 'Asia/Ho_Chi_Minh', grace_minutes: 30, followers: null, picture_url: '', ...row });
}
export function setFbPage(id: string, patch: Row): void {
  fake.pages.set(id, { ...fake.pages.get(id)!, ...patch });
}
export function insertFbContent(row: Row): number {
  const id = ++fake.seq;
  fake.contents.set(id, { id, page_id: null, status: 'draft', scheduled_at: null, fb_post_id: null, permalink: '', last_error: '', attempts: 0, media_json: '[]', origin: 'studio', ...row });
  return id;
}
export const getFbContent = (id: number): Row | undefined => fake.contents.get(id);
export function updateFbContentFields(id: number, patch: Row, only?: string[]): boolean {
  const c = fake.contents.get(id);
  if (!c || (only?.length && !only.includes(c.status))) return false;
  Object.assign(c, patch);
  return true;
}
export function setFbSetting(key: string, value: string): void {
  fake.settings.set(key, value);
}
export function upsertFbPostMetrics(row: Row): void {
  fake.metrics.set(row.post_id, [...(fake.metrics.get(row.post_id) ?? []), row]);
}
