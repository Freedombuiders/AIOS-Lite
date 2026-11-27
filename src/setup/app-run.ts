// Step g: start Open AgenticOS from this checkout (npm run dev), show the one-time owner pairing link the server prints
// (src/api/owner.ts) and open it, then open the app. The owner cookie is set for the host name, so everything uses
// 127.0.0.1 (vite.config.ts binds the dev server there).
import { spawn, type ChildProcess } from 'node:child_process';
import { findPairLink } from './plan.js';
import type { Fetch } from './release.js';
import type { Exec } from './genbot-app.js';

export const WEB_PORT = 5173;

export interface AppHealth {
  ok: boolean;
  isAios: boolean;
  version?: string;
}

/** AIOS answers GET /api/health with {ok:true, version, uptimeSec}. */
export async function aiosHealth(doFetch: Fetch, apiPort: number, timeoutMs = 1500): Promise<AppHealth> {
  try {
    const res = await doFetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    const text = await res.text();
    type Body = { ok?: unknown; version?: unknown; uptimeSec?: unknown };
    let body: Body | null;
    try {
      body = JSON.parse(text) as Body;
    } catch {
      body = null;
    }
    const isAios = res.ok && body?.ok === true && typeof body.uptimeSec === 'number';
    return { ok: true, isAios, ...(isAios && typeof body?.version === 'string' ? { version: body.version } : {}) };
  } catch {
    return { ok: false, isAios: false };
  }
}

/**
 * In a dev checkout the API (4380) serves no web pages, so the link is opened through the web dev server, which
 * proxies /api: same host 127.0.0.1, so the cookie is the same, and its redirect to "/" lands on the app.
 */
export function pairLinkForWeb(link: string, webUrl = `http://127.0.0.1:${WEB_PORT}`): string {
  const u = new URL(link);
  u.port = new URL(webUrl).port;
  u.hostname = '127.0.0.1';
  return u.href;
}

/** Opens a URL in the default browser without a shell (the URL never reaches a command line parser). */
export function openUrl(url: string, platform: NodeJS.Platform, exec: Exec): Promise<{ code: number }> {
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return Promise.resolve({ code: 1 });
  if (platform === 'darwin') return exec('open', [url]);
  if (platform === 'win32') return exec('rundll32', ['url.dll,FileProtocolHandler', url]);
  return exec('xdg-open', [url]);
}

export async function waitForHttp(doFetch: Fetch, url: string, timeoutMs: number, intervalMs = 1000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(1500), redirect: 'manual' });
      await res.body?.cancel().catch(() => undefined);
      return true;
    } catch {
      /* not yet */
    }
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const ANSI = /\x1b\[[0-9;]*m/g;
/** Vite's "Local:" line; it moves to 5174… when 5173 is taken, so the real port is read, never assumed. */
const WEB_URL_RE = /Local:\s+(http:\/\/127\.0\.0\.1:\d{2,5})\//;

export function findWebUrl(text: string): string | null {
  return WEB_URL_RE.exec(text.replace(ANSI, ''))?.[1] ?? null;
}

/**
 * Watches the dev servers' output (passed through unchanged: the pairing code belongs on this terminal) and calls
 * `onReady` once, when both the first pairing link and the web dev server's address have been printed.
 */
export function watchDevOutput(onReady: (pairLink: string, webUrl: string) => void): (chunk: string) => void {
  let link: string | null = null;
  let web: string | null = null;
  let fired = false;
  let buffer = '';
  return (chunk: string) => {
    if (fired) return;
    buffer = (buffer + chunk.replace(ANSI, '')).slice(-8192);
    link ??= findPairLink(buffer);
    web ??= findWebUrl(buffer);
    if (link && web) {
      fired = true;
      buffer = '';
      onReady(link, web);
    }
  };
}

/** `npm run dev`, in the foreground: its output goes to this terminal; Ctrl-C stops it. */
export function startDev(rootDir: string, platform: NodeJS.Platform, onOutput: (chunk: string) => void): ChildProcess {
  const child = spawn(platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev'], {
    cwd: rootDir,
    stdio: ['inherit', 'pipe', 'pipe'],
    // npm.cmd needs a shell on Windows; the arguments are fixed words.
    shell: platform === 'win32',
    env: process.env,
  });
  child.stdout?.on('data', (b: Buffer) => {
    const s = b.toString('utf8');
    process.stdout.write(s);
    onOutput(s);
  });
  child.stderr?.on('data', (b: Buffer) => process.stderr.write(b));
  return child;
}
