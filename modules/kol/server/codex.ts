/**
 * Codex runner for KOL Studio: one short, locked-down Codex turn used for ChatGPT image
 * generation (built-in `image_gen` tool) and the ChatGPT identity judge.
 *
 * Auth: the owner's `codex login` (ChatGPT plan) or OPENAI_API_KEY (Kết nối), copied into
 * a private CODEX_HOME under the module data dir: the operator's ~/.codex/config.toml, MCP servers and
 * skills never load here.
 *
 * Lockdown per turn: read-only sandbox, no approvals, no web search, no shell
 * (`features.shell_tool = false`), no host apps (`features.apps = false`), no MCP servers.
 * Image generation is the only tool, and only for image turns. Reference images go in as
 * `local_image` attachments, so the model never needs file access.
 *
 * Housekeeping: Codex writes the generated PNGs to <home>/generated_images/<thread>/ and a
 * 5–8 MB session rollout (with the images inlined) to <home>/sessions/. Both are removed after
 * each turn so the home does not grow without bound.
 */

import fs from 'fs';
import path from 'path';

import { Codex, type ThreadEvent, type UserInput } from '@openai/codex-sdk';

import { mediaRoot, openaiApiKey, operatorCodexHome } from './config.js';
import { logger } from './compat.js';
import { ensureKolDir, kolPaths } from './core.js';
import { ProviderError } from './providers/types.js';

export type CodexAuthMode = 'chatgpt' | 'api-key' | 'none';

export interface CodexTurnInput {
  /** Text and local images, in order. */
  input: UserInput[];
  model: string;
  /** Enables the built-in image_gen tool for this turn. */
  imageGen: boolean;
  /** JSON schema for a structured final answer (judge). */
  outputSchema?: unknown;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface CodexTurnResult {
  threadId: string | null;
  finalResponse: string;
  /** Generated image files, oldest first, read into memory before the cleanup. */
  images: { bytes: Buffer; mime: string }[];
  inputTokens: number;
  outputTokens: number;
}

export type CodexRunner = (turn: CodexTurnInput) => Promise<CodexTurnResult>;

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

let authOverride: CodexAuthMode | null = null;

/** @internal tests only: pretend Codex is signed in a given way (null restores detection). */
export function _setCodexAuthModeForTests(mode: CodexAuthMode | null): void {
  authOverride = mode;
}

/**
 * How Codex would authenticate right now. Read-only and fast (no subprocess).
 * Under vitest it answers 'none' unless a test opts in, so unit tests never depend on (or
 * reach) the developer's real Codex login.
 */
export function codexAuthMode(): CodexAuthMode {
  if (authOverride) return authOverride;
  if (process.env.VITEST) return 'none';
  if (nonEmpty(openaiApiKey())) return 'api-key';
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(operatorCodexHome(), 'auth.json'), 'utf-8')) as Record<string, unknown>;
    const tokens = raw.tokens && typeof raw.tokens === 'object' ? raw.tokens as Record<string, unknown> : undefined;
    if (nonEmpty(raw.OPENAI_API_KEY)) return 'api-key';
    if (tokens && (nonEmpty(tokens.access_token) || nonEmpty(tokens.refresh_token) || nonEmpty(tokens.id_token))) return 'chatgpt';
  } catch { /* no file login */ }
  return 'none';
}

export const CODEX_LOGIN_HINT = 'Chạy `codex login` trên máy chạy FreedomOS để đăng nhập bằng tài khoản ChatGPT (hoặc thêm khóa OPENAI_API_KEY ở Kết nối), rồi tải lại trang.';

/** Models the signed-in account advertises, from Codex's own model cache (best effort, no network). */
export function codexAccountModels(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(operatorCodexHome(), 'models_cache.json'), 'utf-8')) as { models?: unknown };
    const list = Array.isArray(raw.models) ? raw.models : [];
    return list
      .filter((m) => m && typeof m === 'object' && (m as { visibility?: unknown }).visibility !== 'hide')
      .map((m) => String((m as { slug?: unknown; id?: unknown }).slug ?? (m as { id?: unknown }).id ?? ''))
      .filter((slug) => /^gpt-/i.test(slug));
  } catch {
    return [];
  }
}

const MIME_BY_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/**
 * A private CODEX_HOME for KOL turns: the owner's login (auth.json) is copied in, nothing else, so the
 * operator's MCP servers and config never load into an image turn.
 */
function preparedHome(): string {
  const home = path.join(path.dirname(mediaRoot()), 'codex-home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const src = path.join(operatorCodexHome(), 'auth.json');
  const dest = path.join(home, 'auth.json');
  try {
    if (fs.existsSync(src) && (!fs.existsSync(dest) || fs.statSync(src).mtimeMs > fs.statSync(dest).mtimeMs)) {
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, 0o600);
    }
  } catch { /* no file login: an API key may still work */ }
  return home;
}

function collectImages(home: string, threadId: string | null): { bytes: Buffer; mime: string }[] {
  if (!threadId) return [];
  const dir = path.join(home, 'generated_images', threadId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((file) => MIME_BY_EXT[path.extname(file).toLowerCase()] && fs.statSync(file).isFile())
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
    .map((file) => ({ bytes: fs.readFileSync(file), mime: MIME_BY_EXT[path.extname(file).toLowerCase()] }));
}

/** Removes this thread's generated images and session rollout(s). Never throws. */
export function cleanupThread(home: string, threadId: string | null): void {
  if (!threadId || !/^[A-Za-z0-9-]+$/.test(threadId)) return;
  try { fs.rmSync(path.join(home, 'generated_images', threadId), { recursive: true, force: true }); } catch { /* best effort */ }
  const sessions = path.join(home, 'sessions');
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.includes(threadId) && e.name.endsWith('.jsonl')) {
        try { fs.rmSync(full, { force: true }); } catch { /* best effort */ }
      }
    }
  };
  walk(sessions, 0);
}

function classify(message: string): ProviderError {
  const m = message.replace(/\s+/g, ' ').slice(0, 300);
  if (/not supported when using Codex with a ChatGPT account/i.test(m)) return new ProviderError('unsupported', `${m} — chọn model Codex khác ở Cài đặt`);
  if (/unauthori[sz]ed|401|not logged in|login|auth/i.test(m)) return new ProviderError('auth', m);
  if (/usage limit|rate limit|429|too many requests|quota/i.test(m)) return new ProviderError('rate', m);
  if (/safety|policy|moderation|refus/i.test(m)) return new ProviderError('safety', m);
  if (/timed? ?out|abort/i.test(m)) return new ProviderError('timeout', m);
  if (/stream disconnected|websocket closed|connection (reset|closed|refused)|ECONN|ENOTFOUND|network/i.test(m)) return new ProviderError('network', m);
  return new ProviderError('unknown', m);
}

/** The real runner: spawns one Codex turn through the SDK. */
export const runCodexTurn: CodexRunner = async (turn) => {
  const cwd = ensureKolDir(path.join(kolPaths.tmp(), 'codex'));
  const home = preparedHome();
  const env: Record<string, string> = { CODEX_HOME: home };
  for (const key of ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SYSTEMROOT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    const v = process.env[key];
    if (typeof v === 'string') env[key] = v;
  }
  const apiKey = openaiApiKey();
  if (nonEmpty(apiKey)) env.OPENAI_API_KEY = apiKey;

  const codex = new Codex({
    env,
    config: {
      features: { shell_tool: false, apps: false, image_generation: turn.imageGen },
      mcp_servers: {},
    },
  });
  const thread = codex.startThread({
    model: turn.model,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    webSearchMode: 'disabled',
    skipGitRepoCheck: true,
    workingDirectory: cwd,
    modelReasoningEffort: 'low',
  });

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), turn.timeoutMs);
  const onOuterAbort = () => abort.abort();
  turn.signal?.addEventListener('abort', onOuterAbort, { once: true });

  let finalResponse = '';
  /** A real failure: the turn failed, the stream errored, or the call threw. */
  let fatal: string | null = null;
  /** Non-fatal error items Codex emits along the way (e.g. "Falling back from WebSockets to HTTPS transport"). */
  const notices: string[] = [];
  let completed = false;
  let inputTokens = 0;
  let outputTokens = 0;
  const started = Date.now();
  try {
    const { events } = await thread.runStreamed(turn.input, { signal: abort.signal, ...(turn.outputSchema ? { outputSchema: turn.outputSchema } : {}) });
    for await (const ev of events as AsyncGenerator<ThreadEvent>) {
      if (ev.type === 'item.completed' && ev.item.type === 'agent_message') finalResponse = ev.item.text;
      else if (ev.type === 'item.completed' && ev.item.type === 'error' && !/service tier|model metadata/i.test(ev.item.message)) notices.push(ev.item.message);
      else if (ev.type === 'turn.failed') fatal = ev.error.message;
      else if (ev.type === 'error') fatal = ev.message;
      else if (ev.type === 'turn.completed') {
        completed = true;
        inputTokens = ev.usage?.input_tokens ?? 0;
        outputTokens = ev.usage?.output_tokens ?? 0;
      }
    }
  } catch (err) {
    fatal = abort.signal.aborted ? `Codex turn timed out after ${Math.round((Date.now() - started) / 1000)} s` : (err as Error)?.message ?? String(err);
  } finally {
    clearTimeout(timer);
    turn.signal?.removeEventListener('abort', onOuterAbort);
  }
  // A stream that ended without turn.completed is a failure too; the last notice usually says why.
  if (!fatal && !completed) fatal = notices[notices.length - 1] ?? 'Codex turn ended without completing';

  const threadId = thread.id;
  const images = turn.imageGen ? collectImages(home, threadId) : [];
  cleanupThread(home, threadId);
  logger.info({
    model: turn.model, imageGen: turn.imageGen, images: images.length, ok: !fatal, completed, notices: notices.length, ms: Date.now() - started,
    // The model's own words when an image turn produced nothing (usually a refusal); never contains credentials.
    ...(turn.imageGen && images.length === 0 ? { said: finalResponse.replace(/\s+/g, ' ').slice(0, 300), fatal: fatal?.slice(0, 200) } : {}),
  }, 'kol codex turn');
  // A turn that produced images is a success even if a later step complained.
  if (fatal && images.length === 0) throw classify(fatal);
  return { threadId, finalResponse, images, inputTokens, outputTokens };
};

let override: CodexRunner | null = null;

/** @internal tests only. */
export function _setCodexRunnerForTests(fn: CodexRunner | null): void {
  override = fn;
}

export function codexRunner(): CodexRunner {
  return override ?? runCodexTurn;
}
