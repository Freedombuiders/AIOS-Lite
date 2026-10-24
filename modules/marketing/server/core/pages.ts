/** Facebook Pages: sync from every ACTIVE Composio connection, list and configure. */

import { listAgentIds } from '../compat.js';
import {
  expireFbPagesForConnection,
  getFbPage,
  listFbPages,
  setFbPageStatus,
  updateFbPageFields,
  upsertFbPageFromSync,
  type FbPageRow,
} from '../store.js';
import { logger } from '../compat.js';
import {
  ComposioConnectionExpiredError,
  FbBudgetExceeded,
  execute,
  hasComposioKey,
  listConnections,
  type ComposioConnection,
} from '../../../_lib/composio.js';
import { notifyOwner } from '../notify.js';
import type { FbPageDto, FbPageUpdate } from '../types.js';
import { pageToDto } from './dto.js';
import { FbError } from './errors.js';
import { extractFollowers, extractPictureUrl, findNextCursor, findRows } from './response.js';
import { isValidTimezone, parseHm } from './time.js';


const MAX_PAGES_PER_CONNECTION = 10;
const PAGE_FIELDS = 'id,name,category,tasks,picture{url},followers_count,fan_count';
const PAGE_FIELDS_FALLBACK = 'id,name,category,tasks,picture';

interface ManagedPage {
  id: string;
  name: string;
  pictureUrl: string;
  followers: number | null;
}

function targetOf(conn: ComposioConnection) {
  return { area: 'pages' as const, connectionId: conn.id, entityId: conn.entityId };
}

/** Every Page one connection manages. Page access tokens in the response are never read. */
async function listManagedPages(conn: ComposioConnection): Promise<ManagedPage[]> {
  const out: ManagedPage[] = [];
  let fields = PAGE_FIELDS;
  let after: string | null = null;
  for (let i = 0; i < MAX_PAGES_PER_CONNECTION; i++) {
    const args: Record<string, unknown> = { limit: 50, fields };
    if (after) args.after = after;
    let data: unknown;
    try {
      data = await execute('FACEBOOK_LIST_MANAGED_PAGES', args, targetOf(conn));
    } catch (err) {
      // An unusual field list can be rejected; retry once with the plain set.
      if (i === 0 && fields === PAGE_FIELDS && !(err instanceof ComposioConnectionExpiredError) && !(err instanceof FbBudgetExceeded) && err instanceof Error && !/rate limit|unauthor/i.test(err.message)) {
        fields = PAGE_FIELDS_FALLBACK;
        data = await execute('FACEBOOK_LIST_MANAGED_PAGES', { ...args, fields }, targetOf(conn));
      } else {
        throw err;
      }
    }
    for (const raw of findRows(data)) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      const id = row.id !== undefined ? String(row.id) : '';
      if (!id) continue;
      out.push({ id, name: typeof row.name === 'string' && row.name ? row.name : id, pictureUrl: extractPictureUrl(row), followers: extractFollowers(row) });
    }
    const next = findNextCursor(data);
    if (!next || next === after) break;
    after = next;
  }
  return out;
}

async function expirePagesOf(connectionId: string): Promise<void> {
  const names: string[] = [];
  for (const id of expireFbPagesForConnection(connectionId)) {
    const page = getFbPage(id);
    if (page) names.push(page.name);
  }
  if (names.length) {
    await notifyOwner(`Kết nối Facebook của Fanpage ${names.map((n) => `"${n}"`).join(', ')} đã hết hạn. Vào Cài đặt › Content Studio để kết nối lại; các bài đang chờ sẽ không được đăng.`);
  }
}

/**
 * Syncs Pages from every ACTIVE facebook connection. A Page seen through
 * several connections keeps its stored connection if that one still sees it,
 * otherwise the first connection that lists it wins. New Pages start disabled.
 */
export async function syncPages(): Promise<FbPageDto[]> {
  if (!hasComposioKey()) throw new FbError(503, 'Chưa cấu hình khóa Composio. Nhập khóa trong Cài đặt › Content Studio.');
  let connections: ComposioConnection[];
  try {
    connections = await listConnections('facebook');
  } catch (err) {
    logger.warn({ err: String(err) }, 'fbstudio: listing facebook connections failed');
    throw new FbError(502, 'Không lấy được danh sách kết nối từ Composio.');
  }

  const active = connections.filter((c) => c.status === 'ACTIVE');
  const activeIds = new Set(active.map((c) => c.id));
  const candidates = new Map<string, Array<{ conn: ComposioConnection; page: ManagedPage }>>();
  let budgetHit = false;

  for (const conn of active) {
    try {
      for (const page of await listManagedPages(conn)) {
        const list = candidates.get(page.id) ?? [];
        list.push({ conn, page });
        candidates.set(page.id, list);
      }
    } catch (err) {
      if (err instanceof ComposioConnectionExpiredError) {
        await expirePagesOf(conn.id);
      } else if (err instanceof FbBudgetExceeded) {
        budgetHit = true;
        break;
      } else {
        logger.warn({ err: String(err), connection: conn.id }, 'fbstudio: listing managed pages failed for a connection');
      }
    }
  }

  for (const [pageId, list] of candidates) {
    const stored = getFbPage(pageId);
    const winner = list.find((c) => c.conn.id === stored?.connection_id) ?? list[0];
    upsertFbPageFromSync({
      id: pageId,
      name: winner.page.name,
      connection_id: winner.conn.id,
      entity_id: winner.conn.entityId,
      picture_url: winner.page.pictureUrl,
      followers: winner.page.followers,
    });
  }

  // Pages whose connection is no longer ACTIVE and that nobody else lists are expired.
  for (const row of listFbPages()) {
    if (!candidates.has(row.id) && !activeIds.has(row.connection_id) && row.status !== 'EXPIRED') {
      if (setFbPageStatus(row.id, 'EXPIRED') && row.enabled === 1) {
        await notifyOwner(`Kết nối Facebook của Fanpage "${row.name}" đã hết hạn. Vào Cài đặt › Content Studio để kết nối lại; các bài đang chờ sẽ không được đăng.`);
      }
    }
  }

  if (budgetHit) throw new FbError(503, 'Đã chạm giới hạn gọi API trong giờ này, thử đồng bộ lại sau.');
  await fillMissingFollowers();
  return listFbPages().map((p) => pageToDto(p));
}

/** Followers for enabled Pages the listing did not report (one GET_PAGE_DETAILS each). Best effort. */
async function fillMissingFollowers(): Promise<void> {
  for (const page of listFbPages().filter((p) => p.enabled === 1 && p.followers === null && p.status === 'ACTIVE' && p.connection_id).slice(0, 10)) {
    try {
      const data = await execute('FACEBOOK_GET_PAGE_DETAILS', { page_id: page.id, fields: 'id,followers_count,fan_count' }, {
        area: 'pages',
        connectionId: page.connection_id,
        entityId: page.entity_id,
      });
      const followers = extractFollowers(data) ?? extractFollowers((data as { data?: unknown } | null)?.data) ?? extractFollowers((data as { response_data?: unknown } | null)?.response_data);
      if (followers !== null) updateFbPageFields(page.id, { followers });
    } catch (err) {
      if (err instanceof FbBudgetExceeded) return;
      logger.warn({ err: String(err), page: page.id }, 'fbstudio: follower lookup failed');
    }
  }
}

export function listPages(): FbPageDto[] {
  return listFbPages().map((p) => pageToDto(p));
}

// ── Update ───────────────────────────────────────────────────────────

function intIn(name: string, v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new FbError(400, `${name} phải là số nguyên từ ${min} đến ${max}.`);
  return v;
}

function str(name: string, v: unknown, max: number): string {
  if (typeof v !== 'string') throw new FbError(400, `${name} không hợp lệ.`);
  if (v.length > max) throw new FbError(400, `${name} quá dài (tối đa ${max} ký tự).`);
  return v;
}

function agentId(name: string, v: unknown): string {
  const id = str(name, v, 64).trim();
  if (!id) throw new FbError(400, `${name} không được để trống.`);
  if (id !== 'main' && !listAgentIds().includes(id)) throw new FbError(400, `Không có agent "${id}".`);
  return id;
}

export function updatePage(id: string, patch: FbPageUpdate): FbPageDto {
  const page = getFbPage(id);
  if (!page) throw new FbError(404, 'Không tìm thấy Fanpage.');
  const set: Record<string, unknown> = {};

  if (patch.enabled !== undefined) set.enabled = patch.enabled === true ? 1 : 0;
  if (patch.approvalRequired !== undefined) set.approval_required = patch.approvalRequired === true ? 1 : 0;
  if (patch.role !== undefined) set.role = str('Vai trò', patch.role, 300);
  if (patch.mainKpi !== undefined) set.main_kpi = str('KPI chính', patch.mainKpi, 300);
  if (patch.brandVoice !== undefined) set.brand_voice = str('Giọng thương hiệu', patch.brandVoice, 20000);
  if (patch.timezone !== undefined) {
    if (!isValidTimezone(patch.timezone)) throw new FbError(400, `Múi giờ không hợp lệ: ${String(patch.timezone)}.`);
    set.timezone = patch.timezone;
  }
  if (patch.maxPostsPerDay !== undefined) set.max_posts_per_day = intIn('Số bài tối đa mỗi ngày', patch.maxPostsPerDay, 0, 50);
  if (patch.minGapMinutes !== undefined) set.min_gap_minutes = intIn('Khoảng cách tối thiểu', patch.minGapMinutes, 0, 1440);
  if (patch.graceMinutes !== undefined) set.grace_minutes = intIn('Thời gian châm chước', patch.graceMinutes, 0, 720);
  for (const [key, column, label] of [['windowStart', 'window_start', 'Giờ bắt đầu'], ['windowEnd', 'window_end', 'Giờ kết thúc']] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || parseHm(v) === null) throw new FbError(400, `${label} phải có dạng HH:MM.`);
    const [h, m] = v.split(':');
    set[column] = `${h.padStart(2, '0')}:${m}`;
  }
  if (patch.pillars !== undefined) {
    if (!Array.isArray(patch.pillars) || patch.pillars.length > 20) throw new FbError(400, 'Danh sách trụ cột không hợp lệ (tối đa 20).');
    const pillars = patch.pillars.map((p) => {
      const name = str('Tên trụ cột', p?.name, 80).trim();
      if (!name) throw new FbError(400, 'Tên trụ cột không được để trống.');
      const targetPct = Number(p.targetPct);
      if (!Number.isFinite(targetPct) || targetPct < 0 || targetPct > 100) throw new FbError(400, 'Tỷ trọng trụ cột phải từ 0 đến 100.');
      return { name, targetPct };
    });
    set.pillars_json = JSON.stringify(pillars);
  }
  if (patch.writerAgent !== undefined) set.writer_agent = agentId('Agent viết bài', patch.writerAgent);
  if (patch.videoAgent !== undefined) set.video_agent = agentId('Agent video', patch.videoAgent);

  if (Object.keys(set).length) updateFbPageFields(id, set);
  return pageToDto(getFbPage(id) as FbPageRow);
}
