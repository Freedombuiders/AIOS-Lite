/**
 * Content service: CRUD and the state machine over fb_content. Used by the
 * dashboard routes and by content-cli, so both apply the same rules.
 */

import {
  countFbContentByStatus,
  deleteFbContentRow,
  getFbContent,
  getFbPage,
  insertFbContent,
  listFbCalendarRows,
  listFbContentRows,
  listFbOccupiedTimes,
  listFbPages,
  listFbPublishLog,
  updateFbContentFields,
  type FbContentRow,
  type FbPageRow,
} from '../store.js';
import type {
  FbContentDto,
  FbContentInput,
  FbContentListDto,
  FbContentStatus,
  FbFormat,
  FbMedia,
  FbPublishLogDto,
} from '../types.js';
import { contentToDto, parseJson } from './dto.js';
import { FbError } from './errors.js';
import { normalizeMedia, removeContentMedia } from './media.js';
import {
  ALL_STATUSES,
  AUTHORING,
  FORMATS,
  TAG_FIELDS,
  canApprove,
  canDeleteLocal,
  canPatchStatus,
  canReturn,
  canUnschedule,
  completenessProblems,
  isEditable,
  validateSchedule,
  type PageScheduleRules,
} from './state.js';

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** Who is making the change: a person at the dashboard or an agent through content-cli. */
export type Actor = { kind: 'user' } | { kind: 'agent'; id: string };

const MAX_CAPTION = 63206;

export function scheduleRulesOf(page: FbPageRow): PageScheduleRules {
  return {
    timezone: page.timezone,
    maxPostsPerDay: page.max_posts_per_day,
    minGapMinutes: page.min_gap_minutes,
    windowStart: page.window_start,
    windowEnd: page.window_end,
  };
}

/** Throws FbError(409) with a Vietnamese reason when `at` breaks the Page's rules. */
export function assertScheduleAllowed(page: FbPageRow, at: number, excludeId: number | undefined, now: number = nowSec()): void {
  const others = listFbOccupiedTimes(page.id, at - 36 * 3600, at + 36 * 3600, excludeId);
  const verdict = validateSchedule(scheduleRulesOf(page), at, now, others);
  if (!verdict.ok) throw new FbError(409, verdict.reason);
  if (page.enabled !== 1) throw new FbError(409, `Fanpage "${page.name}" chưa được bật, hãy bật trong màn Fanpage trước khi lên lịch.`);
}

function requireContent(id: number): FbContentRow {
  const row = Number.isInteger(id) ? getFbContent(id) : undefined;
  if (!row) throw new FbError(404, 'Không tìm thấy bài.');
  return row;
}

function requirePage(pageId: string): FbPageRow {
  const page = getFbPage(pageId);
  if (!page) throw new FbError(400, 'Fanpage không tồn tại. Hãy đồng bộ Fanpage trước.');
  return page;
}

function cleanHooks(hooks: unknown): string[] {
  if (!Array.isArray(hooks)) throw new FbError(400, 'Danh sách hook không hợp lệ.');
  return hooks
    .map((h) => String(h ?? '').trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((h) => h.slice(0, 500));
}

function checkFormat(format: unknown): FbFormat {
  if (!FORMATS.includes(format as FbFormat)) throw new FbError(400, `Định dạng không hợp lệ: ${String(format)}.`);
  return format as FbFormat;
}

function checkText(name: string, value: unknown, max: number): string {
  if (typeof value !== 'string') throw new FbError(400, `${name} không hợp lệ.`);
  if (value.length > max) throw new FbError(400, `${name} quá dài (tối đa ${max} ký tự).`);
  return value;
}

function sourceOf(actor: Actor): string {
  return actor.kind === 'agent' ? actor.id : 'user';
}

function mediaOf(row: FbContentRow): FbMedia[] {
  return parseJson<FbMedia[]>(row.media_json, []);
}

function completenessOf(row: FbContentRow): string[] {
  return completenessProblems({
    pageId: row.page_id,
    format: row.format as FbFormat,
    caption: row.caption,
    linkUrl: row.link_url,
    media: mediaOf(row),
  });
}

function dto(id: number): FbContentDto {
  return contentToDto(requireContent(id));
}

// ── Create ───────────────────────────────────────────────────────────

/** Creates an idea, draft or review item. Approval and scheduling go through approveContent. */
export function createContent(input: FbContentInput, actor: Actor, now: number = nowSec()): FbContentDto {
  const status = (input.status ?? 'draft') as FbContentStatus;
  if (!AUTHORING.includes(status)) {
    throw new FbError(400, 'Bài mới chỉ có thể ở trạng thái ý tưởng, nháp hoặc chờ duyệt. Dùng "Duyệt" để lên lịch.');
  }
  if (input.pageId) requirePage(input.pageId);
  const media = input.media ? normalizeMedia(input.media) : [];
  if (input.scheduledAt != null && (!Number.isFinite(input.scheduledAt) || input.scheduledAt <= now)) {
    throw new FbError(400, 'Giờ đề xuất phải ở tương lai.');
  }

  const id = insertFbContent({
    page_id: input.pageId ?? null,
    title: checkText('Tiêu đề', input.title ?? '', 300).trim(),
    caption: checkText('Nội dung', input.caption ?? '', MAX_CAPTION),
    format: checkFormat(input.format ?? 'text'),
    pillar: checkText('Trụ cột', input.pillar ?? '', 120),
    hook_type: checkText('Kiểu hook', input.hookType ?? '', 120),
    cta: checkText('CTA', input.cta ?? '', 300),
    campaign: checkText('Chiến dịch', input.campaign ?? '', 200),
    hooks_json: JSON.stringify(cleanHooks(input.hooks ?? [])),
    link_url: checkText('Link', input.linkUrl ?? '', 2000).trim(),
    media_json: JSON.stringify(media),
    status,
    scheduled_at: input.scheduledAt ?? null,
    source: sourceOf(actor),
    origin: 'studio',
  });
  return dto(id);
}

// ── Update ───────────────────────────────────────────────────────────

const CONTENT_FIELDS: Array<[keyof FbContentInput, string]> = [
  ['title', 'title'],
  ['caption', 'caption'],
  ['format', 'format'],
  ['pillar', 'pillar'],
  ['hookType', 'hook_type'],
  ['cta', 'cta'],
  ['campaign', 'campaign'],
  ['linkUrl', 'link_url'],
];

/** Patches a content row. See state.ts for which statuses accept which edits. */
export function updateContent(id: number, patch: FbContentInput, actor: Actor, now: number = nowSec()): FbContentDto {
  const row = requireContent(id);
  const current = row.status as FbContentStatus;
  const editable = isEditable(current);
  if (editable === 'none') {
    throw new FbError(409, current === 'publishing' ? 'Bài đang được đăng, chưa thể sửa.' : 'Bài đã xóa, không thể sửa.');
  }
  if (editable === 'tags') {
    const touched = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
    const forbidden = touched.filter((k) => !(TAG_FIELDS as readonly string[]).includes(k));
    if (forbidden.length) throw new FbError(409, 'Bài đã đăng, chỉ sửa được tiêu đề và nhãn (trụ cột, hook, CTA, chiến dịch).');
  }

  const set: Record<string, unknown> = {};
  for (const [key, column] of CONTENT_FIELDS) {
    const v = patch[key];
    if (v === undefined) continue;
    if (key === 'format') set[column] = checkFormat(v);
    else if (key === 'caption') set[column] = checkText('Nội dung', v, MAX_CAPTION);
    else if (key === 'linkUrl') set[column] = checkText('Link', v, 2000).trim();
    else if (key === 'title') set[column] = checkText('Tiêu đề', v, 300).trim();
    else set[column] = checkText(String(key), v, 300);
  }
  if (patch.hooks !== undefined) set.hooks_json = JSON.stringify(cleanHooks(patch.hooks));
  if (patch.media !== undefined) set.media_json = JSON.stringify(normalizeMedia(patch.media));

  let pageId = row.page_id;
  if (patch.pageId !== undefined) {
    if (patch.pageId) requirePage(patch.pageId);
    pageId = patch.pageId ?? null;
    set.page_id = pageId;
  }

  let nextStatus: FbContentStatus = current;
  if (patch.status !== undefined && patch.status !== current) {
    if (!canPatchStatus(current, patch.status)) {
      throw new FbError(409, `Không thể chuyển từ "${current}" sang "${patch.status}" bằng cách này.`);
    }
    nextStatus = patch.status;
    if (current === 'failed' || current === 'missed') {
      set.attempts = 0;
      set.next_attempt_at = null;
      set.last_error = '';
    }
  }

  // Merged view of the row after the edit, for the checks below.
  const merged: FbContentRow = { ...row, ...(set as Partial<FbContentRow>), status: nextStatus };

  // Time handling. approved/scheduled rows treat scheduledAt as a (re)schedule request; other rows keep it as a proposal.
  if (patch.scheduledAt !== undefined) {
    if (editable === 'tags') throw new FbError(409, 'Bài đã đăng, không đổi giờ được.');
    const at = patch.scheduledAt;
    if (current === 'approved' || current === 'scheduled' || (at !== null && (current === 'failed' || current === 'missed'))) {
      if (at === null) {
        nextStatus = 'approved';
        set.scheduled_at = null;
        set.next_attempt_at = null;
      } else {
        const problems = completenessOf(merged);
        if (problems.length) throw new FbError(400, problems.join(' '));
        const page = requirePageOf(merged);
        assertScheduleAllowed(page, at, id, now);
        nextStatus = 'scheduled';
        set.scheduled_at = at;
        set.attempts = 0;
        set.next_attempt_at = null;
        set.last_error = '';
      }
    } else {
      // Other rows keep the time as a proposal; null clears it.
      if (at !== null && (!Number.isFinite(at) || at <= now)) throw new FbError(400, 'Giờ đề xuất phải ở tương lai.');
      set.scheduled_at = at;
    }
  } else if (current === 'scheduled' && (patch.pageId !== undefined && pageId !== row.page_id)) {
    // Moving a scheduled post to another Page must satisfy that Page's rules.
    const page = requirePageOf(merged);
    assertScheduleAllowed(page, row.scheduled_at ?? 0, id, now);
  }

  if (nextStatus === 'approved' || nextStatus === 'scheduled') {
    const problems = completenessOf({ ...merged, status: nextStatus });
    if (problems.length) throw new FbError(400, problems.join(' '));
  }

  // An agent editing approved content on a Page that needs approval sends it back for review.
  const contentChanged = Object.keys(set).some((k) => !['scheduled_at', 'next_attempt_at', 'attempts', 'last_error'].includes(k));
  if (actor.kind === 'agent' && contentChanged && (nextStatus === 'approved' || nextStatus === 'scheduled')) {
    const page = pageId ? getFbPage(pageId) : undefined;
    if (!page || page.approval_required === 1) {
      nextStatus = 'review';
      set.next_attempt_at = null;
    }
  }

  if (nextStatus !== current) set.status = nextStatus;
  if (Object.keys(set).length === 0) return contentToDto(row);

  // Compare-and-set: the publisher may have claimed the row in the meantime.
  if (!updateFbContentFields(id, set, [current])) {
    throw new FbError(409, 'Trạng thái bài vừa thay đổi, hãy tải lại rồi thử lại.');
  }
  return dto(id);
}

function requirePageOf(row: FbContentRow): FbPageRow {
  if (!row.page_id) throw new FbError(400, 'Chưa chọn Fanpage.');
  return requirePage(row.page_id);
}

// ── State transitions ────────────────────────────────────────────────

/**
 * Approves a post. With a time (given, or the stored proposal when still in
 * the future) it becomes 'scheduled' after the Page rules pass; without, 'approved'.
 */
export function approveContent(id: number, scheduledAt: number | null | undefined, now: number = nowSec()): FbContentDto {
  const row = requireContent(id);
  const current = row.status as FbContentStatus;
  if (!canApprove(current)) {
    throw new FbError(409, current === 'publishing' || current === 'published' ? 'Bài đã đăng hoặc đang đăng, không thể duyệt.' : `Không thể duyệt bài ở trạng thái "${current}".`);
  }
  const explicit = scheduledAt ?? null;
  if (current === 'scheduled' && explicit === null) return contentToDto(row);

  const problems = completenessOf(row);
  if (problems.length) throw new FbError(400, problems.join(' '));
  const page = requirePageOf(row);

  const at = explicit ?? (row.scheduled_at !== null && row.scheduled_at > now ? row.scheduled_at : null);
  const set: Record<string, unknown> = { attempts: 0, next_attempt_at: null, last_error: '' };
  if (at !== null) {
    assertScheduleAllowed(page, at, id, now);
    set.status = 'scheduled';
    set.scheduled_at = at;
  } else {
    set.status = 'approved';
    set.scheduled_at = null;
  }
  if (!updateFbContentFields(id, set, [current])) {
    throw new FbError(409, 'Trạng thái bài vừa thay đổi, hãy tải lại rồi thử lại.');
  }
  return dto(id);
}

/** Sends a post back to the writer: stores the feedback and returns it to 'draft'. */
export function returnContent(id: number, feedback: string): FbContentDto {
  const row = requireContent(id);
  const current = row.status as FbContentStatus;
  if (!canReturn(current)) throw new FbError(409, `Không thể trả lại bài ở trạng thái "${current}".`);
  const text = checkText('Phản hồi', feedback ?? '', 4000).trim();
  if (!text) throw new FbError(400, 'Cần nhập phản hồi khi trả lại bài.');
  const ok = updateFbContentFields(
    id,
    { status: 'draft', feedback: text, scheduled_at: null, next_attempt_at: null, attempts: 0, last_error: '' },
    [current],
  );
  if (!ok) throw new FbError(409, 'Trạng thái bài vừa thay đổi, hãy tải lại rồi thử lại.');
  return dto(id);
}

/** scheduled → approved. Fails with 409 once the publisher has claimed the post. */
export function unscheduleContent(id: number): FbContentDto {
  const row = requireContent(id);
  if (!canUnschedule(row.status as FbContentStatus)) {
    throw new FbError(409, row.status === 'publishing' ? 'Bài đang được đăng, không thể hủy lịch.' : 'Bài chưa được lên lịch.');
  }
  const ok = updateFbContentFields(id, { status: 'approved', scheduled_at: null, next_attempt_at: null, attempts: 0 }, ['scheduled']);
  if (!ok) throw new FbError(409, 'Bài vừa chuyển sang trạng thái đang đăng, không thể hủy lịch.');
  return dto(id);
}

/** Deletes the row (and its media) locally. Never touches Facebook. */
export function deleteContentLocal(id: number): void {
  const row = requireContent(id);
  if (!canDeleteLocal(row.status as FbContentStatus)) throw new FbError(409, 'Bài đang được đăng, chưa thể xóa.');
  if (!deleteFbContentRow(id)) throw new FbError(409, 'Bài vừa chuyển sang trạng thái đang đăng, chưa thể xóa.');
  removeContentMedia(id);
}

// ── Reads ────────────────────────────────────────────────────────────

export interface ContentQuery {
  status?: string;
  page?: string;
  format?: string;
  pillar?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export function listContent(query: ContentQuery): FbContentListDto {
  const statuses = (query.status ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const s of statuses) {
    if (s !== 'all' && !ALL_STATUSES.includes(s as FbContentStatus)) throw new FbError(400, `Trạng thái không hợp lệ: ${s}.`);
  }
  const status = statuses.length && !statuses.includes('all') ? statuses.join(',') : undefined;
  if (query.format && !FORMATS.includes(query.format as FbFormat)) throw new FbError(400, `Định dạng không hợp lệ: ${query.format}.`);
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200);
  const offset = Math.max(Math.trunc(query.offset ?? 0), 0);
  const filter = { pageId: query.page || undefined, format: query.format || undefined, pillar: query.pillar || undefined, q: query.q?.trim() || undefined };

  const { rows, total } = listFbContentRows({ ...filter, status }, limit, offset);
  const byStatus = countFbContentByStatus(filter);
  const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, byStatus[s] ?? 0])) as Record<FbContentStatus, number>;
  const names = new Map(listFbPages().map((p) => [p.id, p.name]));
  return {
    items: rows.map((r) => contentToDto(r, names)),
    total,
    counts: { ...counts, all: ALL_STATUSES.reduce((sum, s) => sum + counts[s], 0) },
  };
}

export function getContentDetail(id: number): FbContentDto & { log: FbPublishLogDto[] } {
  const row = requireContent(id);
  return {
    ...contentToDto(row),
    log: listFbPublishLog(id).map((l) => ({
      id: l.id,
      action: l.action,
      tool: l.tool,
      ok: l.ok === 1,
      detail: l.detail,
      durationMs: l.duration_ms,
      createdAt: l.created_at,
    })),
  };
}

export function calendarItems(fromSec: number, toSec: number, pageId?: string): FbContentDto[] {
  const names = new Map(listFbPages().map((p) => [p.id, p.name]));
  return listFbCalendarRows(fromSec, toSec, pageId).map((r) => contentToDto(r, names));
}
