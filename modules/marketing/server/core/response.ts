/**
 * Composio tool responses have no declared output schema and wrap their
 * payload differently per tool (`data`, `response_data`, `data.data`, …).
 * These helpers dig for the few things we need without trusting the shape.
 */

const WRAPPER_KEYS = ['data', 'response_data', 'items', 'pages', 'results', 'result'];

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** First array of rows in a (possibly nested) response, or []. */
export function findRows(data: unknown, depth = 0): unknown[] {
  if (Array.isArray(data)) return data;
  if (!isObject(data) || depth > 4) return [];
  for (const key of WRAPPER_KEYS) {
    const inner = data[key];
    if (Array.isArray(inner)) return inner;
  }
  for (const key of WRAPPER_KEYS) {
    const inner = data[key];
    if (isObject(inner)) {
      const rows = findRows(inner, depth + 1);
      if (rows.length) return rows;
    }
  }
  return [];
}

/** The `after` cursor when the response says there is a next page, else null. */
export function findNextCursor(data: unknown, depth = 0): string | null {
  if (!isObject(data) || depth > 4) return null;
  const paging = data.paging;
  if (isObject(paging)) {
    const cursors = paging.cursors;
    const after = isObject(cursors) ? cursors.after : undefined;
    if (typeof after === 'string' && after && paging.next) return after;
    return null;
  }
  for (const key of WRAPPER_KEYS) {
    const inner = data[key];
    if (isObject(inner)) {
      const found = findNextCursor(inner, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Breadth-first search for the first string-or-number value under any of `keys` (earlier keys win). */
export function findScalar(data: unknown, keys: string[]): string | null {
  const queue: unknown[] = [data];
  const found = new Map<string, string>();
  let visited = 0;
  while (queue.length && visited < 200) {
    const node = queue.shift();
    visited++;
    if (Array.isArray(node)) {
      queue.push(...node);
    } else if (isObject(node)) {
      for (const key of keys) {
        const v = node[key];
        if (!found.has(key) && (typeof v === 'string' || typeof v === 'number') && String(v)) found.set(key, String(v));
      }
      queue.push(...Object.values(node));
    }
  }
  for (const key of keys) {
    const v = found.get(key);
    if (v) return v;
  }
  return null;
}

/** The id of the created post: `post_id` (photo posts) wins over `id`. */
export function extractPostId(data: unknown): string | null {
  return findScalar(data, ['post_id', 'id', 'video_id']);
}

/** Numeric ids of uploaded photos from a batch-upload response, in order, without duplicates. */
export function extractPhotoIds(data: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (v: unknown): void => {
    if ((typeof v === 'string' || typeof v === 'number') && /^\d+$/.test(String(v)) && !seen.has(String(v))) {
      seen.add(String(v));
      out.push(String(v));
    }
  };
  const walk = (node: unknown, depth: number): void => {
    if (depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (typeof item === 'string' || typeof item === 'number') add(item);
        else walk(item, depth + 1);
      }
    } else if (isObject(node)) {
      if ('id' in node || 'photo_id' in node) {
        add(node.photo_id ?? node.id);
      }
      for (const [k, v] of Object.entries(node)) {
        if (k === 'id' || k === 'photo_id' || k === 'headers') continue;
        // FACEBOOK_UPLOAD_PHOTOS_BATCH returns Graph batch results:
        // {responses: [{code: 200, body: "{\"id\":\"…\"}"}]} — body is a JSON string.
        if (k === 'body' && typeof v === 'string') {
          try { walk(JSON.parse(v), depth + 1); } catch { /* not JSON */ }
          continue;
        }
        walk(v, depth + 1);
      }
    }
  };
  walk(data, 0);
  return out;
}

/** Page picture from either `picture: "url"` or Graph's `picture: { data: { url } }`. */
export function extractPictureUrl(row: Record<string, unknown>): string {
  const pic = row.picture;
  if (typeof pic === 'string') return pic;
  if (isObject(pic)) {
    if (typeof pic.url === 'string') return pic.url;
    if (isObject(pic.data) && typeof pic.data.url === 'string') return pic.data.url;
  }
  return '';
}

export function extractFollowers(row: unknown): number | null {
  if (!isObject(row)) return null;
  for (const key of ['followers_count', 'fan_count']) {
    const v = row[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  }
  return null;
}
