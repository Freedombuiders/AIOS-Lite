/**
 * Tolerant readers for Composio's Facebook tool responses. The tools wrap the
 * Graph API payload (`{data: [...], paging}`) and sometimes nest it one more
 * level (`{data: {data: [...]}}`), so lists and ids are found by shape.
 */

const LIST_KEYS = ['data', 'comments', 'posts', 'items', 'results'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The first array found under data/comments/posts/items/results, up to three levels deep. */
export function extractList(data: unknown, depth = 0): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter(isRecord);
  if (!isRecord(data) || depth > 3) return [];
  for (const key of LIST_KEYS) {
    if (key in data) {
      const found = extractList(data[key], depth + 1);
      if (found.length > 0 || Array.isArray(data[key])) return found;
    }
  }
  return [];
}

/** The `after` cursor of a Graph page when there is a next page, else null. */
export function nextCursor(data: unknown): string | null {
  if (!isRecord(data) || !isRecord(data.paging)) return null;
  const paging = data.paging;
  if (typeof paging.next !== 'string' || !paging.next) return null;
  const cursors = isRecord(paging.cursors) ? paging.cursors : null;
  return cursors && typeof cursors.after === 'string' && cursors.after ? cursors.after : null;
}

/** Id of a created object (`{id}` or `{data: {id}}`), or ''. */
export function extractId(data: unknown, depth = 0): string {
  if (!isRecord(data) || depth > 3) return '';
  if (typeof data.id === 'string' && data.id) return data.id;
  if (typeof data.id === 'number') return String(data.id);
  for (const key of ['data', 'response_data', 'result']) {
    const found = extractId(data[key], depth + 1);
    if (found) return found;
  }
  return '';
}

/** Facebook timestamps: ISO 8601 with `+0000`, or unix seconds/milliseconds. Returns unix seconds, or null. */
export function toSec(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value > 1e11 ? value / 1000 : value);
  if (typeof value !== 'string' || !value) return null;
  if (/^\d+$/.test(value)) return toSec(Number(value));
  const ms = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export interface ParsedPost {
  id: string;
  message: string;
  createdAt: number | null;
  permalink: string;
  commentCount: number;
}

export function parsePost(raw: Record<string, unknown>): ParsedPost | null {
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!id) return null;
  const comments = isRecord(raw.comments) ? raw.comments : null;
  const summary = comments && isRecord(comments.summary) ? comments.summary : null;
  const total = summary?.total_count ?? raw.comment_count ?? raw.comments_count;
  return {
    id,
    message: typeof raw.message === 'string' ? raw.message : typeof raw.story === 'string' ? raw.story : '',
    createdAt: toSec(raw.created_time),
    permalink: typeof raw.permalink_url === 'string' ? raw.permalink_url : '',
    commentCount: typeof total === 'number' && total >= 0 ? total : Array.isArray(comments?.data) ? (comments.data as unknown[]).length : 0,
  };
}

export interface ParsedComment {
  id: string;
  message: string;
  createdAt: number | null;
  authorId: string;
  authorName: string;
  parentId: string | null;
  isHidden: boolean;
}

export function parseComment(raw: Record<string, unknown>, postId: string): ParsedComment | null {
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!id) return null;
  const from = isRecord(raw.from) ? raw.from : null;
  const parent = isRecord(raw.parent) ? raw.parent : null;
  const parentId = parent && typeof parent.id === 'string' && parent.id && parent.id !== postId ? parent.id : null;
  return {
    id,
    message: typeof raw.message === 'string' ? raw.message : '',
    createdAt: toSec(raw.created_time),
    authorId: from && typeof from.id === 'string' ? from.id : '',
    authorName: from && typeof from.name === 'string' ? from.name : '',
    parentId,
    isHidden: raw.is_hidden === true,
  };
}
