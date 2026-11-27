// GenBot adapter: one turn = one message to a bot's Bot API (`POST {base_url}/hooks/api/bots/{bot_id}/messages`).
// The thread GenBot opens for an API call is confined (no tools, no MCP, no files), so this runtime only ever answers
// with text. Each run opens a new thread: AIOS sends the whole context every time (plan 5.1.5).
// HTTP contract: genbot desktop/docs/bot-api.md and desktop/server/bot-api-host.ts (POST and the GET that reads a thread).
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentConfig, ErrorFamily } from '../core/types.js';
import { log } from '../core/log.js';
import { protectValue, redactString } from '../core/redact.js';
import { protectEnvName } from '../core/secret-env.js';
import type { DoctorCheck, DoctorReport, Runtime, RuntimeCapabilities, RunError, RunRequest, RunResult } from './contracts.js';
import { probeRequest } from './probe.js';
import { clip, emitSafe, failed, makeReport } from './shared.js';

/** Where GenBot desktop listens by default. */
export const GENBOT_DEFAULT_BASE_URL = 'http://127.0.0.1:8800';

/** Bot API limit on `message` (bot-api.md). The context builder fits the whole request inside it. */
export const GENBOT_MAX_MESSAGE_CHARS = 20_000;

export const GENBOT_CAPABILITIES: RuntimeCapabilities = {
  resume: false,
  systemPrompt: 'inline',
  reportsCost: false,
  images: false,
  documents: false,
  noTools: true,
  mcp: false,
  readsFiles: false,
  maxPromptChars: GENBOT_MAX_MESSAGE_CHARS,
  enforces: {
    context: 'hard',
    mcp: 'hard',
    fileRead: 'hard',
    fileWrite: 'hard',
    shell: 'hard',
    note: 'Luồng Bot API của GenBot bị nhốt: không công cụ, không MCP, không đọc ghi file. Nhưng bot vẫn trả lời từ chỉ dẫn thường trực và bộ nhớ đã lưu trong GenBot, nằm ngoài quyền brain của AIOS: dùng một bot GenBot riêng cho mỗi công ty.',
  },
};

/** Longest `wait` asked on the POST: bot-api.md warns proxies drop a quiet connection after 60 s. Polling covers the rest. */
export const GENBOT_MAX_WAIT_S = 50;
/** Bot API limit: ten calls a minute for one key (and so for one bot). GET does not count. */
export const GENBOT_RATE_LIMIT = { limit: 10, windowMs: 60_000 };
/** Turns AIOS keeps open at once against one bot (GenBot has its own per-bot cap and answers 409 above it). */
export const GENBOT_MAX_CONCURRENT_PER_BOT = 4;
const POLL_MS = 2_000;
const CONNECT_TIMEOUT_MS = 3_000;
const BOT_ID_RE = /^[\w-]{1,128}$/;
/** Only GENBOT_KEY_* names: `key_env` cannot point the adapter at another secret (OPENAI_API_KEY…) and send it out. */
const KEY_ENV_RE = /^GENBOT_KEY_[A-Z0-9_]{1,64}$/;
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|::1)$/i;

type RuntimeOptions = AgentConfig['runtimeOptions'];
type Env = Record<string, string | undefined>;

export interface GenbotConfig {
  baseUrl: string;
  botId: string;
  /** optional fallback: the key in .env under this name (older setups); the key pasted in the app wins */
  keyEnv?: string;
}

/** Reads a bot's stored Bot API key by agent id (src/runtimes/genbot-keys.ts). Core-only, never exposed. */
export type GenbotKeyLookup = (agentId: string) => string | undefined;

// ------------------------------------------------------------------ config

const optString = (o: RuntimeOptions | undefined, key: string): string | undefined => {
  const v = o?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
};

/** `http://` only to this machine; `https://` to the configured host. Anything else would send the key in clear. */
function checkBaseUrl(raw: string): { ok: true; url: string } | { ok: false; problem: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, problem: `base_url không phải địa chỉ hợp lệ: "${clip(raw, 80)}".` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, problem: 'base_url phải bắt đầu bằng http:// (máy này) hoặc https://.' };
  if (u.username || u.password) return { ok: false, problem: 'base_url không được chứa tên đăng nhập hay mật khẩu.' };
  if (u.search || u.hash) return { ok: false, problem: 'base_url không được có phần "?…" hay "#…".' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (u.protocol === 'http:' && !LOOPBACK.test(host)) return { ok: false, problem: `base_url dùng http:// chỉ được trỏ về máy này (127.0.0.1, localhost). Với "${host}" hãy dùng https://.` };
  return { ok: true, url: `${u.origin}${u.pathname}`.replace(/\/+$/, '') };
}

/** Reads and checks `base_url`, `bot_id` and the optional `key_env`. Never reads the key itself. */
export function readGenbotConfig(options: RuntimeOptions | undefined): { ok: true; config: GenbotConfig } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const rawUrl = optString(options, 'base_url');
  const botId = optString(options, 'bot_id');
  const keyEnv = optString(options, 'key_env');
  let baseUrl = '';
  if (!rawUrl) problems.push('Thiếu runtime_options.base_url (địa chỉ GenBot, ví dụ http://127.0.0.1:8800).');
  else {
    const u = checkBaseUrl(rawUrl);
    if (u.ok) baseUrl = u.url;
    else problems.push(u.problem);
  }
  if (!botId) problems.push('Thiếu runtime_options.bot_id (mã bot trong GenBot).');
  else if (!BOT_ID_RE.test(botId)) problems.push('bot_id chỉ gồm chữ, số, "_" và "-" (tối đa 128 ký tự).');
  // key_env is optional: the key is normally pasted on the Đội AI · Bot screen and stored encrypted.
  // The value is never echoed: a key pasted here by mistake must not end up in an error.
  if (keyEnv && !KEY_ENV_RE.test(keyEnv)) problems.push(`key_env phải là tên biến dạng GENBOT_KEY_<TÊN> (chữ in hoa, số, "_"); giá trị hiện tại (${keyEnv.length} ký tự) không hợp lệ.`);
  if (problems.length || !botId || !baseUrl) return { ok: false, problems };
  return { ok: true, config: { baseUrl, botId, ...(keyEnv ? { keyEnv } : {}) } };
}

/** The key for one agent: the one stored in the app first, then `key_env` in .env (older setups). */
export function resolveGenbotKey(agentId: string | undefined, keyEnv: string | undefined, keyFor: GenbotKeyLookup | undefined, env: Env): { key: string; source: 'store' | 'env' } | undefined {
  const stored = keyFor?.(agentId ?? '')?.trim();
  if (stored) return { key: stored, source: 'store' };
  if (!keyEnv) return undefined;
  protectEnvName(keyEnv, env);
  const fromEnv = env[keyEnv]?.trim();
  return fromEnv ? { key: fromEnv, source: 'env' } : undefined;
}

const NO_KEY_MESSAGE = (keyEnv?: string) =>
  keyEnv
    ? `Chưa có khoá Bot API cho bot này: chưa dán khoá trong màn Đội AI · Bot và biến ${keyEnv} trong .env cũng trống.`
    : 'Chưa có khoá Bot API cho bot này. Mở Đội AI · Bot, bấm "Đổi khoá" và dán khoá chép từ app GenBot.';

/** `systemPrompt + "\n\n" + prompt`; refuses (never truncates) a message over the Bot API limit. */
export function buildMessage(req: Pick<RunRequest, 'systemPrompt' | 'prompt'>): { ok: true; message: string } | { ok: false; error: RunError } {
  const system = req.systemPrompt.trim();
  const message = system ? `${system}\n\n${req.prompt}` : req.prompt;
  if (message.length > GENBOT_MAX_MESSAGE_CHARS) {
    return {
      ok: false,
      error: {
        family: 'config',
        message: `Tin gửi GenBot dài ${message.length.toLocaleString('vi-VN')} ký tự, quá giới hạn ${GENBOT_MAX_MESSAGE_CHARS.toLocaleString('vi-VN')} ký tự của Bot API. Hãy rút gọn chỉ dẫn, ngữ cảnh hoặc dữ liệu gửi kèm.`,
      },
    };
  }
  if (!message.trim()) return { ok: false, error: { family: 'config', message: 'Tin gửi GenBot đang trống.' } };
  return { ok: true, message };
}

// ------------------------------------------------------------------ per-bot gate

export type GateResult = { ok: true; release: () => void } | { ok: false; reason: 'rate'; retryAt: number } | { ok: false; reason: 'busy' } | { ok: false; reason: 'aborted' };

export interface BotGate {
  /** One POST slot for `key` (base_url + bot_id): waits while the minute window or the concurrency cap is full. */
  acquire(key: string, deadline: number, signal: AbortSignal): Promise<GateResult>;
}

/** In-memory, per process: a sliding window of POST times plus a cap on turns open at once, per bot. */
export function createBotGate(opts: { limit?: number; windowMs?: number; concurrency?: number; now?: () => number } = {}): BotGate {
  const limit = opts.limit ?? GENBOT_RATE_LIMIT.limit;
  const windowMs = opts.windowMs ?? GENBOT_RATE_LIMIT.windowMs;
  const concurrency = opts.concurrency ?? GENBOT_MAX_CONCURRENT_PER_BOT;
  const now = opts.now ?? Date.now;
  const calls = new Map<string, number[]>();
  const active = new Map<string, number>();
  const waiters = new Map<string, Set<() => void>>();

  const wake = (key: string) => {
    for (const w of [...(waiters.get(key) ?? [])]) w();
  };
  /** Resolves when a slot of `key` frees, after `ms`, or on abort; true unless aborted. */
  const waitFor = (key: string, ms: number, signal: AbortSignal) =>
    new Promise<boolean>((resolve) => {
      if (signal.aborted) return resolve(false);
      const set = waiters.get(key) ?? new Set<() => void>();
      waiters.set(key, set);
      const done = (v: boolean) => {
        clearTimeout(timer);
        set.delete(onWake);
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      };
      const onWake = () => done(true);
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(true), Math.max(0, ms));
      set.add(onWake);
      signal.addEventListener('abort', onAbort, { once: true });
    });

  return {
    async acquire(key, deadline, signal) {
      for (;;) {
        if (signal.aborted) return { ok: false, reason: 'aborted' };
        const t = now();
        const recent = (calls.get(key) ?? []).filter((at) => at > t - windowMs);
        calls.set(key, recent);
        const open = active.get(key) ?? 0;
        if (open < concurrency && recent.length < limit) {
          recent.push(t);
          active.set(key, open + 1);
          let released = false;
          return {
            ok: true,
            release: () => {
              if (released) return;
              released = true;
              active.set(key, Math.max(0, (active.get(key) ?? 1) - 1));
              wake(key);
            },
          };
        }
        if (open >= concurrency) {
          if (t >= deadline) return { ok: false, reason: 'busy' };
          if (!(await waitFor(key, deadline - t, signal))) return { ok: false, reason: 'aborted' };
          continue;
        }
        const freeAt = recent[0]! + windowMs;
        if (freeAt > deadline) return { ok: false, reason: 'rate', retryAt: freeAt };
        if (!(await waitFor(key, freeAt - t, signal))) return { ok: false, reason: 'aborted' };
      }
    },
  };
}

/** Resolves true after `ms`, false as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const done = (v: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(v);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(true), Math.max(0, ms));
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ------------------------------------------------------------------ HTTP

type Answer =
  | { kind: 'reply'; reply: string; thread?: string }
  | { kind: 'working'; thread: string }
  | { kind: 'approval'; thread?: string }
  | { kind: 'failed'; result: RunResult };

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const FAMILY_BY_STATUS: Record<number, ErrorFamily> = { 400: 'config', 413: 'config', 415: 'config', 401: 'auth', 403: 'config', 404: 'config', 409: 'transient', 429: 'quota', 502: 'unknown' };

const STATUS_HINT: Record<number, string> = {
  400: 'GenBot không nhận thân yêu cầu',
  401: 'Khoá Bot API sai hoặc đã bị thay',
  403: 'Bot API đang tắt cho bot này, không có bot này, gói GenBot Cloud không có Bot API, hoặc AI của bot không chạy nhốt được',
  404: 'Luồng GenBot không còn (hoặc không phải luồng do Bot API mở)',
  409: 'Bot đang bận: luồng còn chạy, bot đã chạm trần số cuộc trò chuyện cùng lúc, hoặc đang có 50 lượt gọi chờ trả lời',
  413: 'Thân yêu cầu quá 256 KB',
  415: 'GenBot chỉ nhận JSON',
  429: 'Quá 10 lượt gọi mỗi phút cho khoá này',
  502: 'Bot GenBot không trả lời được (lý do xem trên thẻ Bot API trong app GenBot)',
};

const approvalMessage = (thread?: string) =>
  `Bot GenBot đang chờ bạn duyệt trong app GenBot${thread ? ` (luồng ${thread})` : ''}. Mở app GenBot và trả lời trong luồng đó; AIOS không duyệt thay được.`;

function retryAfterIso(res: Response): string {
  const h = res.headers.get('retry-after');
  const secs = h && /^\d+$/.test(h.trim()) ? Number(h.trim()) : 60;
  return new Date(Date.now() + secs * 1000).toISOString();
}

async function readAnswer(res: Response, clean: (s: string) => string): Promise<Answer> {
  if (res.status >= 300 && res.status < 400) {
    return { kind: 'failed', result: failed({ family: 'config', message: `GenBot trả chuyển hướng (${res.status}). AIOS không theo chuyển hướng để khoá không bị mang sang máy khác: sửa base_url thành địa chỉ cuối.` }) };
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    /* non-JSON body: handled by status below */
  }
  if (res.status === 200) {
    const reply = str(body.reply);
    // A GET on a turn that failed after a 202 reads as an empty reply: never take it for an answer.
    if (!reply?.trim()) return { kind: 'failed', result: failed({ family: 'unknown', message: 'GenBot trả 200 nhưng câu trả lời trống (lượt của bot có thể đã lỗi; xem luồng trong app GenBot).' }) };
    return { kind: 'reply', reply, thread: str(body.thread) };
  }
  if (res.status === 202) {
    const thread = str(body.thread);
    if (body.status === 'needs_approval') return { kind: 'approval', thread };
    if (body.status === 'working' && thread) return { kind: 'working', thread };
    return { kind: 'failed', result: failed({ family: 'unknown', message: 'GenBot trả 202 với trạng thái không rõ.' }) };
  }
  const family: ErrorFamily = FAMILY_BY_STATUS[res.status] ?? (res.status >= 500 ? 'transient' : 'unknown');
  const said = str(body.error);
  const hint = STATUS_HINT[res.status] ?? `GenBot trả mã ${res.status}`;
  const message = clean(`GenBot ${res.status}: ${hint}.${said ? ` GenBot nói: "${clip(said, 200)}"` : ''}`);
  const error: RunError = family === 'quota' ? { family, message, retryAfter: retryAfterIso(res) } : { family, message };
  // 404: the thread is gone; polling it again cannot help and a stored session (later versions) must be dropped
  return { kind: 'failed', result: failed(error, res.status === 404 ? { clearSession: true } : {}) };
}

// ------------------------------------------------------------------ runtime

export interface GenbotRuntimeOptions {
  /** env to read the fallback `key_env` from (defaults to process.env) */
  env?: Env;
  /** the key stored in the app, by agent id (wins over `key_env`) */
  keyFor?: GenbotKeyLookup;
  /** ms between `GET …/messages?thread=` reads after a `202 working` */
  pollMs?: number;
  /** per-bot gate; one shared instance per runtime by default */
  gate?: BotGate;
}

export function createGenbotRuntime(opts: GenbotRuntimeOptions = {}): Runtime {
  const gate = opts.gate ?? createBotGate();
  const pollMs = opts.pollMs ?? POLL_MS;
  const env = (): Env => opts.env ?? process.env;

  async function run(req: RunRequest): Promise<RunResult> {
    const cfg = readGenbotConfig(req.agent.runtimeOptions);
    if (!cfg.ok) return failed({ family: 'config', message: `Cấu hình GenBot chưa đủ: ${cfg.problems.join(' ')}` });
    const { baseUrl, botId, keyEnv } = cfg.config;
    const found = resolveGenbotKey(req.agent.id, keyEnv, opts.keyFor, env());
    if (!found) return failed({ family: 'config', message: NO_KEY_MESSAGE(keyEnv) });
    const key = found.key;
    protectValue(key);
    // The key never leaves this function: every outgoing string goes through `clean`.
    const clean = (s: string) => redactString(s.split(key).join('[redacted]'));
    const built = buildMessage(req);
    if (!built.ok) return failed(built.error);

    // One deadline covers waiting for a slot, the POST and every GET.
    const deadline = Date.now() + req.timeoutMs;
    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => timeoutCtl.abort(), Math.max(0, req.timeoutMs));
    const signal = AbortSignal.any([req.signal, timeoutCtl.signal]);
    const timedOut = () => failed({ family: 'timeout', message: `GenBot chưa trả lời sau ${Math.round(req.timeoutMs / 1000)} giây.` });
    const stopped = (sent: boolean): RunResult | undefined => {
      if (req.signal.aborted) return failed({ family: 'cancelled', message: sent ? 'Lượt chạy đã bị huỷ. GenBot có thể vẫn trả lời xong trong luồng của nó.' : 'Lượt chạy đã bị huỷ.' });
      if (timeoutCtl.signal.aborted || Date.now() >= deadline) return timedOut();
      return undefined;
    };

    const endpoint = `${baseUrl}/hooks/api/bots/${encodeURIComponent(botId)}/messages`;
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' };
    /** Never re-sent: the Bot API has no idempotency key, so a replayed POST would open a second thread. */
    const call = async (url: string, init: RequestInit, sent: boolean): Promise<Answer> => {
      try {
        // redirect: 'manual' keeps the Authorization header from following a redirect to another host
        const res = await fetch(url, { ...init, headers, signal, redirect: 'manual' });
        return await readAnswer(res, clean);
      } catch (err) {
        const s = stopped(true);
        if (s) return { kind: 'failed', result: s };
        const code = (err as { cause?: { code?: string } }).cause?.code;
        const refused = code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN';
        const why = clip(String(code ?? (err instanceof Error ? err.message : err)), 120);
        const message = refused && !sent
          ? `Không kết nối được GenBot ở ${baseUrl} (${why}). GenBot có đang chạy không?`
          : `Mất kết nối với GenBot ở ${baseUrl} (${why}). Không rõ GenBot đã nhận tin chưa; AIOS không tự gửi lại để tránh mở luồng trùng.`;
        return { kind: 'failed', result: failed({ family: 'transient', message: clean(message) }) };
      }
    };

    let release: (() => void) | undefined;
    try {
      const slot = await gate.acquire(`${baseUrl}#${botId}`, deadline, signal);
      if (!slot.ok) {
        if (slot.reason === 'aborted') return stopped(false) ?? failed({ family: 'cancelled', message: 'Lượt chạy đã bị huỷ.' });
        if (slot.reason === 'busy') return failed({ family: 'timeout', message: `Hết thời gian chờ: bot ${botId} đang trả lời ${GENBOT_MAX_CONCURRENT_PER_BOT} lượt khác.` });
        return failed({ family: 'quota', message: `Bot ${botId} đã nhận đủ ${GENBOT_RATE_LIMIT.limit} lượt gọi trong một phút; chờ thêm sẽ quá thời gian cho phép.`, retryAfter: new Date(slot.retryAt).toISOString() });
      }
      release = slot.release;

      const wait = Math.max(0, Math.min(GENBOT_MAX_WAIT_S, Math.floor(req.timeoutMs / 1000), Math.ceil((deadline - Date.now()) / 1000)));
      log.debug({ runtime: 'genbot', botId, chars: built.message.length, wait }, 'genbot run');
      emitSafe(req, { type: 'status', message: `Đã gửi tin tới GenBot (bot ${botId}).` });
      const posted = call(endpoint, { method: 'POST', body: JSON.stringify({ message: built.message, wait }) }, false);
      emitSafe(req, { type: 'status', message: 'Đang chờ GenBot trả lời…' });
      let answer = await posted;

      if (answer.kind === 'working') {
        const pollUrl = `${endpoint}?thread=${encodeURIComponent(answer.thread)}`;
        while (answer.kind === 'working') {
          if (!(await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal)) || Date.now() >= deadline) return stopped(true) ?? timedOut();
          answer = await call(pollUrl, { method: 'GET' }, true);
        }
      }

      if (answer.kind === 'failed') return answer.result;
      if (answer.kind === 'approval') return failed({ family: 'access', message: approvalMessage(answer.thread) });
      const reply = clean(answer.reply);
      emitSafe(req, { type: 'status', message: 'Đã nhận trả lời từ GenBot.' });
      emitSafe(req, { type: 'text', text: reply });
      // usage stays undefined: GenBot reports neither tokens nor cost (never fill with 0)
      return { ok: true, output: reply, model: req.agent.model };
    } finally {
      release?.();
      clearTimeout(timer);
    }
  }

  return {
    id: 'genbot',
    label: 'GenBot',
    capabilities: GENBOT_CAPABILITIES,
    run,
    // Generic: GenBot is reached over HTTP and configured per agent; checkGenbotAgent checks one agent.
    async doctor(): Promise<DoctorReport> {
      return makeReport('genbot', [
        { code: 'genbot.http', level: 'info', message: 'GenBot gọi qua Bot API (HTTP), không cần cài lệnh. Mỗi bot có địa chỉ GenBot, mã bot và khoá dán trong app.', hint: 'Kiểm từng bot bằng nút "Kiểm tra" ở màn Đội AI · Bot.' },
      ]);
    },
  } satisfies Runtime;
}

// ------------------------------------------------------------------ per-agent check

function connectCheck(baseUrl: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const u = new URL(baseUrl);
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (r: { ok: true } | { ok: false; reason: string }) => {
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish({ ok: false, reason: `quá ${CONNECT_TIMEOUT_MS / 1000} giây không kết nối được` }));
    socket.once('connect', () => finish({ ok: true }));
    socket.once('error', (err: NodeJS.ErrnoException) => finish({ ok: false, reason: err.code ?? 'lỗi mạng' }));
  });
}

/**
 * Checks one agent's GenBot configuration: the three values, the key in the env, a TCP connection to base_url, and with
 * `probe` one real "ping" message through `runtime` (it counts against the bot's ten calls a minute).
 */
export async function checkGenbotAgent(
  runtime: Runtime,
  agent: { id?: string; runtimeOptions: RuntimeOptions },
  opts: { probe?: boolean; env?: Env; keyFor?: GenbotKeyLookup } = {},
): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const checks: DoctorCheck[] = [];
  const cfg = readGenbotConfig(agent.runtimeOptions);
  if (!cfg.ok) {
    for (const p of cfg.problems) checks.push({ code: 'genbot.config', level: 'error', message: p, hint: 'Điền địa chỉ GenBot và mã bot ở màn Đội AI · Bot.' });
    return makeReport('genbot', checks);
  }
  const { baseUrl, botId, keyEnv } = cfg.config;
  checks.push({ code: 'genbot.config', level: 'info', message: `Bot ${botId} ở ${baseUrl}.` });
  const found = resolveGenbotKey(agent.id, keyEnv, opts.keyFor, env);
  if (!found) checks.push({ code: 'genbot.key', level: 'error', message: NO_KEY_MESSAGE(keyEnv), hint: 'Bật Bot API cho bot trong app GenBot (Cài đặt bot › Nâng cao › Truy cập › Bot API), chép khoá rồi dán ở màn Đội AI · Bot.' });
  else checks.push({ code: 'genbot.key', level: 'info', message: found.source === 'store' ? 'Đã có khoá (lưu mã hoá trong AIOS).' : `Có khoá trong ${keyEnv} (.env).` });
  const conn = await connectCheck(baseUrl);
  if (conn.ok) checks.push({ code: 'genbot.connect', level: 'info', message: `Kết nối được tới ${baseUrl}.` });
  else checks.push({ code: 'genbot.connect', level: 'error', message: `Không kết nối được tới ${baseUrl} (${conn.reason}).`, hint: 'Mở app GenBot và kiểm tra cổng nhận webhook.' });
  if (opts.probe && checks.every((c) => c.level !== 'error')) {
    const cwd = await mkdtemp(path.join(tmpdir(), 'aios-probe-genbot-'));
    try {
      const base = probeRequest(cwd, 'genbot');
      const res = await runtime.run({ ...base, agent: { ...base.agent, ...(agent.id ? { id: agent.id } : {}), runtimeOptions: agent.runtimeOptions }, prompt: 'ping. Trả lời đúng một từ: pong', timeoutMs: 60_000 });
      if (res.ok) checks.push({ code: 'genbot.probe', level: 'info', message: `Gửi "ping" thành công: ${clip(res.output.trim(), 60)}` });
      else checks.push({ code: 'genbot.probe', level: 'error', message: `Gửi "ping" thất bại: ${res.error?.message ?? 'không có trả lời'}`, hint: res.error?.family === 'auth' ? 'Tạo khoá mới trong app GenBot (Bot API, New key) rồi bấm "Đổi khoá" ở màn Đội AI · Bot.' : undefined });
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return makeReport('genbot', checks);
}
