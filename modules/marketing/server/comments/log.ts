/**
 * Builds the comment log DTO (KPIs, hourly chart, topics, rows) from SQLite.
 */

import {
  listFbCommentsForLog,
  listFbCommentsSince,
  topFbCommentTopics,
  type FbCommentLogRow,
  type FbCommentPageRow,
  type FbCommentRow,
} from '../store.js';
import type { CommentLogDto, CommentLogRowDto, CommentStatus, CommentStep } from '../types.js';
import { loadPageRules } from './config.js';
import { loadTemplates } from './processor.js';
import { countWords, ruleLabel } from './rules.js';
import { getLastPollAt } from './state.js';

const nowSec = (): number => Math.floor(Date.now() / 1000);

export type LogKind = 'all' | 'template' | 'agent' | 'other';

export function logKindOf(step: string): Exclude<LogKind, 'all'> {
  return step === 'template' ? 'template' : step === 'agent' ? 'agent' : 'other';
}

export function commentPermalink(row: { id: string; post_id: string; post_permalink?: string }): string {
  const commentNumber = row.id.includes('_') ? row.id.slice(row.id.lastIndexOf('_') + 1) : row.id;
  const base = row.post_permalink || `https://www.facebook.com/${row.post_id}`;
  return `${base}${base.includes('?') ? '&' : '?'}comment_id=${commentNumber}`;
}

function postTitleOf(raw: string): string {
  const line = raw.split('\n').find((l) => l.trim()) ?? '';
  return line.trim().slice(0, 90);
}

export function toRowDto(row: FbCommentLogRow, templateNames: Map<number, string>): CommentLogRowDto {
  let templateName: string | null = null;
  if (row.step === 'template') {
    const id = Number(row.rule_ref.split(':')[1]);
    templateName = templateNames.get(id) ?? null;
  }
  return {
    id: row.id,
    pageId: row.page_id,
    postId: row.post_id,
    postTitle: postTitleOf(row.post_title),
    authorName: row.author_name,
    message: row.message,
    words: countWords(row.message),
    createdTime: row.created_time,
    step: row.step as CommentStep | '',
    ruleLabel: ruleLabel(row.step, row.rule_ref, templateName),
    reason: row.reason,
    replyText: row.reply_text,
    privateText: row.private_text,
    privateSent: row.private_sent === 1,
    status: row.status as CommentStatus,
    sentAt: row.sent_at,
    error: row.error,
    permalink: commentPermalink(row),
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function hourOfDay(sec: number, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(sec * 1000));
    return Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  } catch {
    return new Date(sec * 1000).getUTCHours();
  }
}

function buildHourly(rows: FbCommentRow[], now: number, timezone: string): CommentLogDto['hourly'] {
  const currentHour = now - (now % 3600);
  const buckets = Array.from({ length: 24 }, (_, i) => {
    const start = currentHour - (23 - i) * 3600;
    return { start, hour: hourOfDay(start, timezone), template: 0, agent: 0, other: 0 };
  });
  for (const r of rows) {
    const idx = Math.floor((r.created_time - buckets[0].start) / 3600);
    if (idx < 0 || idx > 23) continue;
    buckets[idx][logKindOf(r.step)]++;
  }
  return buckets.map(({ hour, template, agent, other }) => ({ hour, template, agent, other }));
}

export function buildCommentLog(page: FbCommentPageRow, kind: LogKind, limit: number, now: number = nowSec()): CommentLogDto {
  const rules = loadPageRules(page.id);
  const recent = listFbCommentsSince(page.id, now - 86400);

  const sent = recent.filter((r) => r.status === 'sent');
  const counts = { all: recent.length, template: 0, agent: 0, other: 0 };
  for (const r of recent) counts[logKindOf(r.step)]++;

  const templateNames = new Map(loadTemplates(page.id).map((t) => [t.id, t.name]));
  const rows = listFbCommentsForLog(page.id, 1000)
    .filter((r) => kind === 'all' || logKindOf(r.step) === kind)
    .slice(0, limit)
    .map((r) => toRowDto(r, templateNames));

  return {
    pageId: page.id,
    autoReplyEnabled: Boolean(page.enabled) && rules.enabled,
    pollMinutes: rules.pollMinutes,
    lastPollAt: getLastPollAt(page.id),
    kpis: {
      new24h: recent.length,
      autoReplied24h: sent.length,
      byTemplate24h: sent.filter((r) => r.step === 'template').length,
      byAgent24h: sent.filter((r) => r.step === 'agent').length,
      hidden24h: recent.filter((r) => r.status === 'hidden').length,
      human24h: recent.filter((r) => r.status === 'human').length,
      medianResponseS: median(sent.filter((r) => r.sent_at != null).map((r) => Math.max(0, (r.sent_at as number) - r.created_time))),
    },
    hourly: buildHourly(recent, now, page.timezone || 'Asia/Ho_Chi_Minh'),
    topics: topFbCommentTopics(page.id, now - 7 * 86400, 5),
    counts,
    rows,
  };
}
