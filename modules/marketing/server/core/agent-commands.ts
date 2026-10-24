/**
 * Command implementations behind the agent bridge (POST /agent-command). Pure of process
 * I/O: takes argv and returns a JSON-serialisable result (or throws FbError /
 * CliUsageError) so it can be tested without spawning anything.
 */

import {
  getFbContent,
  getLatestFbChannelInsight,
  listFbPages,
  listFbPostsWithMetrics,
  type FbPageRow,
} from '../store.js';
import type { FbContentDto, FbContentInput, FbFormat } from '../types.js';
import {
  approveContent,
  assertScheduleAllowed,
  createContent,
  deleteContentLocal,
  getContentDetail,
  listContent,
  updateContent,
  type Actor,
} from './content.js';
import { engagementRate, parseJson, parsePillars } from './dto.js';
import { channelView, postsView, postView } from '../agent-view.js';
import { FbError } from './errors.js';
import { importMediaFiles } from './media.js';
import { FORMATS } from './state.js';
import { formatLocal, parseLocalDateTime } from './time.js';

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** Bad command line (missing argument, unknown flag): printed with the usage hint. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

// ── Argument parsing ─────────────────────────────────────────────────

const VALUE_FLAGS = new Set([
  'page', 'format', 'title', 'caption', 'pillar', 'hook-type', 'cta', 'campaign', 'hook', 'media', 'link',
  'schedule', 'status', 'limit', 'agent', 'days', 'milestone',
]);
const REPEATABLE = new Set(['hook', 'media']);
const BOOLEAN_FLAGS = new Set(['all']);

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string[]>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const name = token.slice(2, eq === -1 ? undefined : eq);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, ['true']);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new CliUsageError(`Cờ không hợp lệ: --${name}`);
    let value: string | undefined;
    if (eq !== -1) value = token.slice(eq + 1);
    else {
      value = rest[i + 1];
      if (value === undefined || (value.startsWith('--') && value.length > 2)) throw new CliUsageError(`Cờ --${name} cần một giá trị.`);
      i++;
    }
    const list = flags.get(name) ?? [];
    if (list.length > 0 && !REPEATABLE.has(name)) throw new CliUsageError(`Cờ --${name} chỉ được dùng một lần.`);
    list.push(value);
    flags.set(name, list);
  }
  return { command, positional, flags };
}

function one(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.[0];
}

function many(args: ParsedArgs, name: string): string[] | undefined {
  return args.flags.get(name);
}

function requireId(args: ParsedArgs, usage: string): number {
  const raw = args.positional[0];
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id <= 0) throw new CliUsageError(`Thiếu hoặc sai mã bài. Cách dùng: ${usage}`);
  return id;
}

// ── Helpers ──────────────────────────────────────────────────────────

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();
}

/** Resolves `--page` by id, exact name, or a unique fragment of the name (accent-insensitive). */
export function resolvePage(ref: string | undefined): FbPageRow {
  if (!ref) throw new CliUsageError('Thiếu --page <id|tên>.');
  const pages = listFbPages();
  const byId = pages.find((p) => p.id === ref);
  if (byId) return byId;
  const wanted = fold(ref);
  const exact = pages.filter((p) => fold(p.name) === wanted);
  if (exact.length === 1) return exact[0];
  const partial = exact.length ? exact : pages.filter((p) => fold(p.name).includes(wanted));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new FbError(400, `Tên Fanpage "${ref}" khớp nhiều Fanpage: ${partial.map((p) => `${p.name} (${p.id})`).join(', ')}. Dùng id.`);
  }
  throw new FbError(404, `Không tìm thấy Fanpage "${ref}". Chạy "pages" để xem danh sách.`);
}

function parseTime(text: string, page: FbPageRow): number {
  const at = parseLocalDateTime(text, page.timezone);
  if (at === null) throw new CliUsageError(`Giờ "${text}" không đúng dạng "YYYY-MM-DD HH:MM" (giờ ${page.timezone}).`);
  return at;
}

function summarize(c: FbContentDto, tz: string): Record<string, unknown> {
  return {
    id: c.id,
    pageId: c.pageId,
    page: c.pageName,
    format: c.format,
    status: c.status,
    title: c.title,
    pillar: c.pillar,
    hookType: c.hookType,
    scheduledAt: c.scheduledAt,
    scheduledLocal: c.scheduledAt ? formatLocal(c.scheduledAt, tz) : null,
    source: c.source,
    media: c.media.length,
    lastError: c.lastError,
    feedback: c.feedback,
  };
}

function tzOf(c: FbContentDto): string {
  return (c.pageId ? listFbPages().find((p) => p.id === c.pageId)?.timezone : undefined) ?? 'Asia/Ho_Chi_Minh';
}

function checkFormat(value: string): FbFormat {
  if (!FORMATS.includes(value as FbFormat)) throw new CliUsageError(`--format phải là một trong: ${FORMATS.join(', ')}.`);
  return value as FbFormat;
}

// ── Commands ─────────────────────────────────────────────────────────

function cmdPages(args: ParsedArgs): unknown {
  const all = args.flags.has('all');
  return listFbPages()
    .filter((p) => all || p.enabled === 1)
    .map((p) => ({
      id: p.id,
      name: p.name,
      enabled: p.enabled === 1,
      status: p.status,
      role: p.role,
      mainKpi: p.main_kpi,
      timezone: p.timezone,
      approvalRequired: p.approval_required === 1,
      maxPostsPerDay: p.max_posts_per_day,
      minGapMinutes: p.min_gap_minutes,
      window: `${p.window_start}-${p.window_end}`,
      brandVoice: p.brand_voice,
      pillars: parsePillars(p.pillars_json),
      writerAgent: p.writer_agent,
      videoAgent: p.video_agent,
    }));
}

function cmdList(args: ParsedArgs): unknown {
  const pageRef = one(args, 'page');
  const page = pageRef ? resolvePage(pageRef) : undefined;
  const limit = Number(one(args, 'limit') ?? 30);
  const list = listContent({ status: one(args, 'status'), page: page?.id, limit: Number.isFinite(limit) ? limit : 30 });
  return { total: list.total, counts: list.counts, items: list.items.map((c) => summarize(c, tzOf(c))) };
}

function cmdShow(args: ParsedArgs): unknown {
  const id = requireId(args, 'show <id>');
  const detail = getContentDetail(id);
  return { ...detail, scheduledLocal: detail.scheduledAt ? formatLocal(detail.scheduledAt, tzOf(detail)) : null };
}

function inputFromFlags(args: ParsedArgs): FbContentInput {
  const input: FbContentInput = {};
  const set = <K extends keyof FbContentInput>(key: K, value: FbContentInput[K] | undefined): void => {
    if (value !== undefined) input[key] = value;
  };
  set('title', one(args, 'title'));
  set('caption', one(args, 'caption'));
  const format = one(args, 'format');
  if (format !== undefined) input.format = checkFormat(format);
  set('pillar', one(args, 'pillar'));
  set('hookType', one(args, 'hook-type'));
  set('cta', one(args, 'cta'));
  set('campaign', one(args, 'campaign'));
  set('linkUrl', one(args, 'link'));
  set('hooks', many(args, 'hook'));
  return input;
}

function cmdAdd(args: ParsedArgs, actor: Actor): unknown {
  const page = resolvePage(one(args, 'page'));
  const format = one(args, 'format');
  const title = one(args, 'title');
  if (!format || !title) throw new CliUsageError('add cần --page, --format và --title.');
  const input: FbContentInput = { ...inputFromFlags(args), pageId: page.id, format: checkFormat(format), title, status: 'review' };

  const scheduleText = one(args, 'schedule');
  const at = scheduleText ? parseTime(scheduleText, page) : null;
  const approvalOff = page.approval_required === 0;
  // With approval off the time must satisfy the Page rules; check before anything is created.
  if (approvalOff && at !== null) assertScheduleAllowed(page, at, undefined);
  if (at !== null) input.scheduledAt = at;

  const created = createContent(input, actor);
  const warnings: string[] = [];
  const mediaPaths = many(args, 'media');
  try {
    if (mediaPaths?.length) {
      const media = importMediaFiles(created.id, mediaPaths);
      updateContent(created.id, { media }, actor);
    }
  } catch (err) {
    deleteContentLocal(created.id);
    throw err;
  }

  let result = getContentDetail(created.id) as FbContentDto;
  if (approvalOff) {
    try {
      result = approveContent(created.id, at);
    } catch (err) {
      if (!(err instanceof FbError)) throw err;
      warnings.push(`Chưa duyệt tự động được: ${err.message}`);
    }
  }
  return {
    ok: true,
    content: summarize(result, page.timezone),
    approvalRequired: !approvalOff,
    warnings,
    next: result.status === 'review' ? 'Bài đang chờ chủ kênh duyệt trong Content Studio.' : undefined,
  };
}

function cmdUpdate(args: ParsedArgs, actor: Actor): unknown {
  const id = requireId(args, 'update <id> [--title ...]');
  const row = getFbContent(id);
  if (!row) throw new FbError(404, 'Không tìm thấy bài.');
  const input = inputFromFlags(args);

  const pageRef = one(args, 'page');
  const page = pageRef ? resolvePage(pageRef) : row.page_id ? listFbPages().find((p) => p.id === row.page_id) : undefined;
  if (pageRef && page) input.pageId = page.id;
  const scheduleText = one(args, 'schedule');
  if (scheduleText !== undefined) {
    if (!page) throw new CliUsageError('Bài chưa có Fanpage, thêm --page để đặt giờ.');
    input.scheduledAt = parseTime(scheduleText, page);
  }
  const mediaPaths = many(args, 'media');
  if (mediaPaths) input.media = importMediaFiles(id, mediaPaths, `${Date.now().toString(36)}-`);
  if (Object.keys(input).length === 0) throw new CliUsageError('update cần ít nhất một cờ để sửa (--title, --caption, --media, ...).');

  const updated = updateContent(id, input, actor);
  return { ok: true, content: summarize(updated, page?.timezone ?? tzOf(updated)) };
}

function cmdSchedule(args: ParsedArgs, actor: Actor): unknown {
  const id = args.positional[0] && Number.isInteger(Number(args.positional[0])) ? Number(args.positional[0]) : NaN;
  const text = args.positional[1];
  if (!Number.isInteger(id) || !text) throw new CliUsageError('Cách dùng: schedule <id> "YYYY-MM-DD HH:MM"');
  const row = getFbContent(id);
  if (!row) throw new FbError(404, 'Không tìm thấy bài.');
  const page = row.page_id ? listFbPages().find((p) => p.id === row.page_id) : undefined;
  if (!page) throw new FbError(400, 'Bài chưa có Fanpage.');
  const at = parseTime(text, page);

  const awaitingApproval = !['approved', 'scheduled'].includes(row.status) && page.approval_required === 1;
  const updated = awaitingApproval || ['approved', 'scheduled'].includes(row.status)
    ? updateContent(id, { scheduledAt: at }, actor)
    : approveContent(id, at);
  return {
    ok: true,
    content: summarize(updated, page.timezone),
    note: awaitingApproval ? 'Đã ghi giờ đề xuất; bài vẫn chờ chủ kênh duyệt trong Content Studio.' : undefined,
  };
}

function cmdInsights(args: ParsedArgs): unknown {
  const page = resolvePage(one(args, 'page'));
  const insight = getLatestFbChannelInsight(page.id);
  const body = insight ? parseJson<{ summary?: string[]; actions?: string[] }>(insight.body_json, {}) : null;
  const rows = listFbPostsWithMetrics(page.id, nowSec() - 90 * 86400)
    .map((r) => ({
      contentId: r.id,
      postId: r.fb_post_id,
      title: r.title || r.caption.slice(0, 60),
      format: r.format,
      pillar: r.pillar,
      hookType: r.hook_type,
      publishedAt: r.published_at,
      reach: r.reach,
      er: engagementRate({ reach: r.reach, reactions: r.reactions, comments: r.m_comments, shares: r.m_shares }),
    }))
    .filter((r) => r.er !== null)
    .sort((a, b) => (b.er as number) - (a.er as number));
  return {
    page: { id: page.id, name: page.name, mainKpi: page.main_kpi, brandVoice: page.brand_voice, pillars: parsePillars(page.pillars_json) },
    analyst: body ? { summary: body.summary ?? [], actions: body.actions ?? [], createdAt: insight?.created_at ?? null } : null,
    topPosts: rows.slice(0, 5),
    note: rows.length === 0 && !body ? 'Chưa có dữ liệu phân tích cho Fanpage này (analytics chưa chạy).' : undefined,
  };
}

function daysFlag(args: ParsedArgs): number | undefined {
  const raw = one(args, 'days');
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new CliUsageError('--days phải là số ngày nguyên dương.');
  return n;
}

// Read-only analytics: the same data as the Hiệu quả kênh / bài đăng / Quảng cáo screens (agent-view.ts).

function cmdChannel(args: ParsedArgs): unknown {
  const page = resolvePage(one(args, 'page'));
  const view = channelView(page.id, daysFlag(args));
  if (!view) throw new FbError(404, `Fanpage "${page.name}" chưa có số liệu phân tích.`);
  return view;
}

function cmdPosts(args: ParsedArgs): unknown {
  const page = resolvePage(one(args, 'page'));
  const view = postsView(page.id, daysFlag(args), one(args, 'milestone'));
  if (!view) throw new FbError(404, `Fanpage "${page.name}" chưa có số liệu phân tích.`);
  return view;
}

function cmdPost(args: ParsedArgs): unknown {
  const postId = args.positional[0];
  if (!postId) throw new CliUsageError('Thiếu mã bài Facebook. Cách dùng: post <postId>');
  const view = postView(postId);
  if (!view) throw new FbError(404, `Không tìm thấy số liệu của bài ${postId}.`);
  return view;
}

export const COMMANDS = ['pages', 'list', 'show', 'add', 'update', 'schedule', 'insights', 'channel', 'posts', 'post'] as const;

/** Runs one command. `agentId` becomes the post's `source`. */
export function runCommand(argv: string[], agentId: string): unknown {
  const args = parseArgs(argv);
  const agentOverride = one(args, 'agent');
  const actor: Actor = { kind: 'agent', id: (agentOverride || agentId || 'main').trim() || 'main' };
  switch (args.command) {
    case 'pages': return cmdPages(args);
    case 'list': return cmdList(args);
    case 'show': return cmdShow(args);
    case 'add': return cmdAdd(args, actor);
    case 'update': return cmdUpdate(args, actor);
    case 'schedule': return cmdSchedule(args, actor);
    case 'insights': return cmdInsights(args);
    case 'channel': return cmdChannel(args);
    case 'posts': return cmdPosts(args);
    case 'post': return cmdPost(args);
    default:
      throw new CliUsageError(`Lệnh không hợp lệ: "${args.command}". Các lệnh: ${COMMANDS.join(' | ')}`);
  }
}

