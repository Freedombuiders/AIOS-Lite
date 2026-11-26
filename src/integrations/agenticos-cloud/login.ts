// Desktop sign-in to the AgenticOS cloud, without pasting a token:
//
//   1. start(): a random `state` (32 bytes) is remembered, hashed, in the encrypted integration credentials
//      (`oauth-pending-agenticos-cloud`, 10 minutes), and the browser is sent to
//      <cloud>/auth/web/start?return=http://127.0.0.1:<port>/api/cloud/callback&state=<state>.
//   2. The cloud signs the owner in with Google and sends the browser back to our callback with a one-time
//      `code` (2 minutes) and the same `state`.
//   3. callback(): the state must match the pending one (constant-time), the pending entry is used once, and
//      the code is traded at POST <cloud>/auth/exchange for a 90-day machine session, stored encrypted as the
//      integration's `session_token`. A wrong state changes nothing.
//
// The paste-a-token path on the Kết nối page keeps working: both end in the same stored values.
import crypto from 'node:crypto';
import os from 'node:os';
import type { FetchImpl } from '../media-http.js';
import type { IntegrationTestResult, IntegrationValues } from '../types.js';
import { IntegrationApiError, IntegrationUsageError } from '../types.js';
import { exchangeLoginCode, normaliseCloudUrl } from './client.js';

export const CLOUD_INTEGRATION_ID = 'agenticos-cloud';
export const CLOUD_PENDING_ID = `oauth-pending-${CLOUD_INTEGRATION_ID}`;
export const CLOUD_CALLBACK_PATH = '/api/cloud/callback';
const PENDING_TTL_MS = 10 * 60_000;

/** The slice of the credential store the flow needs (IntegrationService.oauthStore). */
export interface CloudLoginStore {
  load(id: string): IntegrationValues | null;
  save(id: string, values: IntegrationValues, result: IntegrationTestResult): void;
  remove(id: string): void;
}

export interface CloudLoginDeps {
  store: CloudLoginStore;
  /** host and port the core API listens on; the callback always goes to the loopback address */
  host: string;
  port: number;
  fetchImpl?: FetchImpl;
  now?: () => number;
  randomBytes?: (n: number) => Buffer;
}

export type CallbackResult = { ok: true; email: string } | { ok: false; message: string };

const CLOUD_ERRORS: Record<string, string> = {
  access_denied: 'Bạn đã huỷ đăng nhập Google.',
  account_disabled: 'Tài khoản cloud này đang bị khoá.',
  not_configured: 'Cloud chưa cấu hình đăng nhập Google.',
  google_error: 'Google không xác nhận được lượt đăng nhập. Thử lại.',
  invalid_token: 'Google không xác nhận được lượt đăng nhập. Thử lại.',
};

const hash = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest();

export function createCloudLogin(deps: CloudLoginDeps) {
  const now = deps.now ?? Date.now;
  const random = deps.randomBytes ?? crypto.randomBytes;
  const loopback = deps.host === 'localhost' ? 'localhost' : '127.0.0.1';
  const returnUrl = () => `http://${loopback}:${deps.port}${CLOUD_CALLBACK_PATH}`;

  return {
    returnUrl,

    /** URL to open in the browser. Uses `cloudUrl`, else the address already saved for the integration. */
    start(cloudUrl?: string): { url: string } {
      const base = normaliseCloudUrl(cloudUrl?.trim() || deps.store.load(CLOUD_INTEGRATION_ID)?.cloud_url);
      const state = random(32).toString('base64url');
      deps.store.save(
        CLOUD_PENDING_ID,
        { state_hash: hash(state).toString('hex'), cloud_url: base, expires_at: String(now() + PENDING_TTL_MS) },
        { ok: true, detail: 'Chờ đăng nhập cloud' },
      );
      const url = new URL(`${base}/auth/web/start`);
      url.searchParams.set('return', returnUrl());
      url.searchParams.set('state', state);
      return { url: url.toString() };
    },

    async callback(q: { code?: string; state?: string; error?: string }): Promise<CallbackResult> {
      const pending = deps.store.load(CLOUD_PENDING_ID);
      const invalid: CallbackResult = { ok: false, message: 'Lượt đăng nhập không hợp lệ hoặc đã hết hạn. Bấm "Đăng nhập cloud" trong app để bắt đầu lại.' };
      if (!pending?.state_hash || !pending.cloud_url || !(Number(pending.expires_at) > now())) return invalid;
      const state = q.state ?? '';
      const expected = Buffer.from(pending.state_hash, 'hex');
      // a wrong state is someone else's request (or a stale tab): refuse, and leave the real attempt alone
      if (!state || state.length > 200 || expected.length !== 32 || !crypto.timingSafeEqual(hash(state), expected)) return invalid;
      deps.store.remove(CLOUD_PENDING_ID); // used once, whatever happens next

      if (q.error) return { ok: false, message: CLOUD_ERRORS[q.error] ?? 'Cloud từ chối lượt đăng nhập.' };
      if (!q.code || q.code.length > 200) return invalid;
      try {
        const { token, user } = await exchangeLoginCode({
          baseUrl: pending.cloud_url, code: q.code, state, label: `AIOS-Lite (${os.platform()})`, fetchImpl: deps.fetchImpl,
        });
        deps.store.save(
          CLOUD_INTEGRATION_ID,
          { cloud_url: pending.cloud_url, session_token: token },
          { ok: true, detail: `Đã kết nối cloud với tài khoản ${user.email}.`, accountLabel: user.email },
        );
        return { ok: true, email: user.email };
      } catch (e) {
        const known = e instanceof IntegrationApiError || e instanceof IntegrationUsageError;
        return { ok: false, message: known ? e.message : 'Không đổi được mã đăng nhập lấy phiên.' };
      }
    },
  };
}

export type CloudLogin = ReturnType<typeof createCloudLogin>;

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** The small page the browser lands on after the callback. */
export function callbackPage(r: CallbackResult): string {
  const title = r.ok ? 'Đã đăng nhập AgenticOS Cloud' : 'Chưa đăng nhập được';
  const text = r.ok ? `Máy này đã được nối với tài khoản ${r.email}. Bạn có thể đóng tab này và quay lại app.` : r.message;
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5;color:#222}a{color:#2563eb}</style></head>
<body><h1 style="font-size:1.25rem">${esc(title)}</h1><p>${esc(text)}</p><p><a href="/packs">Mở Kho dữ liệu</a></p></body></html>`;
}
