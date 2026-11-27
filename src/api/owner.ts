// Owner principal of the core API.
//
// Any local process can reach 127.0.0.1, including an agent CLI that was given a shell, so "the request came from
// localhost" proves nothing. Routes that send to customers, approve or publish, write to an ad account, change module
// settings, agent access or runtime options, or install a data pack need the OWNER: either the AIOS_TOKEN bearer
// (scripts, CLI) or a browser session cookie that was paired with a one-time code printed on the server terminal.
//
// How a browser becomes the owner:
//   1. At start (and on request from the sign-in screen) the server prints a one-time pairing code and link to its own
//      terminal (process stdout, never through the logger). Codes live only in memory, expire after an hour, are
//      single-use and are burned after a few wrong guesses.
//   2. The owner opens the link (or types the code on the sign-in screen). The server answers with a session cookie:
//      HttpOnly, SameSite=Strict, Path=/. Only a SHA-256 hash of the session token is stored (owner_sessions).
//   3. Owner routes accept the cookie only from same-origin requests (Origin / Sec-Fetch-Site), so another site or
//      another localhost port cannot ride on it.
// Limits (also in docs/dev/OWNER-AUTH.md): an agent with a shell runs as the same OS user, so it can still read the
// browser's cookie store, the .env file (AIOS_TOKEN) or a log file the server's stdout is redirected to. This gate stops
// an agent (or injected instructions) from simply calling the API; it is not a sandbox.

import crypto from 'node:crypto';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { DB } from '../core/db.js';
import { protectValue } from '../core/redact.js';
import { errorBody } from './errors.js';
import { RUN_TOKEN_PATHS } from './routes/integrations.js';

export const OWNER_COOKIE = 'aios_owner';
/** Response header on every owner refusal, so the web client can show the sign-in screen whatever made the call. */
export const OWNER_HEADER = 'x-aios-owner';

const SESSION_TTL_SEC = 30 * 24 * 3600;
const CODE_TTL_MS = 60 * 60 * 1000;
const MAX_CODES = 3;
const MAX_WRONG_GUESSES = 5;
const REQUEST_COOLDOWN_MS = 20 * 1000;

// ------------------------------------------------------------------ the list

/** '*' = every state-changing method (POST, PUT, PATCH, DELETE). GET/HEAD are never owner-gated (read-only). */
type Method = '*' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Every route that needs the owner, in one place. Patterns use Hono syntax: `:x` is one path segment, a trailing `*`
 * is the rest of the path. owner.test.ts walks the registered route table and fails when a route that looks sensitive
 * (SENSITIVE_SEGMENTS) is not covered here or explicitly exempted in NOT_OWNER_ROUTES.
 */
export const OWNER_ROUTES: ReadonlyArray<readonly [Method, string, string]> = [
  // customer messages (care, zalo, comment replies)
  ['POST', '/api/m/care/conversations/:id/replies', 'gửi tin cho khách'],
  ['*', '/api/m/care/outbox/*', 'hàng gửi tin cho khách'],
  ['*', '/api/m/care/drafts/*', 'duyệt, sửa hoặc bỏ nháp trả lời khách'],
  ['POST', '/api/m/care/conversations/:id/draft', 'soạn nháp trả lời khách'],
  ['*', '/api/m/care/runtime/*', 'thả tin đang giữ, bật tắt tự động'],
  ['*', '/api/m/care/conversations/:id/ai', 'bật tắt AI cho hội thoại'],
  ['*', '/api/m/care/conversations/:id/customer-care', 'chế độ chăm sóc hội thoại'],
  ['*', '/api/m/care/conversations/:id/workflow', 'luồng chăm sóc hội thoại'],
  ['*', '/api/m/care/conversations/:id/pause', 'tạm dừng hoặc tiếp tục AI'],
  ['*', '/api/m/care/conversations/:id/takeover', 'chủ tiếp quản hoặc trả lại AI'],
  ['*', '/api/m/care/conversations/:id/assignee', 'agent phụ trách hội thoại'],
  ['*', '/api/m/care/assignments', 'agent phụ trách kênh'],
  ['*', '/api/m/care/assignments/*', 'agent phụ trách kênh'],
  ['POST', '/api/m/zalo/threads/:id/send', 'gửi tin Zalo'],
  ['POST', '/api/m/zalo/threads/:id/pause', 'tạm dừng AI trên Zalo'],
  ['*', '/api/m/zalo/group-broadcasts', 'gửi hàng loạt Zalo'],
  ['*', '/api/m/zalo/group-broadcasts/*', 'gửi hàng loạt Zalo'],
  ['*', '/api/m/zalo/list-broadcasts', 'gửi hàng loạt Zalo'],
  ['*', '/api/m/zalo/list-broadcasts/*', 'gửi hàng loạt Zalo'],
  ['*', '/api/m/zalo/birthday/*', 'gửi lời chúc sinh nhật'],
  ['*', '/api/m/zalo/accounts', 'tài khoản Zalo'],
  ['*', '/api/m/zalo/accounts/*', 'tài khoản Zalo'],
  ['POST', '/api/m/marketing/comments/:id/send', 'trả lời bình luận công khai'],
  ['POST', '/api/m/marketing/comments/:id/retry', 'gửi lại trả lời bình luận'],
  ['POST', '/api/m/marketing/comments/:id/hide', 'ẩn bình luận trên Facebook'],
  ['POST', '/api/m/marketing/comments/:id/unhide', 'hiện bình luận trên Facebook'],
  ['*', '/api/m/marketing/comments/rules', 'luật tự trả lời bình luận'],
  ['*', '/api/m/marketing/comments/templates', 'mẫu tự trả lời bình luận'],
  ['*', '/api/m/marketing/comments/templates/*', 'mẫu tự trả lời bình luận'],
  // posts: approve, schedule, publish
  ['PATCH', '/api/m/marketing/content/:id', 'sửa bài, đổi giờ của bài đã duyệt'],
  ['POST', '/api/m/marketing/content/:id/approve', 'duyệt và lên lịch bài'],
  ['POST', '/api/m/marketing/content/:id/publish-now', 'đăng bài ngay'],
  ['POST', '/api/m/marketing/content/:id/unschedule', 'bỏ lịch bài'],
  ['POST', '/api/m/marketing/content/:id/return', 'trả bài về nháp'],
  ['POST', '/api/m/marketing/content/:id/delete-remote', 'xoá bài đã đăng trên Facebook'],
  ['PATCH', '/api/m/marketing/pages/:id', 'luật đăng của Fanpage'],
  ['PATCH', '/api/m/kol/posts/:id', 'sửa bài KOL, đổi giờ'],
  ['POST', '/api/m/kol/posts/:id/approve', 'duyệt bài KOL'],
  ['POST', '/api/m/kol/posts/:id/submit', 'gửi bài KOL đi duyệt hoặc lên lịch'],
  ['POST', '/api/m/kol/posts/:id/publish-now', 'đăng bài KOL ngay'],
  ['POST', '/api/m/kol/posts/:id/retry', 'đăng lại bài KOL'],
  ['*', '/api/m/kol/accounts/*', 'tài khoản mạng xã hội của KOL'],
  ['POST', '/api/m/kol/personas/:id/accounts', 'tài khoản mạng xã hội của KOL'],
  ['POST', '/api/m/kol/personas/:id/autopilot/run', 'chạy tự lái KOL (tạo và chi tiền)'],
  ['POST', '/api/m/kol/personas/:id/assets/import', 'nhập tài sản cho KOL'],
  ['POST', '/api/m/video/edit/projects/:id/publish', 'đăng video'],
  ['POST', '/api/m/video/edit/projects/:id/plan/decide', 'duyệt kế hoạch dựng video'],
  ['POST', '/api/m/video/approvals/:id/decide', 'duyệt việc của video'],
  // ad accounts and recommendations that write to them
  ['*', '/api/m/ads/*', 'tài khoản quảng cáo'],
  ['*', '/api/recos/*', 'áp dụng đề xuất'],
  // module settings
  ['*', '/api/modules/:id/*', 'thêm, gỡ, xoá, cài đặt module'],
  ['*', '/api/m/:id/settings', 'cài đặt module'],
  ['*', '/api/m/radar/config', 'cài đặt radar'],
  ['*', '/api/m/radar/config/*', 'cài đặt radar'],
  ['*', '/api/m/radar/enabled', 'bật tắt radar'],
  ['*', '/api/m/gmail/enable', 'bật Gmail'],
  ['*', '/api/m/gmail/accounts/*', 'tài khoản Gmail'],
  ['*', '/api/m/finance/pnl/settings', 'cài đặt lãi lỗ'],
  ['PUT', '/api/settings', 'cài đặt chung'],
  ['*', '/api/costs/budgets/*', 'ngân sách AI'],
  // agent access and runtime options
  ['*', '/api/agents', 'tạo agent'],
  ['*', '/api/agents/*', 'sửa, xoá agent, quyền và runtime'],
  ['*', '/api/genbot/*', 'bot GenBot: khoá Bot API, địa chỉ GenBot, mã bot, thêm, tạm dừng, xoá, kiểm tra'],
  // a check may send the stored key to the base_url given in the body: owner only
  ['POST', '/api/runtimes/genbot/check', 'kiểm bot GenBot bằng khoá đã lưu'],
  ['*', '/api/skills/*', 'skill của agent, thư mục skill'],
  ['*', '/api/brain/folders', 'thư mục brain (quyền đọc ghi)'],
  ['*', '/api/brain/folders/*', 'thư mục brain (quyền đọc ghi)'],
  ['*', '/api/integrations/approvals/*', 'duyệt lệnh integration của agent'],
  ['PUT', '/api/integrations/:id', 'khoá integration'],
  ['DELETE', '/api/integrations/:id', 'khoá integration'],
  ['POST', '/api/integrations/:id/oauth/*', 'đăng nhập integration'],
  ['PUT', '/api/connections/composio-key', 'khoá Composio'],
  ['POST', '/api/tasks/:id/approve', 'duyệt việc agent đề xuất'],
  ['*', '/api/m/video/studio/grants', 'quyền studio video'],
  // data packs, teams, templates
  ['*', '/api/teams/install', 'cài gói team'],
  ['*', '/api/teams/import', 'nhập gói team'],
  ['*', '/api/teams/import/*', 'nhập gói team'],
  ['*', '/api/m/video/edit/templates/:id/install', 'cài mẫu video'],
  ['*', '/api/packs/*', 'xem trước, cài, cập nhật, gỡ gói dữ liệu'],
  // cloud account (sign-out is DELETE /api/integrations/agenticos-cloud, covered above; the GET callback stays open:
  // it is a browser redirect guarded by its OAuth state)
  ['POST', '/api/cloud/login/start', 'đăng nhập tài khoản cloud'],
  ['POST', '/api/m/radar/browser/login', 'đăng nhập trình duyệt của radar'],
  // crm and learn: every route that changes anything (today only learn sync; a new write route is covered by default)
  ['*', '/api/m/crm/*', 'ghi dữ liệu CRM'],
  ['*', '/api/m/learn/*', 'đồng bộ, ghi bài học'],
  // Dream 100: adding channels and videos starts downloads and agent runs; settings pick the brain folder
  ['*', '/api/m/dream/*', 'kênh, video tham khảo và cài đặt Dream 100'],
  // owner sessions
  ['POST', '/api/owner/pair-link', 'tạo mã ghép cho thiết bị khác'],
];

/**
 * State-changing routes whose path has one of these segments look sensitive; the coverage test requires each one to be
 * in OWNER_ROUTES or in NOT_OWNER_ROUTES.
 */
export const SENSITIVE_SEGMENTS = [
  'send', 'send-now', 'reply', 'replies', 'draft', 'drafts', 'outbox', 'holds', 'broadcast', 'group-broadcasts', 'list-broadcasts',
  'approve', 'approvals', 'decide', 'submit', 'schedule', 'unschedule', 'publish', 'publish-now', 'delete-remote',
  'ads', 'recos', 'apply', 'apply-cart', 'budgets', 'accounts', 'connect', 'reconnect',
  'settings', 'config', 'enable', 'enabled', 'enable-all', 'switches', 'runtime', 'runtimes', 'autopilot', 'takeover', 'ai',
  'agents', 'access', 'grants', 'integrations', 'oauth', 'composio-key', 'folders', 'roots', 'install', 'uninstall', 'update', 'updates',
  'import', 'pack', 'packs', 'cloud', 'login', 'logout', 'pause', 'mode', 'crm', 'learn', 'genbot', 'key', 'keys', 'bots', 'probe', 'convert',
] as const;

/** Sensitive-looking routes that are deliberately NOT owner routes, with the reason. */
export const NOT_OWNER_ROUTES: ReadonlyArray<readonly [Method, string, string]> = [
  ['POST', '/api/integrations/call', 'cầu MCP của agent, dùng token của lượt chạy, không phải chủ'],
  ['POST', '/api/integrations/:id/test', 'chỉ kiểm khoá đã lưu, không ghi gì'],
  ['POST', '/api/owner/pair', 'đổi mã ghép lấy phiên chủ'],
  ['POST', '/api/owner/pair/request', 'in mã ghép mới ra terminal của máy chủ, không trả mã'],
  ['POST', '/api/owner/logout', 'đăng xuất chính phiên của mình'],
  ['POST', '/api/m/video/edit/projects/:id/marks/send', 'gửi góp ý dựng phim cho agent dựng, không gửi ra ngoài'],
];

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function compile(pattern: string): RegExp {
  const body = pattern
    .split('/')
    .map((seg) => (seg === '*' ? '.*' : seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${body.replace(/\/\.\*$/, '(?:/.*)?')}$`, 'i');
}

const COMPILED = OWNER_ROUTES.map(([m, p]) => ({ method: m, re: compile(p) }));
const COMPILED_EXEMPT = NOT_OWNER_ROUTES.map(([m, p]) => ({ method: m, re: compile(p) }));

/** Collapse `//`, drop a trailing `/` and percent-decoding, so `/api/m/care//drafts/1/approve/` is still caught. */
export function normalizePath(raw: string): string {
  let p = raw;
  try {
    p = decodeURIComponent(raw);
  } catch {
    /* keep raw */
  }
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p;
}

const matches = (list: typeof COMPILED, method: string, path: string): boolean => {
  const m = method.toUpperCase();
  if (!MUTATING.has(m)) return false;
  const p = normalizePath(path);
  return list.some((r) => (r.method === '*' || r.method === m) && r.re.test(p));
};

/** True when this method + path needs the owner. GET/HEAD/OPTIONS never do; run-token paths never do. */
export function isOwnerRoute(method: string, path: string): boolean {
  if (RUN_TOKEN_PATHS.includes(normalizePath(path))) return false;
  return matches(COMPILED, method, path);
}

export function isExemptRoute(method: string, path: string): boolean {
  return matches(COMPILED_EXEMPT, method, path);
}

export function looksSensitive(method: string, path: string): boolean {
  if (!MUTATING.has(method.toUpperCase())) return false;
  const segs = normalizePath(path).toLowerCase().split('/');
  return segs.some((s) => (SENSITIVE_SEGMENTS as readonly string[]).includes(s));
}

// ------------------------------------------------------------------ cross-site check

/**
 * A browser request that changes state must come from this origin. Origin (sent by browsers on every non-GET fetch)
 * must name the Host the request was sent to, or one of AIOS_ALLOWED_ORIGINS; Sec-Fetch-Site must be same-origin or
 * none. Requests without either header are not from a browser page (curl, scripts) and cannot carry a cross-site ride.
 */
export function isCrossSite(c: Context, allowedOrigins: readonly string[] = []): boolean {
  const site = c.req.header('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = c.req.header('origin');
  if (!origin) return false;
  if (origin === 'null') return true;
  if (allowedOrigins.includes(origin)) return false;
  const host = c.req.header('host') ?? new URL(c.req.url).host;
  try {
    return new URL(origin).host.toLowerCase() !== host.toLowerCase();
  } catch {
    return true;
  }
}

// ------------------------------------------------------------------ sessions and pairing codes

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(Buffer.from(sha256(a), 'hex'), Buffer.from(sha256(b), 'hex'));
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

function newCode(): string {
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

const normCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

export interface OwnerAuthOptions {
  db: DB;
  /** AIOS_TOKEN, when set */
  token?: string;
  /** where pairing codes are shown: the server's own terminal (process.stdout), never the logger */
  print?: (text: string) => void;
  now?: () => number;
  allowedOrigins?: readonly string[];
}

export type OwnerCheck = 'owner' | 'none' | 'cross_site';

export interface OwnerAuth {
  /** owner = valid AIOS_TOKEN bearer, or valid session cookie on a same-origin request */
  check(c: Context): OwnerCheck;
  /** valid AIOS_TOKEN bearer (or ?token= on SSE), as before */
  hasToken(c: Context): boolean;
  /** valid session cookie, ignoring the cross-site check (used by the AIOS_TOKEN gate for reads) */
  hasSession(c: Context): boolean;
  /** mint a pairing code; `announce` prints it with the link on the terminal */
  issueCode(): string;
  announce(baseUrl: string): void;
  /** exchange a code for a session token (undefined when wrong, used or expired) */
  redeem(code: string, label?: string): string | undefined;
  revoke(token: string): void;
  allowedOrigins: readonly string[];
  tokenConfigured: boolean;
}

export function createOwnerAuth(opts: OwnerAuthOptions): OwnerAuth {
  const { db } = opts;
  const now = opts.now ?? Date.now;
  const print = opts.print ?? ((text: string) => void process.stdout.write(text));
  const allowedOrigins = opts.allowedOrigins ?? [];
  let codes: { hash: string; expiresAt: number; wrong: number }[] = [];

  const bearerOf = (c: Context): string => {
    const header = c.req.header('authorization') ?? '';
    return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  };

  const hasToken = (c: Context): boolean => {
    if (!opts.token) return false;
    const bearer = bearerOf(c);
    const query = c.req.path === '/api/events' ? (c.req.query('token') ?? '') : '';
    const given = bearer || query;
    return given !== '' && safeEqual(given, opts.token);
  };

  const sessionOf = (token: string | undefined) => {
    if (!token || token.length < 32 || token.length > 128) return undefined;
    const nowSec = Math.floor(now() / 1000);
    const row = db.prepare('SELECT id, expires_at, last_seen_at FROM owner_sessions WHERE token_hash = ?').get(sha256(token)) as
      | { id: string; expires_at: number; last_seen_at: number }
      | undefined;
    if (!row || row.expires_at <= nowSec) return undefined;
    if (nowSec - row.last_seen_at > 300) db.prepare('UPDATE owner_sessions SET last_seen_at = ? WHERE id = ?').run(nowSec, row.id);
    return row;
  };

  const hasSession = (c: Context): boolean => sessionOf(getCookie(c, OWNER_COOKIE)) !== undefined;

  const issueCode = (): string => {
    const code = newCode();
    protectValue(code);
    protectValue(normCode(code));
    const t = now();
    codes = [...codes.filter((x) => x.expiresAt > t), { hash: sha256(normCode(code)), expiresAt: t + CODE_TTL_MS, wrong: 0 }].slice(-MAX_CODES);
    return code;
  };

  return {
    allowedOrigins,
    tokenConfigured: Boolean(opts.token),
    hasToken,
    hasSession,
    check(c) {
      if (hasToken(c)) return 'owner';
      if (!hasSession(c)) return 'none';
      return isCrossSite(c, allowedOrigins) ? 'cross_site' : 'owner';
    },
    issueCode,
    announce(baseUrl) {
      const code = issueCode();
      const link = `${baseUrl.replace(/\/+$/, '')}/api/owner/pair?code=${encodeURIComponent(code)}`;
      print(
        [
          '',
          '──────── Đăng nhập chủ AIOS-Lite ────────',
          'Mở liên kết này trong trình duyệt của bạn (dùng một lần, hết hạn sau 60 phút):',
          `  ${link}`,
          `Hoặc nhập mã ${code} ở màn hình "Đăng nhập chủ".`,
          'Đừng gửi liên kết hay mã này cho ai, kể cả agent.',
          '─────────────────────────────────────────',
          '',
        ].join('\n'),
      );
    },
    redeem(code, label = '') {
      const t = now();
      codes = codes.filter((x) => x.expiresAt > t && x.wrong < MAX_WRONG_GUESSES);
      if (codes.length === 0) return undefined;
      const want = sha256(normCode(code));
      const hit = codes.find((x) => crypto.timingSafeEqual(Buffer.from(x.hash, 'hex'), Buffer.from(want, 'hex')));
      if (!hit) {
        for (const x of codes) x.wrong++;
        return undefined;
      }
      codes = codes.filter((x) => x !== hit);
      const token = crypto.randomBytes(32).toString('base64url');
      protectValue(token);
      const nowSec = Math.floor(t / 1000);
      db.prepare('INSERT INTO owner_sessions (id, token_hash, label, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        crypto.randomUUID(), sha256(token), label.slice(0, 200), nowSec, nowSec + SESSION_TTL_SEC, nowSec,
      );
      return token;
    },
    revoke(token) {
      db.prepare('DELETE FROM owner_sessions WHERE token_hash = ?').run(sha256(token));
    },
  };
}

// ------------------------------------------------------------------ middleware + routes

export function ownerRequiredBody() {
  return errorBody('unauthorized', 'Việc này cần chủ xác nhận. Hãy đăng nhập chủ trên trình duyệt (mã ghép in ở terminal đang chạy AIOS-Lite).');
}

/** Rejects owner routes without the owner; runs after the AIOS_TOKEN gate. */
export function ownerGate(auth: OwnerAuth) {
  return async (c: Context, next: () => Promise<void>) => {
    if (isOwnerRoute(c.req.method, c.req.path)) {
      const who = auth.check(c);
      if (who === 'cross_site') {
        c.header(OWNER_HEADER, 'cross-site');
        return c.json(errorBody('forbidden', 'Yêu cầu đến từ trang khác, bị chặn để bảo vệ tài khoản chủ.'), 403);
      }
      if (who !== 'owner') {
        c.header(OWNER_HEADER, 'required');
        return c.json(ownerRequiredBody(), 401);
      }
    } else if (MUTATING.has(c.req.method.toUpperCase()) && isCrossSite(c, auth.allowedOrigins)) {
      // no state change from another site, owner route or not (a web page must not create tasks on this machine)
      return c.json(errorBody('forbidden', 'Yêu cầu đến từ trang khác, bị chặn.'), 403);
    }
    await next();
  };
}

const cookieOptions = (c: Context) => ({
  httpOnly: true,
  sameSite: 'Strict' as const,
  path: '/',
  secure: new URL(c.req.url).protocol === 'https:',
  maxAge: SESSION_TTL_SEC,
});

export function ownerRoutes(app: Hono, auth: OwnerAuth): void {
  let lastRequest = 0;

  app.get('/api/owner/status', (c) => c.json({ owner: auth.check(c) === 'owner', tokenConfigured: auth.tokenConfigured }));

  // The one-time link printed on the terminal. Opening it from the terminal is a top-level navigation with
  // Sec-Fetch-Site: none; a link clicked on another site (or another localhost port) is refused.
  app.get('/api/owner/pair', (c) => {
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'none' && site !== 'same-origin') return c.redirect('/?owner=pair-failed', 302);
    const token = auth.redeem(c.req.query('code') ?? '', c.req.header('user-agent') ?? '');
    if (!token) return c.redirect('/?owner=pair-failed', 302);
    setCookie(c, OWNER_COOKIE, token, cookieOptions(c));
    return c.redirect('/', 302);
  });

  app.post('/api/owner/pair', async (c) => {
    if (isCrossSite(c, auth.allowedOrigins)) return c.json(errorBody('forbidden', 'Yêu cầu đến từ trang khác, bị chặn.'), 403);
    const parsed = z.object({ code: z.string().min(4).max(40) }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(errorBody('bad_request', 'Nhập mã ghép in ở terminal.'), 400);
    const token = auth.redeem(parsed.data.code, c.req.header('user-agent') ?? '');
    if (!token) return c.json(errorBody('unauthorized', 'Mã không đúng, đã dùng hoặc đã hết hạn. Bấm "In mã mới" rồi xem terminal.'), 401);
    setCookie(c, OWNER_COOKIE, token, cookieOptions(c));
    return c.json({ ok: true, owner: true });
  });

  // Prints a fresh code on the server terminal. Never returns it: a process that can call this still has to read the
  // terminal to use it.
  app.post('/api/owner/pair/request', (c) => {
    const t = Date.now();
    if (t - lastRequest < REQUEST_COOLDOWN_MS) return c.json({ ok: true, printed: false, retryInSec: Math.ceil((REQUEST_COOLDOWN_MS - (t - lastRequest)) / 1000) });
    lastRequest = t;
    const url = new URL(c.req.url);
    auth.announce(`${url.protocol}//${c.req.header('host') ?? url.host}`);
    return c.json({ ok: true, printed: true });
  });

  // An owner pairs another browser or device: the code is shown to the owner who asked.
  app.post('/api/owner/pair-link', (c) => c.json({ code: auth.issueCode(), expiresInMin: CODE_TTL_MS / 60_000 }));

  app.post('/api/owner/logout', (c) => {
    const token = getCookie(c, OWNER_COOKIE);
    if (token) auth.revoke(token);
    deleteCookie(c, OWNER_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });
}
