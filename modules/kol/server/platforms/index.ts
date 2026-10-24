/**
 * Platform adapters: how one target is published on Facebook (hand-off to
 * Content Studio), Instagram, TikTok and YouTube, and how a target that is
 * still processing on the platform is followed up. Adapters only talk to the
 * platform; the publisher (../publisher.ts) owns claiming, retries, statuses
 * and notifications.
 */

import type { AccountRow } from '../accounts.js';
import type { PostRow, TargetRow } from '../posts.js';
import type { StagedMedia } from '../stage.js';
import type { PersonaDto, Platform, PostDto } from '../types.js';
import { facebookAdapter } from './facebook.js';
import { instagramAdapter } from './instagram.js';
import { tiktokAdapter } from './tiktok.js';
import { youtubeAdapter } from './youtube.js';

/** What a processing target remembers (kol_post_targets.publish_ref, JSON). */
export interface PublishRef {
  /** Instagram creation id, TikTok publish_id or the Content Studio row id. */
  id: string;
  /** When processing started (unix seconds). */
  since: number;
}

export interface PublishContext {
  target: TargetRow;
  post: PostDto;
  account: AccountRow;
  persona: PersonaDto;
  /** Staged media in post order. */
  media: StagedMedia[];
  /** Final caption: variant/master + hashtags + disclosure, within the platform limit. */
  caption: string;
  now: number;
}

export interface PollContext {
  target: TargetRow;
  post: PostRow;
  account: AccountRow;
  ref: PublishRef;
  now: number;
}

export type PublishOutcome =
  | { kind: 'published'; externalId: string | null; permalink: string; note?: string }
  | { kind: 'processing'; ref: PublishRef; fbContentId?: number }
  | { kind: 'failed'; message: string; uncertain?: boolean }
  | { kind: 'missed'; message: string };

export interface PlatformAdapter {
  platform: Platform;
  /** True when poll() itself publishes (Instagram reels): the publisher claims the target first. */
  pollMutates: boolean;
  publish(ctx: PublishContext): Promise<PublishOutcome>;
  poll(ctx: PollContext): Promise<PublishOutcome>;
}

export const ADAPTERS: Record<Platform, PlatformAdapter> = {
  facebook: facebookAdapter,
  instagram: instagramAdapter,
  tiktok: tiktokAdapter,
  youtube: youtubeAdapter,
};

export function parseRef(raw: string | null): PublishRef | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PublishRef>;
    if (typeof v.id === 'string' && v.id && typeof v.since === 'number') return { id: v.id, since: v.since };
  } catch { /* fall through */ }
  return null;
}

export function serializeRef(ref: PublishRef): string {
  return JSON.stringify({ id: ref.id, since: ref.since });
}
