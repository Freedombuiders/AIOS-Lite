/**
 * A persona's social accounts (kol_accounts): Composio connections turned
 * into accounts with an identity (id, handle, picture, followers) and posting
 * rules. Facebook accounts point at a Content Studio Page (fb_pages); the
 * other platforms are resolved through read-only Composio tools.
 *
 * Also holds the owner notifier for the publish side (installed by
 * startPublishWorkers) and the follower history (kol_account_daily).
 */

import { randomUUID } from 'crypto';

import { isValidTimezone, localDayKey } from './time.js';
import { fbAvailable, getFbPage, NEEDS_MARKETING } from './fb-bridge.js';
import { logger } from './compat.js';
import {
  ComposioConnectionExpiredError,
  asArr,
  asNum,
  asObj,
  asStr,
  executeTool,
  findRecord,
  hasComposioKey,
  listToolkitConnections,
  type ExecTarget,
} from './composio-exec.js';
import { KolError, kolDb, nowSec } from './core.js';
import { requirePersona } from './personas.js';
import { PLATFORM_LABEL } from './schedule-rules.js';
import type { AccountDto, AccountInput, ConnectionDto, Platform } from './types.js';

// ── Owner notifications ──────────────────────────────────────────────

type Notifier = (text: string) => Promise<void>;
let notifier: Notifier | null = null;

export function setPublishNotifier(fn: Notifier | null): void {
  notifier = fn;
}

/** Best effort: never throws. */
export async function notifyOwner(text: string): Promise<void> {
  if (!notifier) {
    logger.info({ chars: text.length }, 'kol notification (no notifier installed)');
    return;
  }
  try {
    await notifier(text);
  } catch (err) {
    logger.warn({ err: String(err) }, 'kol notification failed');
  }
}

// ── Rows ─────────────────────────────────────────────────────────────

export interface AccountRow {
  id: string;
  persona_id: string;
  platform: string;
  connection_id: string;
  entity_id: string;
  external_id: string;
  handle: string;
  display_name: string;
  picture_url: string;
  enabled: number;
  auto_publish: number;
  max_posts_per_day: number;
  min_gap_minutes: number;
  window_start: string;
  window_end: string;
  timezone: string;
  tiktok_privacy: string;
  youtube_privacy: string;
  youtube_category: string;
  status: string;
  followers: number | null;
  followers_at: number | null;
  created_at: number;
  updated_at: number;
}

export const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';
export const TIKTOK_PRIVACY = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'] as const;
export const YOUTUBE_PRIVACY = ['public', 'unlisted', 'private'] as const;

export function accountToDto(r: AccountRow): AccountDto {
  return {
    id: r.id,
    personaId: r.persona_id,
    platform: r.platform as Platform,
    connectionId: r.connection_id,
    externalId: r.external_id,
    handle: r.handle,
    displayName: r.display_name,
    pictureUrl: r.picture_url,
    enabled: r.enabled === 1,
    autoPublish: r.auto_publish === 1,
    maxPostsPerDay: r.max_posts_per_day,
    minGapMinutes: r.min_gap_minutes,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    timezone: r.timezone,
    tiktokPrivacy: r.tiktok_privacy,
    youtubePrivacy: (YOUTUBE_PRIVACY as readonly string[]).includes(r.youtube_privacy) ? (r.youtube_privacy as AccountDto['youtubePrivacy']) : 'public',
    youtubeCategory: r.youtube_category,
    status: r.status === 'EXPIRED' || r.status === 'ERROR' ? r.status : 'ACTIVE',
    followers: r.followers,
    followersAt: r.followers_at,
    sharedWith: channelSiblings(r).map((s) => s.persona_name),
  };
}

/**
 * The other personas' rows for the same channel (same platform and external id).
 * One channel may serve several KOLs; its posting rules then count every KOL's posts.
 */
export function channelSiblings(r: Pick<AccountRow, 'id' | 'platform' | 'external_id'>): (AccountRow & { persona_name: string })[] {
  if (!r.external_id) return [];
  return kolDb().prepare(
    `SELECT a.*, COALESCE(p.name, '') AS persona_name FROM kol_accounts a LEFT JOIN kol_personas p ON p.id = a.persona_id
     WHERE a.platform = ? AND a.external_id = ? AND a.id <> ? ORDER BY a.created_at`,
  ).all(r.platform, r.external_id, r.id) as (AccountRow & { persona_name: string })[];
}

/** The account's id plus every sibling row on the same channel. */
export function sameChannelAccountIds(accountId: string): string[] {
  const row = getAccountRow(accountId);
  return row ? [row.id, ...channelSiblings(row).map((s) => s.id)] : [accountId];
}

/** "Instagram @mai.ai" — how messages name an account. */
export function accountLabel(r: Pick<AccountRow, 'platform' | 'handle' | 'display_name' | 'external_id'>): string {
  const name = r.handle || r.display_name || r.external_id;
  return `${PLATFORM_LABEL[r.platform as Platform] ?? r.platform} ${name}`.trim();
}

export function execTargetOf(r: Pick<AccountRow, 'connection_id' | 'entity_id'>): ExecTarget {
  return { connectionId: r.connection_id, entityId: r.entity_id };
}

export function getAccountRow(id: string): AccountRow | null {
  return (kolDb().prepare('SELECT * FROM kol_accounts WHERE id = ?').get(id) as AccountRow | undefined) ?? null;
}

export function requireAccountRow(id: string): AccountRow {
  const row = getAccountRow(id);
  if (!row) throw new KolError(404, 'Không tìm thấy tài khoản.');
  return row;
}

export function listAccountRows(personaId: string): AccountRow[] {
  return kolDb().prepare('SELECT * FROM kol_accounts WHERE persona_id = ? ORDER BY platform, created_at').all(personaId) as AccountRow[];
}

export function listAccounts(personaId: string): AccountDto[] {
  requirePersona(personaId);
  return listAccountRows(personaId).map(accountToDto);
}

/** Every linked account across all personas (dashboard audience), persona order then platform. */
export function listAllAccounts(): AccountDto[] {
  return (kolDb().prepare('SELECT * FROM kol_accounts ORDER BY persona_id, platform, created_at').all() as AccountRow[]).map(accountToDto);
}

/** Every account whose status lets it publish. */
export function isAccountReady(r: AccountRow | null): r is AccountRow {
  return !!r && r.enabled === 1 && r.status === 'ACTIVE';
}

// ── Composio connections ─────────────────────────────────────────────

export const CONNECTION_TOOLKITS: Platform[] = ['facebook', 'instagram', 'tiktok', 'youtube'];

/** Connections for the four platforms; ACTIVE first. Empty with composio=false when no key is set. */
export async function listKolConnections(): Promise<{ composio: boolean; connections: ConnectionDto[] }> {
  if (!hasComposioKey()) return { composio: false, connections: [] };
  const out: ConnectionDto[] = [];
  for (const toolkit of CONNECTION_TOOLKITS) {
    try {
      for (const c of await listToolkitConnections(toolkit)) {
        if (c.toolkit !== toolkit) continue;
        out.push({ id: c.id, toolkit, status: c.status, alias: c.alias });
      }
    } catch (err) {
      logger.warn({ toolkit, err: String(err).slice(0, 200) }, 'kol: listing connections failed');
    }
  }
  out.sort((a, b) => Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE'));
  return { composio: true, connections: out };
}

async function requireConnection(platform: Platform, connectionId: string): Promise<{ connectionId: string; entityId: string }> {
  if (!hasComposioKey()) throw new KolError(412, 'Chưa có khóa Composio. Thêm ở Kết nối → Composio.');
  let conns;
  try {
    conns = await listToolkitConnections(platform);
  } catch (err) {
    throw new KolError(502, `Không đọc được danh sách kết nối Composio: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
  }
  const conn = conns.find((c) => c.id === connectionId);
  if (!conn) throw new KolError(404, `Không tìm thấy kết nối ${PLATFORM_LABEL[platform]} này trong Composio.`);
  if (conn.status !== 'ACTIVE') {
    throw new KolError(409, `Kết nối ${PLATFORM_LABEL[platform]} đang ở trạng thái ${conn.status}. Hãy kết nối lại trong Composio rồi thử lại.`);
  }
  return { connectionId: conn.id, entityId: conn.entityId };
}

// ── Identity per platform ────────────────────────────────────────────

export interface AccountIdentity {
  externalId: string;
  handle: string;
  displayName: string;
  pictureUrl: string;
  followers: number | null;
  /** TikTok: privacy levels the creator may use. */
  privacyOptions?: string[];
  /** Facebook: the Page's timezone. */
  timezone?: string;
}

function facebookIdentity(pageId: string): AccountIdentity & { connectionId: string; entityId: string } {
  if (!fbAvailable()) throw new KolError(412, NEEDS_MARKETING);
  const page = pageId ? getFbPage(pageId) : undefined;
  if (!page) {
    throw new KolError(404, 'Không tìm thấy Fanpage này. Vào Marketing › Pages, bấm Đồng bộ rồi bật Fanpage, sau đó liên kết lại.');
  }
  if (!page.enabled) {
    throw new KolError(409, `Fanpage "${page.name}" chưa được bật. Vào Marketing › Pages để bật Fanpage rồi liên kết lại.`);
  }
  if (!page.connectionId) {
    throw new KolError(409, `Fanpage "${page.name}" chưa có kết nối Facebook. Vào Marketing › Pages, bấm Đồng bộ rồi thử lại.`);
  }
  return {
    externalId: page.id,
    handle: page.name,
    displayName: page.name,
    pictureUrl: page.pictureUrl,
    followers: page.followers,
    timezone: page.timezone,
    connectionId: page.connectionId,
    entityId: page.entityId,
  };
}

const IG_FIELDS = 'id,user_id,username,name,account_type,profile_picture_url,followers_count,media_count';

export async function instagramIdentity(target: ExecTarget, igUserId?: string): Promise<AccountIdentity> {
  const data = await executeTool('INSTAGRAM_GET_USER_INFO', { ig_user_id: igUserId || 'me', fields: IG_FIELDS }, target);
  const info = findRecord(data, ['username', 'id', 'user_id']) ?? {};
  // Instagram Login: `user_id` is the professional account id the publishing endpoints want; `id` is app-scoped.
  const id = asStr(info.user_id) ?? asStr(info.id);
  if (!id) throw new KolError(502, 'Instagram không trả về tài khoản nào cho kết nối này.');
  const username = asStr(info.username) ?? '';
  const type = asStr(info.account_type);
  if (type && !/business|creator/i.test(type)) {
    throw new KolError(
      409,
      `Tài khoản Instagram ${username ? `@${username} ` : ''}là tài khoản cá nhân. Instagram chỉ cho đăng bài qua API với tài khoản Business hoặc Creator: `
        + 'trong ứng dụng Instagram vào Cài đặt › Loại tài khoản và công cụ › Chuyển sang tài khoản chuyên nghiệp, rồi kết nối lại.',
    );
  }
  return {
    externalId: id,
    handle: username ? `@${username}` : '',
    displayName: asStr(info.name) ?? username,
    pictureUrl: asStr(info.profile_picture_url) ?? '',
    followers: asNum(info.followers_count),
  };
}

export async function youtubeIdentity(target: ExecTarget, channelId?: string): Promise<AccountIdentity> {
  const data = asObj(await executeTool('YOUTUBE_GET_CHANNEL_STATISTICS', { mine: true, part: 'snippet,statistics' }, target));
  const holder = findRecord(data, ['items', 'channels']) ?? {};
  const channels = asArr(holder.items ?? holder.channels).map(asObj);
  const ch = (channelId ? channels.find((c) => asStr(c.id) === channelId) : channels[0]) ?? null;
  if (!ch || !asStr(ch.id)) {
    throw new KolError(channelId ? 409 : 502, channelId ? 'Kết nối YouTube này không sở hữu kênh đã chọn.' : 'YouTube không trả về kênh nào cho kết nối này.');
  }
  const snippet = asObj(ch.snippet);
  const stats = asObj(ch.statistics);
  const thumbs = asObj(snippet.thumbnails);
  const custom = asStr(snippet.customUrl);
  return {
    externalId: asStr(ch.id)!,
    handle: custom ? (custom.startsWith('@') ? custom : `@${custom}`) : asStr(snippet.title) ?? '',
    displayName: asStr(snippet.title) ?? '',
    pictureUrl: asStr(asObj(thumbs.medium).url) ?? asStr(asObj(thumbs.default).url) ?? '',
    followers: stats.hiddenSubscriberCount === true ? null : asNum(stats.subscriberCount),
  };
}

export async function tiktokIdentity(target: ExecTarget): Promise<AccountIdentity> {
  const creator = findRecord(await executeTool('TIKTOK_QUERY_CREATOR_INFO', {}, target), ['creator_username', 'privacy_level_options', 'creator_nickname']) ?? {};
  let user: Record<string, unknown> = {};
  try {
    const stats = await executeTool('TIKTOK_GET_USER_STATS', { fields: ['open_id', 'username', 'display_name', 'avatar_url', 'follower_count'] }, target);
    user = findRecord(stats, ['open_id', 'follower_count', 'display_name']) ?? {};
  } catch (err) {
    if (err instanceof ComposioConnectionExpiredError) throw err;
    // Stats need the user.info.stats scope; the account still works without them.
    logger.warn({ err: String(err).slice(0, 160) }, 'kol: tiktok user stats unavailable');
  }
  const username = asStr(creator.creator_username) ?? asStr(user.username) ?? '';
  const externalId = asStr(user.open_id) ?? username;
  if (!externalId) throw new KolError(502, 'TikTok không trả về tài khoản nào cho kết nối này.');
  const options = asArr(creator.privacy_level_options).map((v) => asStr(v)).filter((v): v is string => !!v);
  return {
    externalId,
    handle: username ? `@${username}` : '',
    displayName: asStr(creator.creator_nickname) ?? asStr(user.display_name) ?? username,
    pictureUrl: asStr(creator.creator_avatar_url) ?? asStr(user.avatar_url) ?? '',
    followers: asNum(user.follower_count),
    privacyOptions: options,
  };
}

/** Last privacy options TikTok reported per account (refreshed on link/refresh). */
const tiktokPrivacyOptions = new Map<string, string[]>();

export function tiktokPrivacyChoice(current: string, options: string[] | undefined): string {
  if (!options || options.length === 0) return (TIKTOK_PRIVACY as readonly string[]).includes(current) ? current : 'SELF_ONLY';
  if (options.includes(current)) return current;
  return options.includes('SELF_ONLY') ? 'SELF_ONLY' : options[0];
}

async function resolveIdentity(platform: Platform, target: ExecTarget, externalId?: string): Promise<AccountIdentity> {
  switch (platform) {
    case 'instagram': return instagramIdentity(target, externalId);
    case 'youtube': return youtubeIdentity(target, externalId);
    case 'tiktok': return tiktokIdentity(target);
    case 'facebook': return facebookIdentity(externalId ?? '');
  }
}

// ── Followers history ────────────────────────────────────────────────

/** Stores today's follower count (local day in the account's timezone) and the account's latest value. */
export function recordFollowers(accountId: string, followers: number | null, timezone: string, now = nowSec()): void {
  if (followers === null || !Number.isFinite(followers)) return;
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
  const db = kolDb();
  db.prepare(
    `INSERT INTO kol_account_daily (account_id, day, followers) VALUES (?, ?, ?)
     ON CONFLICT(account_id, day) DO UPDATE SET followers = excluded.followers`,
  ).run(accountId, localDayKey(now, tz), Math.round(followers));
  db.prepare('UPDATE kol_accounts SET followers = ?, followers_at = ?, updated_at = ? WHERE id = ?').run(Math.round(followers), now, now, accountId);
}

export function hasFollowersToday(accountId: string, timezone: string, now = nowSec()): boolean {
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
  return !!kolDb().prepare('SELECT 1 FROM kol_account_daily WHERE account_id = ? AND day = ?').get(accountId, localDayKey(now, tz));
}

// ── Expiry ───────────────────────────────────────────────────────────

/** Marks the account EXPIRED; notifies the owner only when it was not expired before. */
export async function markAccountExpired(accountId: string): Promise<void> {
  const row = getAccountRow(accountId);
  if (!row) return;
  const changed = kolDb().prepare(`UPDATE kol_accounts SET status = 'EXPIRED', updated_at = ? WHERE id = ? AND status <> 'EXPIRED'`).run(nowSec(), accountId).changes > 0;
  if (changed) {
    await notifyOwner(
      `Kết nối ${accountLabel(row)} của KOL đã hết hạn. Vào KOL Studio › Kênh để kết nối lại; các bài đang chờ trên tài khoản này sẽ không được đăng.`,
    );
  }
}

// ── Link / update / delete / refresh ─────────────────────────────────

export interface LinkInput {
  platform: Platform;
  connectionId: string;
  externalId?: string;
}

export async function linkAccount(personaId: string, input: LinkInput): Promise<AccountDto> {
  requirePersona(personaId);
  const { platform } = input;
  if (!CONNECTION_TOOLKITS.includes(platform)) throw new KolError(400, 'Nền tảng không hợp lệ.');

  let target: ExecTarget;
  let identity: AccountIdentity;
  if (platform === 'facebook') {
    const fb = facebookIdentity(input.externalId ?? '');
    target = { connectionId: fb.connectionId, entityId: fb.entityId };
    identity = fb;
  } else {
    target = await requireConnection(platform, input.connectionId);
    try {
      identity = await resolveIdentity(platform, target, input.externalId);
    } catch (err) {
      if (err instanceof KolError) throw err;
      if (err instanceof ComposioConnectionExpiredError) throw new KolError(409, `Kết nối ${PLATFORM_LABEL[platform]} đã hết hạn, hãy kết nối lại trong Composio.`);
      throw new KolError(502, `${PLATFORM_LABEL[platform]} không trả lời: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    }
  }

  const db = kolDb();
  const existing = db.prepare('SELECT * FROM kol_accounts WHERE platform = ? AND external_id = ? ORDER BY created_at').all(platform, identity.externalId) as AccountRow[];
  if (existing.some((r) => r.persona_id === personaId)) {
    throw new KolError(409, `${PLATFORM_LABEL[platform]} ${identity.handle || identity.externalId} đã được liên kết với KOL này.`);
  }
  // A channel another KOL already uses starts with that KOL's posting rules (same channel, same limits).
  const base = existing[0];

  const id = randomUUID();
  const now = nowSec();
  const timezone = base?.timezone ?? (identity.timezone && isValidTimezone(identity.timezone) ? identity.timezone : DEFAULT_TIMEZONE);
  const privacy = platform === 'tiktok' ? tiktokPrivacyChoice(base?.tiktok_privacy ?? 'SELF_ONLY', identity.privacyOptions) : 'SELF_ONLY';
  db.prepare(
    `INSERT INTO kol_accounts (id, persona_id, platform, connection_id, entity_id, external_id, handle, display_name, picture_url,
       timezone, tiktok_privacy, status, followers, followers_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`,
  ).run(
    id, personaId, platform, target.connectionId, target.entityId, identity.externalId, identity.handle, identity.displayName,
    identity.pictureUrl, timezone, privacy, identity.followers, identity.followers === null ? null : now, now, now,
  );
  if (base) {
    const cols = CHANNEL_COLUMNS.filter((c) => c !== 'timezone' && c !== 'tiktok_privacy');
    db.prepare(`UPDATE kol_accounts SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map((c) => base[c as keyof AccountRow]), id);
  }
  if (identity.privacyOptions) tiktokPrivacyOptions.set(id, identity.privacyOptions);
  recordFollowers(id, identity.followers, timezone, now);
  return accountToDto(requireAccountRow(id));
}

const HM = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** Applies an AccountInput. Changing the connection re-checks it and sets the account ACTIVE again. */
export async function updateAccount(id: string, input: AccountInput): Promise<AccountDto> {
  const row = requireAccountRow(id);
  const patch: Record<string, unknown> = {};

  if (input.externalId !== undefined && input.externalId !== row.external_id) {
    throw new KolError(400, 'Không đổi được tài khoản đã liên kết. Hãy gỡ tài khoản rồi liên kết lại.');
  }
  if (input.connectionId !== undefined && input.connectionId !== row.connection_id) {
    if (row.platform === 'facebook') throw new KolError(400, 'Kết nối của Fanpage được quản lý ở Marketing › Pages.');
    const conn = await requireConnection(row.platform as Platform, input.connectionId);
    patch.connection_id = conn.connectionId;
    patch.entity_id = conn.entityId;
    patch.status = 'ACTIVE';
  }
  if (input.handle !== undefined) patch.handle = String(input.handle).slice(0, 120);
  if (input.displayName !== undefined) patch.display_name = String(input.displayName).slice(0, 200);
  if (input.pictureUrl !== undefined) patch.picture_url = String(input.pictureUrl).slice(0, 2000);
  if (input.enabled !== undefined) patch.enabled = input.enabled ? 1 : 0;
  if (input.autoPublish !== undefined) patch.auto_publish = input.autoPublish ? 1 : 0;
  if (input.maxPostsPerDay !== undefined) {
    const n = Number(input.maxPostsPerDay);
    if (!Number.isInteger(n) || n < 0 || n > 50) throw new KolError(400, 'Số bài tối đa mỗi ngày phải từ 0 đến 50 (0 = không giới hạn).');
    patch.max_posts_per_day = n;
  }
  if (input.minGapMinutes !== undefined) {
    const n = Number(input.minGapMinutes);
    if (!Number.isInteger(n) || n < 0 || n > 1440) throw new KolError(400, 'Khoảng cách tối thiểu phải từ 0 đến 1440 phút.');
    patch.min_gap_minutes = n;
  }
  for (const [key, col, label] of [['windowStart', 'window_start', 'Giờ bắt đầu'], ['windowEnd', 'window_end', 'Giờ kết thúc']] as const) {
    const v = input[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !HM.test(v.trim())) throw new KolError(400, `${label} phải có dạng HH:MM.`);
    const [h, m] = v.trim().split(':');
    patch[col] = `${h.padStart(2, '0')}:${m}`;
  }
  if (input.timezone !== undefined) {
    if (!isValidTimezone(input.timezone)) throw new KolError(400, 'Múi giờ không hợp lệ (ví dụ Asia/Ho_Chi_Minh).');
    patch.timezone = input.timezone;
  }
  if (input.tiktokPrivacy !== undefined) {
    if (!(TIKTOK_PRIVACY as readonly string[]).includes(input.tiktokPrivacy)) throw new KolError(400, 'Chế độ riêng tư TikTok không hợp lệ.');
    const options = tiktokPrivacyOptions.get(id);
    if (options && options.length && !options.includes(input.tiktokPrivacy)) {
      throw new KolError(409, `TikTok chỉ cho tài khoản này dùng: ${options.join(', ')}. Ứng dụng chưa được TikTok duyệt chỉ đăng được ở chế độ riêng tư (SELF_ONLY).`);
    }
    patch.tiktok_privacy = input.tiktokPrivacy;
  }
  if (input.youtubePrivacy !== undefined) {
    if (!(YOUTUBE_PRIVACY as readonly string[]).includes(input.youtubePrivacy)) throw new KolError(400, 'Chế độ hiển thị YouTube không hợp lệ.');
    patch.youtube_privacy = input.youtubePrivacy;
  }
  if (input.youtubeCategory !== undefined) {
    if (!/^\d{1,3}$/.test(String(input.youtubeCategory))) throw new KolError(400, 'Mã danh mục YouTube phải là số (ví dụ 22).');
    patch.youtube_category = String(input.youtubeCategory);
  }

  const keys = Object.keys(patch);
  if (keys.length) {
    const db = kolDb();
    const now = nowSec();
    db.transaction(() => {
      db.prepare(`UPDATE kol_accounts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => patch[k]), now, id);
      // Rules that belong to the channel follow it to every KOL sharing it; on/off and auto-publish stay per KOL.
      const shared = keys.filter((k) => CHANNEL_COLUMNS.includes(k));
      const siblings = shared.length ? channelSiblings(row).map((s) => s.id) : [];
      for (const sid of siblings) {
        db.prepare(`UPDATE kol_accounts SET ${shared.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...shared.map((k) => patch[k]), now, sid);
      }
    })();
  }
  return accountToDto(requireAccountRow(id));
}

const CHANNEL_COLUMNS = ['max_posts_per_day', 'min_gap_minutes', 'window_start', 'window_end', 'timezone', 'tiktok_privacy', 'youtube_privacy', 'youtube_category'];

/**
 * Removes an account. Refused while one of its targets is being published;
 * scheduled or pending targets on it are skipped. Returns the posts touched
 * (their status must be recomputed by the caller).
 */
export function deleteAccount(id: string): string[] {
  requireAccountRow(id);
  const db = kolDb();
  const busy = db.prepare(`SELECT COUNT(*) AS n FROM kol_post_targets WHERE account_id = ? AND status IN ('publishing','processing')`).get(id) as { n: number };
  if (busy.n > 0) throw new KolError(409, 'Tài khoản đang có bài được đăng. Chờ đăng xong rồi gỡ.');
  const posts = (db.prepare(`SELECT DISTINCT post_id FROM kol_post_targets WHERE account_id = ? AND status IN ('pending','scheduled')`).all(id) as { post_id: string }[]).map((r) => r.post_id);
  const now = nowSec();
  db.transaction(() => {
    db.prepare(`UPDATE kol_post_targets SET status = 'skipped', error = ?, updated_at = ? WHERE account_id = ? AND status IN ('pending','scheduled')`)
      .run('Tài khoản đã bị gỡ khỏi KOL.', now, id);
    db.prepare('DELETE FROM kol_account_daily WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM kol_accounts WHERE id = ?').run(id);
  })();
  tiktokPrivacyOptions.delete(id);
  return posts;
}

/**
 * Re-reads identity and followers. An expired connection marks the account
 * EXPIRED (owner notified once) and answers 409.
 */
export async function refreshAccount(id: string, now = nowSec()): Promise<AccountDto> {
  const row = requireAccountRow(id);
  const platform = row.platform as Platform;
  let identity: AccountIdentity;
  try {
    if (platform === 'facebook') {
      identity = facebookIdentity(row.external_id);
    } else {
      if (!hasComposioKey()) throw new KolError(412, 'Chưa có khóa Composio. Thêm ở Kết nối → Composio.');
      identity = await resolveIdentity(platform, execTargetOf(row), row.external_id);
    }
  } catch (err) {
    if (err instanceof ComposioConnectionExpiredError) {
      await markAccountExpired(id);
      throw new KolError(409, `Kết nối ${accountLabel(row)} đã hết hạn. Hãy kết nối lại trong Composio rồi chọn kết nối mới cho tài khoản.`);
    }
    if (err instanceof KolError) {
      if (platform === 'facebook' && err.status === 409) {
        kolDb().prepare(`UPDATE kol_accounts SET status = 'ERROR', updated_at = ? WHERE id = ?`).run(now, id);
      }
      throw err;
    }
    kolDb().prepare(`UPDATE kol_accounts SET status = 'ERROR', updated_at = ? WHERE id = ? AND status <> 'EXPIRED'`).run(now, id);
    throw new KolError(502, `${PLATFORM_LABEL[platform]} không trả lời: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
  }
  if (identity.externalId !== row.external_id && platform !== 'tiktok') {
    throw new KolError(409, `Kết nối hiện trả về một tài khoản ${PLATFORM_LABEL[platform]} khác (${identity.handle || identity.externalId}). Hãy gỡ rồi liên kết lại.`);
  }
  if (identity.privacyOptions) tiktokPrivacyOptions.set(id, identity.privacyOptions);
  const privacy = platform === 'tiktok' ? tiktokPrivacyChoice(row.tiktok_privacy, identity.privacyOptions) : row.tiktok_privacy;
  kolDb()
    .prepare(
      `UPDATE kol_accounts SET handle = ?, display_name = ?, picture_url = ?, tiktok_privacy = ?, status = 'ACTIVE', updated_at = ? WHERE id = ?`,
    )
    .run(identity.handle || row.handle, identity.displayName || row.display_name, identity.pictureUrl || row.picture_url, privacy, now, id);
  recordFollowers(id, identity.followers, row.timezone, now);
  return accountToDto(requireAccountRow(id));
}

/** Followers only (used by the daily metrics sweep). Throws the typed Composio errors. */
export async function fetchFollowers(row: AccountRow): Promise<number | null> {
  const platform = row.platform as Platform;
  if (platform === 'facebook') return getFbPage(row.external_id)?.followers ?? null;
  const identity = await resolveIdentity(platform, execTargetOf(row), row.external_id);
  if (identity.privacyOptions) tiktokPrivacyOptions.set(row.id, identity.privacyOptions);
  return identity.followers;
}

/** Test hook. */
export function _resetAccountsState(): void {
  tiktokPrivacyOptions.clear();
  notifier = null;
}
