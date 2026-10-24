/**
 * Contract between the marketing module (provides it as `kolBridge`) and KOL Studio (reads it through
 * `ctx.modules.get('marketing')`). Neither module imports the other's code; this file is the only shared piece.
 * Marketing keeps its own rules: nothing created through the bridge is published directly.
 */
export interface KolBridgePage {
  id: string;
  name: string;
  enabled: boolean;
  status: string;
  graceMinutes: number;
  followers: number | null;
  connectionId: string;
  entityId: string;
  timezone: string;
  pictureUrl: string;
}

export interface KolBridgeContent {
  id: number;
  pageId: string | null;
  status: string;
  scheduledAt: number | null;
  fbPostId: string | null;
  permalink: string;
  lastError: string;
  attempts: number;
}

export interface KolBridgeMetric {
  capturedAt: number;
  videoViews3s: number | null;
  impressions: number | null;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reach: number | null;
}

export interface KolBridgeDraft {
  pageId: string;
  title: string;
  caption: string;
  format: string;
  pillar: string;
  media: unknown[];
  /** Unix seconds the owner approved in KOL Studio; the row is scheduled for it. Without it the row waits in review. */
  scheduledAt?: number;
}

export interface MarketingKolBridge {
  /** A Marketing setting (e.g. 'enabled' = '1'), undefined when unset. */
  getSetting(key: string): string | undefined;
  getPage(id: string): KolBridgePage | undefined;
  /** Creates a content row with origin 'kol'. Scheduled only when `scheduledAt` is given, else 'review'. Returns its id. */
  createContent(draft: KolBridgeDraft): number;
  getContent(id: number): KolBridgeContent | undefined;
  /** Compare-and-set to a non-publishing state; false when the row changed meanwhile. */
  markContent(id: number, patch: { status: 'missed'; lastError: string }, onlyStatuses?: string[]): boolean;
  /** Withdraws a row that has not started publishing (scheduled/approved/draft/review → removed). False when Marketing already claimed it. */
  withdrawContent(id: number): boolean;
  getPostMetrics(postId: string): KolBridgeMetric[];
}
