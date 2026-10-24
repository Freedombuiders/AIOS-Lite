/**
 * Shared inbox v2: a local copy of the images and files customers send over Zalo. The stored message body only
 * carries CDN links and Zalo expires them, so the inbox downloads each one once, the first time somebody looks at
 * it, into <dataDir>/media-cache and serves the copy afterwards (docs/plans/care-inbox-v2.md).
 *
 * Safety: only https Zalo CDN hosts are fetched (never an arbitrary URL from chat), every redirect hop is
 * re-checked against the same allowlist, a download is capped in size and time, and an "image" is served only
 * when its magic bytes say so. A failed download is remembered for an hour so a dead link is not hit on every view.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { ZALO_MEDIA_CACHE_DIR } from './paths.js';
import { deleteZaloMediaCache, getZaloMediaCache, getZaloMessage, saveZaloMediaCache } from './store.js';
import { logger } from './compat.js';
import { classifyMedia, safeMediaName } from './media.js';

export { ZALO_MEDIA_CACHE_DIR };

export const MEDIA_CACHE_MAX_BYTES = 15 * 1024 * 1024;
export const MEDIA_CACHE_TIMEOUT_MS = 15_000;
/** A failed URL is not fetched again for this long. */
export const MEDIA_CACHE_RETRY_SEC = 3600;
const MAX_REDIRECTS = 3;

/** Zalo CDN hosts: the one the legacy image reader trusts (turn-images.ts) plus the ones the Care Zalo connector lists. */
const HOST_SUFFIXES = ['zdn.vn', 'zadn.vn', 'zalo.me', 'zaloapp.com', 'zalo.vn'];

/** Content types whose body can carry a downloadable file. */
const MEDIA_CONTENT_TYPES = new Set(['image', 'gif', 'video', 'file']);
const URL_KEYS = ['hdUrl', 'href', 'normalUrl', 'thumb'] as const;
const ALBUM_KEYS = ['images', 'photos', 'medias', 'items', 'list', 'attachments'] as const;

export interface CachedZaloMedia {
  filePath: string;
  mime: string;
  fileName: string;
}

export interface MediaCacheDeps {
  fetchImpl?: typeof fetch;
  /** Seconds. */
  nowSec?: () => number;
}

type Obj = Record<string, unknown>;

function parseObj(body: string): Obj | null {
  if (!body.startsWith('{')) return null;
  try {
    const v = JSON.parse(body) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null;
  } catch {
    return null;
  }
}

/** https, no credentials, default port, and a Zalo CDN host (no look-alike such as `zdn.vn.evil.com`). */
export function isAllowedZaloMediaUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
    const host = url.hostname.toLowerCase();
    return HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
  } catch {
    return false;
  }
}

function firstAllowedUrl(obj: Obj): string | null {
  for (const key of URL_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && isAllowedZaloMediaUrl(v)) return new URL(v).href;
  }
  return null;
}

/**
 * Downloadable URLs of one stored message, in display order. One entry for a normal photo/file; several when the
 * payload carries an album-style list (each element a URL or an object with the usual URL keys).
 */
export function zaloMediaUrls(contentType: string, body: string): string[] {
  if (!MEDIA_CONTENT_TYPES.has(contentType)) return [];
  const obj = parseObj(body);
  if (!obj) return [];
  for (const key of ALBUM_KEYS) {
    const list = obj[key];
    if (!Array.isArray(list)) continue;
    const urls: string[] = [];
    for (const item of list) {
      if (typeof item === 'string') {
        if (isAllowedZaloMediaUrl(item)) urls.push(new URL(item).href);
      } else if (item && typeof item === 'object') {
        const u = firstAllowedUrl(item as Obj);
        if (u) urls.push(u);
      }
    }
    if (urls.length > 0) return urls;
  }
  const single = firstAllowedUrl(obj);
  return single ? [single] : [];
}

class CacheFetchError extends Error {}

async function download(url: string, fetchImpl: typeof fetch): Promise<{ buffer: Buffer; contentType: string }> {
  const signal = AbortSignal.timeout(MEDIA_CACHE_TIMEOUT_MS);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedZaloMediaUrl(current)) throw new CacheFetchError('host_not_allowed');
    const res = await fetchImpl(current, { signal, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new CacheFetchError('bad_redirect');
      await res.body?.cancel().catch(() => {});
      current = new URL(location, current).href;
      continue;
    }
    if (!res.ok || !res.body) throw new CacheFetchError(`http_${res.status}`);
    if (Number(res.headers.get('content-length')) > MEDIA_CACHE_MAX_BYTES) {
      await res.body.cancel().catch(() => {});
      throw new CacheFetchError('too_large');
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > MEDIA_CACHE_MAX_BYTES) throw new CacheFetchError('too_large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (bytes === 0) throw new CacheFetchError('empty');
    return { buffer: Buffer.concat(chunks), contentType: res.headers.get('content-type') ?? '' };
  }
  throw new CacheFetchError('too_many_redirects');
}

function safeExt(name: string): string {
  return path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
}

function cachedPath(relPath: string): string | null {
  if (!relPath) return null;
  const root = path.resolve(ZALO_MEDIA_CACHE_DIR);
  const full = path.resolve(root, relPath);
  return full.startsWith(root + path.sep) ? full : null;
}

const inflight = new Map<string, Promise<CachedZaloMedia | null>>();

/**
 * The cached copy of media `index` of a legacy Zalo message (zalo_messages.id), downloading it on first use.
 * Null when the message has no such media, the URL is not an allowed Zalo CDN link, or the download failed
 * (a failure is remembered for MEDIA_CACHE_RETRY_SEC).
 */
export function getCachedZaloMedia(legacyMessageId: number, index: number, deps: MediaCacheDeps = {}): Promise<CachedZaloMedia | null> {
  const key = `${legacyMessageId}:${index}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = fetchAndStore(legacyMessageId, index, deps).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function fetchAndStore(messageId: number, index: number, deps: MediaCacheDeps): Promise<CachedZaloMedia | null> {
  if (!Number.isInteger(messageId) || !Number.isInteger(index) || index < 0) return null;
  const now = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const message = getZaloMessage(messageId);
  if (!message || message.is_deleted) return null;
  const url = zaloMediaUrls(message.content_type, message.body)[index];
  if (!url) return null;

  const cached = getZaloMediaCache(messageId, index);
  if (cached && !cached.error) {
    const full = cachedPath(cached.rel_path);
    if (full && fs.existsSync(full)) return { filePath: full, mime: cached.mime, fileName: cached.file_name };
    deleteZaloMediaCache(messageId, index); // file vanished: fetch again
  } else if (cached && now() - cached.fetched_at < MEDIA_CACHE_RETRY_SEC) {
    return null;
  }

  try {
    const { buffer, contentType } = await download(url, deps.fetchImpl ?? fetch);
    const classified = classifyMedia(buffer, contentType);
    // "Image" messages are served inline by the Care route: insist on real image bytes.
    if ((message.content_type === 'image' || message.content_type === 'gif') && classified.kind !== 'image') {
      throw new CacheFetchError('not_image');
    }
    const obj = parseObj(message.body);
    const title = obj && typeof obj.title === 'string' ? obj.title : '';
    const imageExt = classified.kind === 'image' ? `.${classified.mime === 'image/jpeg' ? 'jpg' : classified.mime.split('/')[1]}` : '';
    const fileName = safeMediaName(title || `zalo-${messageId}${index > 0 ? `-${index + 1}` : ''}${imageExt || safeExt(new URL(url).pathname)}`);
    const ext = classified.kind === 'image' ? imageExt : safeExt(fileName);
    const relPath = `${crypto.randomUUID()}${ext}`;
    fs.mkdirSync(ZALO_MEDIA_CACHE_DIR, { recursive: true, mode: 0o700 });
    const full = path.join(ZALO_MEDIA_CACHE_DIR, relPath);
    fs.writeFileSync(full, buffer, { mode: 0o600 });
    try {
      saveZaloMediaCache({ message_id: messageId, idx: index, rel_path: relPath, mime: classified.mime, file_name: fileName, size: buffer.length, fetched_at: now(), error: '' });
    } catch (err) {
      fs.rmSync(full, { force: true });
      throw err;
    }
    return { filePath: full, mime: classified.mime, fileName };
  } catch (err) {
    const code = err instanceof CacheFetchError ? err.message : (err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError' ? 'timeout' : 'fetch_failed';
    logger.warn({ messageId, index, code }, 'zalo media cache: download failed');
    saveZaloMediaCache({ message_id: messageId, idx: index, rel_path: '', mime: '', file_name: '', size: 0, fetched_at: now(), error: code });
    return null;
  }
}
