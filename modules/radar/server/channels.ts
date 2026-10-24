/**
 * Followed social channels: turn a pasted link or @handle into a Radar source.
 * Pure (no node imports): the web settings screen imports it too.
 */

export type ChannelPlatform = 'fb_group' | 'fb_page' | 'instagram' | 'x' | 'threads' | 'tiktok' | 'youtube';

export interface ParsedChannel {
  platform: ChannelPlatform;
  /** Canonical link to the channel. */
  url: string;
  /** Group id / page slug / username without @; YouTube: "@handle" or the UC… channel id. */
  handle: string;
}

export const CHANNEL_LABEL: Record<ChannelPlatform, string> = {
  fb_group: 'Nhóm Facebook',
  fb_page: 'Fanpage / trang cá nhân',
  instagram: 'Instagram',
  x: 'X',
  threads: 'Threads',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

const IG_HANDLE = /^[A-Za-z0-9._]{1,30}$/;
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const FB_SLUG = /^[A-Za-z0-9.\-_]{2,}$/;
const THREADS_HANDLE = /^[A-Za-z0-9._]{1,30}$/;
const TIKTOK_HANDLE = /^[A-Za-z0-9._]{2,24}$/;
const YT_HANDLE = /^[A-Za-z0-9._-]{3,30}$/;
const YT_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

// First path segments that are not a profile on each site.
const IG_RESERVED = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'direct', 'tv']);
const X_RESERVED = new Set(['i', 'home', 'search', 'explore', 'hashtag', 'intent', 'share', 'notifications', 'messages', 'settings']);
const FB_RESERVED = new Set(['watch', 'events', 'marketplace', 'gaming', 'photo', 'photo.php', 'story.php', 'permalink.php', 'reel', 'reels', 'stories', 'hashtag', 'search', 'login', 'home.php']);

function toUrl(input: string): URL | null {
  if (!/^(https?:\/\/)?([a-z0-9-]+\.)*(facebook\.com|fb\.com|instagram\.com|x\.com|twitter\.com|threads\.net|threads\.com|tiktok\.com|youtube\.com)(\/|$)/i.test(input)) return null;
  try { return new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`); } catch { return null; }
}

function fbFromUrl(u: URL): ParsedChannel | null {
  const seg = u.pathname.split('/').filter(Boolean);
  if (!seg.length) return null;
  if (seg[0] === 'groups' && seg[1]) {
    return { platform: 'fb_group', handle: seg[1], url: `https://www.facebook.com/groups/${seg[1]}` };
  }
  if (seg[0] === 'share' && seg[1] === 'g' && seg[2]) {
    return { platform: 'fb_group', handle: seg[2], url: `https://www.facebook.com/share/g/${seg[2]}/` };
  }
  if (seg[0] === 'profile.php') {
    const id = u.searchParams.get('id');
    return id && /^\d+$/.test(id) ? { platform: 'fb_page', handle: id, url: `https://www.facebook.com/profile.php?id=${id}` } : null;
  }
  // facebook.com/people/Name/12345 → the numeric id is the stable handle.
  if (seg[0] === 'people' && seg[2] && /^\d+$/.test(seg[2])) {
    return { platform: 'fb_page', handle: seg[2], url: `https://www.facebook.com/profile.php?id=${seg[2]}` };
  }
  if (seg[0] === 'pg' && seg[1]) seg.shift();
  if (FB_RESERVED.has(seg[0].toLowerCase()) || seg[0] === 'share' || !FB_SLUG.test(seg[0])) return null;
  return { platform: 'fb_page', handle: seg[0], url: `https://www.facebook.com/${seg[0]}` };
}

function ytFromUrl(u: URL): ParsedChannel | null {
  const seg = u.pathname.split('/').filter(Boolean);
  if (seg[0]?.startsWith('@') && YT_HANDLE.test(seg[0].slice(1))) {
    return { platform: 'youtube', handle: seg[0], url: `https://www.youtube.com/${seg[0]}` };
  }
  if (seg[0] === 'channel' && seg[1] && YT_CHANNEL_ID.test(seg[1])) {
    return { platform: 'youtube', handle: seg[1], url: `https://www.youtube.com/channel/${seg[1]}` };
  }
  return null;
}

/**
 * Parses a pasted link (facebook.com/groups/…, facebook.com/<page>, instagram.com/<user>, x.com/<user>)
 * or a bare @handle. A bare handle needs `hint` to know the platform; a link decides by itself,
 * except that `hint` 'fb_group' turns a bare Facebook slug into a group.
 */
export function parseChannel(input: string, hint?: ChannelPlatform): ParsedChannel | null {
  const raw = input.trim();
  if (!raw) return null;
  const u = toUrl(raw);
  if (u) {
    const host = u.hostname.toLowerCase();
    const first = u.pathname.split('/').filter(Boolean)[0] ?? '';
    if (/(^|\.)(facebook|fb)\.com$/.test(host)) return fbFromUrl(u);
    if (/(^|\.)threads\.(net|com)$/.test(host)) {
      const h = first.replace(/^@/, '');
      return first.startsWith('@') && THREADS_HANDLE.test(h) ? { platform: 'threads', handle: h, url: `https://www.threads.net/@${h}` } : null;
    }
    if (/(^|\.)tiktok\.com$/.test(host)) {
      const h = first.replace(/^@/, '');
      return first.startsWith('@') && TIKTOK_HANDLE.test(h) ? { platform: 'tiktok', handle: h, url: `https://www.tiktok.com/@${h}` } : null;
    }
    if (/(^|\.)youtube\.com$/.test(host)) return ytFromUrl(u);
    if (/(^|\.)instagram\.com$/.test(host)) {
      return IG_HANDLE.test(first) && !IG_RESERVED.has(first.toLowerCase())
        ? { platform: 'instagram', handle: first, url: `https://www.instagram.com/${first}/` } : null;
    }
    return X_HANDLE.test(first) && !X_RESERVED.has(first.toLowerCase())
      ? { platform: 'x', handle: first, url: `https://x.com/${first}` } : null;
  }
  if (/[\s/]/.test(raw) || !hint) return null;
  const h = raw.replace(/^@/, '');
  switch (hint) {
    case 'instagram': return IG_HANDLE.test(h) ? { platform: 'instagram', handle: h, url: `https://www.instagram.com/${h}/` } : null;
    case 'x': return X_HANDLE.test(h) ? { platform: 'x', handle: h, url: `https://x.com/${h}` } : null;
    case 'fb_group': return FB_SLUG.test(h) ? { platform: 'fb_group', handle: h, url: `https://www.facebook.com/groups/${h}` } : null;
    case 'fb_page': return FB_SLUG.test(h) ? { platform: 'fb_page', handle: h, url: `https://www.facebook.com/${h}` } : null;
    case 'threads': return THREADS_HANDLE.test(h) ? { platform: 'threads', handle: h, url: `https://www.threads.net/@${h}` } : null;
    case 'tiktok': return TIKTOK_HANDLE.test(h) ? { platform: 'tiktok', handle: h, url: `https://www.tiktok.com/@${h}` } : null;
    case 'youtube':
      if (YT_CHANNEL_ID.test(h)) return { platform: 'youtube', handle: h, url: `https://www.youtube.com/channel/${h}` };
      return YT_HANDLE.test(h) ? { platform: 'youtube', handle: `@${h}`, url: `https://www.youtube.com/@${h}` } : null;
  }
}

/** Username of an Instagram, X, Threads or TikTok entry, which may be stored as a link, @name or name. */
export function socialHandle(value: string, platform: 'instagram' | 'x' | 'threads' | 'tiktok'): string {
  return parseChannel(value, platform)?.handle ?? value.trim().replace(/^@/, '');
}
