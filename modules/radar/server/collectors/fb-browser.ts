/**
 * Experimental: private Facebook groups through a logged-in Chrome profile (playwright, loaded dynamically
 * so the server starts without it). Parsing is in pure functions with unit tests; the DOM work runs as
 * string scripts so this file needs no DOM typings.
 */

import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { logger } from '../log.js';
import type { FbGroupSource, RawComment, RawItem } from '../types.js';
import { canonicalUrl } from '../util.js';
import { makeItem } from './parse.js';
import { radarHome } from './x-grok.js';

export const LOGIN_ERROR = 'Chrome của Radar chưa đăng nhập Facebook.';
const MAX_GROUPS = 15;

export function profileDir(): string { return path.join(radarHome(), 'chrome-profile'); }
export function profileExists(): boolean { return existsSync(profileDir()); }

// ── Pure parsing ────────────────────────────────────────────────────────

/** "123" → 123, "1,2K" → 1200, "1.234" → 1234, "2,5 triệu" → 2500000. */
export function parseCount(label: string): number | undefined {
  const m = /^\s*(\d[\d.,]*)\s*(k|m|n|nghìn|triệu|tr)?\b/i.exec(label);
  if (!m) return undefined;
  const suffix = (m[2] ?? '').toLowerCase();
  if (suffix) {
    const mult = suffix === 'k' || suffix === 'n' || suffix === 'nghìn' ? 1_000 : 1_000_000;
    const v = parseFloat(m[1].replace(',', '.'));
    return Number.isFinite(v) ? Math.round(v * mult) : undefined;
  }
  const n = Number(m[1].replace(/[.,]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

const COUNT = '(\\d[\\d.,]*\\s*(?:[kKmMnN]|nghìn|triệu|tr)?)';

function firstCount(text: string, re: RegExp): number | undefined {
  const m = re.exec(text);
  return m ? parseCount(m[1].trim()) : undefined;
}

const UNIT_MS: Record<string, number> = {
  phút: 60_000, p: 60_000, m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  giờ: 3_600_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  ngày: 86_400_000, d: 86_400_000, day: 86_400_000, days: 86_400_000,
  tuần: 604_800_000, w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
};

/** "6 giờ", "1 ngày", "3h", "2 days" → ISO relative to `now`. */
export function relativeTimeToIso(label: string, now: Date): string | undefined {
  const m = /^(\d+)\s*(phút|giờ|ngày|tuần|min|mins|minutes?|hrs?|hours?|days?|weeks?|[pmhdw])$/i.exec(label.trim());
  if (!m) return undefined;
  const ms = UNIT_MS[m[2].toLowerCase()];
  return ms ? new Date(now.getTime() - Number(m[1]) * ms).toISOString() : undefined;
}

export interface FeedBlock {
  url: string;
  text: string;
  comments?: number;
  shares?: number;
  reactions?: number;
  postedText?: string;
}

const POST_HREF = /\/groups\/[^/]+\/(?:posts|permalink)\/\d+/;
const TIME_LINE = /^(\d+\s*(?:phút|giờ|ngày|tuần|min|mins|minutes?|hrs?|hours?|days?|weeks?|[hdw]))$/i;

/** One feed block (innerText + the first permalink href) → counts and time. Null without a post permalink. */
export function parseFeedBlock(text: string, href: string): FeedBlock | null {
  const m = POST_HREF.exec(href ?? '');
  if (!m) return null;
  const url = canonicalUrl(`https://www.facebook.com${m[0]}`);
  const comments = firstCount(text, new RegExp(`${COUNT}\\s*(?:bình luận|comments?)`, 'i'));
  const shares = firstCount(text, new RegExp(`${COUNT}\\s*(?:lượt chia sẻ|chia sẻ|shares?)`, 'i'));
  const reactions = firstCount(text, new RegExp(`(?:Tất cả cảm xúc|All reactions)\\s*:?\\s*${COUNT}`, 'i'));
  let postedText: string | undefined;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (TIME_LINE.test(t)) { postedText = t; break; }
    if (/^(hôm qua|yesterday)$/i.test(t)) { postedText = t; break; }
  }
  return {
    url, text: text.replace(/\s+/g, ' ').trim().slice(0, 3000),
    ...(comments !== undefined ? { comments } : {}),
    ...(shares !== undefined ? { shares } : {}),
    ...(reactions !== undefined ? { reactions } : {}),
    ...(postedText ? { postedText } : {}),
  };
}

/** "2,9K thành viên" / "12.345 members" → 12345. */
export function parseMembers(text: string): number | undefined {
  return firstCount(text, new RegExp(`${COUNT}\\s*(?:thành viên|members?)`, 'i'));
}

// ── Browser session ─────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = any;
type Context = any;

const rnd = (min: number, max: number) => min + Math.floor(Math.random() * (max - min));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FEED_SCRIPT = `(() => {
  const uniq = [];
  let blocks = Array.from(document.querySelectorAll('div[role="feed"] > div'));
  if (!blocks.length) blocks = Array.from(document.querySelectorAll('[role="article"]')).filter(a => !a.parentElement.closest('[role="article"]'));
  for (const b of blocks) {
    const a = Array.from(b.querySelectorAll('a[href]')).find(x => /\\/groups\\/[^/]+\\/(posts|permalink)\\/\\d+/.test(x.getAttribute('href') || ''));
    if (!a) continue;
    uniq.push({ text: (b.innerText || '').slice(0, 3000), href: a.getAttribute('href') });
  }
  return uniq;
})()`;

const COMMENT_SCRIPT = `(() => Array.from(document.querySelectorAll('[role="article"][aria-label*="Bình luận"], [role="article"][aria-label*="Comment"]')).map(a => (a.innerText || '').trim()).filter(Boolean).slice(0, 60))()`;

export interface BrowserGroupResult { items: RawItem[]; members?: number; error?: string }

export interface BrowserSession {
  readGroup(group: FbGroupSource, layer: RawItem['layer'], now: Date, maxPosts: number): Promise<BrowserGroupResult>;
  readComments(postUrl: string, perPost: number): Promise<RawComment[]>;
  close(): Promise<void>;
}

async function loadPlaywright(): Promise<any> {
  return import('playwright');
}

export async function browserAvailable(): Promise<boolean> {
  try { await loadPlaywright(); return true; } catch { return false; }
}

let loginHandle: { ctx: Context } | null = null;

async function launch(headless: boolean): Promise<Context> {
  const { chromium } = await loadPlaywright();
  mkdirSync(profileDir(), { recursive: true });
  return chromium.launchPersistentContext(profileDir(), { headless, viewport: { width: 1280, height: 900 }, locale: 'vi-VN' });
}

/** One headless context for a whole run; call close() at the end. */
export async function openBrowserSession(signal?: AbortSignal): Promise<BrowserSession> {
  const ctx: Context = await launch(true);
  let groups = 0;
  const loginWall = async (page: Page) => {
    const url: string = page.url();
    if (/\/login|checkpoint/.test(url)) return true;
    return (await page.locator('input[name="pass"]').count()) > 0;
  };
  return {
    async readGroup(group, layer, now, maxPosts) {
      if (++groups > MAX_GROUPS) return { items: [], error: 'Quá nhiều nhóm trong một lượt quét.' };
      const page: Page = await ctx.newPage();
      try {
        const base = group.url.split('?')[0].replace(/\/$/, '');
        await page.goto(`${base}?sorting_setting=CHRONOLOGICAL`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await pause(rnd(2500, 4000));
        if (await loginWall(page)) return { items: [], error: LOGIN_ERROR };
        const head: string = await page.evaluate('document.body ? document.body.innerText.slice(0, 6000) : ""');
        const members = parseMembers(head);
        for (let i = 0; i < 8 && !signal?.aborted; i++) {
          await page.mouse.wheel(0, rnd(1400, 2200));
          await pause(rnd(1200, 2200));
        }
        const blocks: { text: string; href: string }[] = await page.evaluate(FEED_SCRIPT);
        const seen = new Set<string>();
        const items: RawItem[] = [];
        for (const b of blocks) {
          const p = parseFeedBlock(b.text, b.href);
          if (!p || seen.has(p.url)) continue;
          seen.add(p.url);
          items.push(makeItem({
            layer, kind: 'fb_group', via: 'browser', sourceName: group.name, sourceUrl: group.url, url: p.url, text: p.text,
            postedAt: p.postedText ? relativeTimeToIso(p.postedText, now) : undefined, postedText: p.postedText,
            metrics: { comments: p.comments, reactions: p.reactions, shares: p.shares },
          }));
          if (items.length >= maxPosts) break;
        }
        return { items, ...(members !== undefined ? { members } : {}) };
      } catch (e) {
        logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'radar: browser group read failed');
        return { items: [], error: 'Không đọc được nhóm bằng Chrome của Radar.' };
      } finally {
        await page.close().catch(() => undefined);
      }
    },
    async readComments(postUrl, perPost) {
      const page: Page = await ctx.newPage();
      try {
        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await pause(rnd(2000, 3500));
        if (await loginWall(page)) return [];
        for (let i = 0; i < 4; i++) {
          const btn = page.locator('div[role="button"]:has-text("Xem thêm bình luận"), div[role="button"]:has-text("View more comments")').first();
          if (!(await btn.count())) break;
          await btn.click({ timeout: 3000 }).catch(() => undefined);
          await pause(rnd(1000, 1800));
        }
        const texts: string[] = await page.evaluate(COMMENT_SCRIPT);
        return texts.slice(0, perPost).map((t) => {
          const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
          const author = lines.length > 1 ? lines[0] : undefined;
          return { text: (author ? lines.slice(1) : lines).join(' ').slice(0, 1500), ...(author ? { author } : {}) };
        }).filter((c) => c.text);
      } catch {
        return [];
      } finally {
        await page.close().catch(() => undefined);
      }
    },
    async close() { await ctx.close().catch(() => undefined); },
  };
}

/** Headful window on the login page; returns at once. A second call reuses the open window. */
export async function openBrowserLogin(): Promise<{ ok: boolean; detail: string }> {
  try {
    if (loginHandle) {
      try {
        const pages = loginHandle.ctx.pages();
        if (pages.length) { await pages[0].bringToFront(); return { ok: true, detail: 'Cửa sổ đăng nhập Facebook đã mở sẵn. Đăng nhập xong, đóng cửa sổ.' }; }
      } catch { loginHandle = null; }
    }
    const ctx = await launch(false);
    loginHandle = { ctx };
    ctx.on('close', () => { loginHandle = null; });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined);
    return { ok: true, detail: 'Đã mở Chrome của Radar. Đăng nhập Facebook rồi đóng cửa sổ để lưu phiên.' };
  } catch (e) {
    loginHandle = null;
    const missing = e instanceof Error && /Cannot find (module|package)|ERR_MODULE_NOT_FOUND/.test(e.message);
    return { ok: false, detail: missing ? 'Chưa cài playwright, không mở được Chrome của Radar.' : 'Không mở được Chrome của Radar (chưa cài trình duyệt cho playwright?).' };
  }
}
