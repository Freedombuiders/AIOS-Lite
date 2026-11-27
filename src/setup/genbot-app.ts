// The GenBot desktop app on this machine: where it is, which version, installing a verified download, starting it and
// waiting for its harness (127.0.0.1:8799, or the desktop's fallback ports) and its Bot API receiver (harness port + 1).
// Nothing here writes inside GenBot's data folder or sends anything to it but GET requests.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SetupError, type Fetch } from './release.js';

/** The desktop tries these in order when one is taken (genbot electron/main.mjs DESKTOP_PORTS). */
export const HARNESS_PORTS = [8799, 18799, 28799] as const;
export const GENBOT_APP_NAME = 'GenBot.app';

export interface Installed {
  path: string;
  version: string | null;
}

export interface Exec {
  (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
}

export const realExec: Exec = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(file, args, { env: opts.env ?? process.env, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

// ------------------------------------------------------------------ where

export function candidatePaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  if (platform === 'darwin') return [path.join('/Applications', GENBOT_APP_NAME), path.join(home, 'Applications', GENBOT_APP_NAME)];
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.win32.join(local, 'Programs', 'GenBot', 'GenBot.exe')];
  }
  return [];
}

/** CFBundleShortVersionString from an XML Info.plist; null if missing (a binary plist is read with plutil instead). */
export function versionFromPlist(xml: string): string | null {
  const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]{1,40})<\/string>/.exec(xml);
  return m ? m[1]!.trim() : null;
}

export async function findInstalled(platform: NodeJS.Platform, exec: Exec = realExec, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Promise<Installed | null> {
  for (const p of candidatePaths(platform, env, home)) {
    if (!fs.existsSync(p)) continue;
    if (platform === 'darwin') {
      const plist = path.join(p, 'Contents', 'Info.plist');
      let version: string | null = null;
      try {
        version = versionFromPlist(fs.readFileSync(plist, 'utf8'));
      } catch {
        /* unreadable: try plutil */
      }
      if (!version) {
        const r = await exec('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist]);
        version = r.code === 0 ? r.stdout.trim() || null : null;
      }
      return { path: p, version };
    }
    // Windows: the exe's ProductVersion; the path goes through the environment, never into the command text.
    const r = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:AIOS_GENBOT_EXE).VersionInfo.ProductVersion'], {
      env: { ...env, AIOS_GENBOT_EXE: p },
    });
    return { path: p, version: r.code === 0 ? r.stdout.trim() || null : null };
  }
  return null;
}

/** Apple silicon even when this Node runs under Rosetta. */
export async function isAppleSilicon(exec: Exec = realExec): Promise<boolean> {
  if (process.arch === 'arm64') return true;
  const r = await exec('sysctl', ['-n', 'hw.optional.arm64']);
  return r.code === 0 && r.stdout.trim() === '1';
}

// ------------------------------------------------------------------ install: macOS

export interface MacInstallResult {
  path: string;
  /** spctl's verdict, e.g. "accepted · Notarized Developer ID"; notarized=false means Gatekeeper will block the first open */
  gatekeeper: { notarized: boolean; detail: string };
}

function writable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** /Applications when this user may write there, else ~/Applications. `system` asks for sudo to use /Applications. */
export function macDestination(opts: { system: boolean; home?: string; canWrite?: (dir: string) => boolean }): { dir: string; sudo: boolean } {
  const can = opts.canWrite ?? writable;
  if (can('/Applications')) return { dir: '/Applications', sudo: false };
  if (opts.system) return { dir: '/Applications', sudo: true };
  return { dir: path.join(opts.home ?? os.homedir(), 'Applications'), sudo: false };
}

/** Same format a browser writes (flags;hex time;agent;), so Gatekeeper checks the app on its first open as usual. */
export function quarantineValue(now = Date.now()): string {
  return `0081;${Math.floor(now / 1000).toString(16)};Open AgenticOS setup;`;
}

/**
 * Unpacks a VERIFIED .zip with ditto (keeps the code signature intact), marks the app as downloaded (quarantine, never
 * removed), asks Gatekeeper for its verdict, then moves it into place. An app already there is kept as a backup until
 * the new one is in place, and restored if that fails.
 */
export async function installMac(zip: string, work: string, opts: { system: boolean; exec?: Exec; log: (line: string) => void; home?: string }): Promise<MacInstallResult> {
  const exec = opts.exec ?? realExec;
  const stage = path.join(work, 'unpacked');
  fs.mkdirSync(stage, { recursive: true });
  const unzip = await exec('ditto', ['-x', '-k', zip, stage], { timeoutMs: 10 * 60_000 });
  if (unzip.code !== 0) throw new SetupError(`Giải nén GenBot lỗi: ${unzip.stderr.trim().slice(0, 200)}`);
  const app = path.join(stage, GENBOT_APP_NAME);
  if (!fs.existsSync(path.join(app, 'Contents', 'Info.plist'))) throw new SetupError('Gói tải về không có GenBot.app; dừng để an toàn.');

  const q = await exec('xattr', ['-w', 'com.apple.quarantine', quarantineValue(), app]);
  if (q.code !== 0) opts.log(`  (không gắn được nhãn "tải từ Internet": ${q.stderr.trim().slice(0, 120)})`);

  const sig = await exec('codesign', ['--verify', '--deep', '--strict', app], { timeoutMs: 5 * 60_000 });
  if (sig.code !== 0) throw new SetupError('Chữ ký số của GenBot.app không hợp lệ; không cài.', 'Báo cho người phát hành GenBot. Đã xoá bản tải về.');
  const assess = await exec('spctl', ['--assess', '--type', 'execute', '-vv', app]);
  const detail = `${assess.stdout}${assess.stderr}`.replace(/\s+/g, ' ').trim();
  const gatekeeper = { notarized: assess.code === 0 && /Notarized/i.test(detail), detail: detail.replace(/^.*?GenBot\.app:\s*/, '').slice(0, 160) };

  const { dir, sudo } = macDestination({ system: opts.system, home: opts.home });
  const run = (file: string, args: string[]) => (sudo ? exec('sudo', [file, ...args], { timeoutMs: 10 * 60_000 }) : exec(file, args, { timeoutMs: 10 * 60_000 }));
  if (sudo) opts.log('  Cần quyền quản trị để chép vào /Applications (bạn đã chọn --system). macOS sẽ hỏi mật khẩu máy.');
  if (!sudo) fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, GENBOT_APP_NAME);
  const backup = `${dest}.truoc-khi-cap-nhat`;
  const hadOld = fs.existsSync(dest);
  if (hadOld) {
    if (fs.existsSync(backup)) throw new SetupError(`Còn bản dự phòng cũ ở ${backup}.`, 'Mở GenBot thử; chạy được thì xoá bản dự phòng đó rồi chạy lại.');
    const mv = await run('mv', [dest, backup]);
    if (mv.code !== 0) throw new SetupError(`Không dời được bản GenBot cũ: ${mv.stderr.trim().slice(0, 160)}`);
  }
  const copy = await run('ditto', [app, dest]);
  if (copy.code !== 0) {
    await run('rm', ['-rf', dest]);
    if (hadOld) await run('mv', [backup, dest]);
    throw new SetupError(`Không chép được GenBot vào ${dir}: ${copy.stderr.trim().slice(0, 160)}`, hadOld ? 'Bản cũ đã được trả lại chỗ cũ.' : undefined);
  }
  if (hadOld) await run('rm', ['-rf', backup]);
  return { path: dest, gatekeeper };
}

// ------------------------------------------------------------------ install: Windows

/** Marks the file as downloaded from the Internet (Mark of the Web), as a browser would, so Windows checks it as usual. */
export function markOfTheWeb(file: string, url: string): void {
  try {
    fs.writeFileSync(`${file}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${url}\r\n`);
  } catch {
    /* FAT/exFAT has no alternate streams */
  }
}

export async function installWindows(setupExe: string, url: string, opts: { exec?: Exec; log: (line: string) => void; env?: NodeJS.ProcessEnv }): Promise<{ signature: string; silent: boolean }> {
  const exec = opts.exec ?? realExec;
  const env = { ...(opts.env ?? process.env), AIOS_GENBOT_SETUP: setupExe };
  markOfTheWeb(setupExe, url);
  const sig = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', '$s = Get-AuthenticodeSignature -LiteralPath $env:AIOS_GENBOT_SETUP; "$($s.Status)|$($s.SignerCertificate.Subject)"'], { env });
  const [status = 'Unknown', subject = ''] = sig.stdout.trim().split('|');
  const signature = status === 'Valid' ? `đã ký số (${subject.replace(/^CN=/, '').split(',')[0]})` : `chưa ký số hợp lệ (${status})`;
  // electron-builder's one-click NSIS installer takes /S. Start-Process goes through the shell, so Windows checks the
  // file (SmartScreen, antivirus) exactly as when the owner double-clicks it. An unsigned build is run with its window.
  const silent = status === 'Valid';
  if (!silent) opts.log('  Bản cài GenBot chưa ký số: Windows có thể hiện "Windows đã bảo vệ máy tính". Bấm "Thông tin thêm" › "Vẫn chạy" nếu bạn tin nguồn này (github.com/Freedombuiders/genbot-releases).');
  const args = silent ? "-ArgumentList '/S' " : '';
  const run = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$p = Start-Process -FilePath $env:AIOS_GENBOT_SETUP ${args}-Wait -PassThru; exit $p.ExitCode`], { env, timeoutMs: 15 * 60_000 });
  if (run.code !== 0) throw new SetupError(`Trình cài GenBot kết thúc với mã ${run.code}.`, 'Chạy lại "npm run setup", hoặc cài tay từ github.com/Freedombuiders/genbot-releases/releases/latest.');
  return { signature, silent };
}

// ------------------------------------------------------------------ start and wait

export function startGenbot(platform: NodeJS.Platform, appPath: string, exec: Exec = realExec): Promise<{ code: number; stderr: string }> {
  if (platform === 'darwin') return exec('open', ['-a', appPath]);
  return new Promise((resolve) => {
    try {
      const child = spawn(appPath, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', (e) => resolve({ code: 1, stderr: e.message }));
      child.unref();
      setTimeout(() => resolve({ code: 0, stderr: '' }), 500);
    } catch (e) {
      resolve({ code: 1, stderr: (e as Error).message });
    }
  });
}

export interface GenbotLive {
  harnessPort: number | null;
  /** an HTTP answer of any status on harness port + 1 */
  botApi: boolean;
}

/** GenBot's harness answers GET /api/health with {"app":"openmausbot"} (its upstream name) to anyone. */
export async function harnessAnswers(doFetch: Fetch, port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await doFetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!res.ok) return false;
    const body = (await res.json()) as { app?: unknown };
    return typeof body?.app === 'string' && /openmausbot|genbot/i.test(body.app);
  } catch {
    return false;
  }
}

export async function httpAnswers(doFetch: Fetch, url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    await res.body?.cancel().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export async function probeGenbot(doFetch: Fetch): Promise<GenbotLive> {
  for (const port of HARNESS_PORTS) {
    if (await harnessAnswers(doFetch, port)) return { harnessPort: port, botApi: await httpAnswers(doFetch, `http://127.0.0.1:${port + 1}/`) };
  }
  return { harnessPort: null, botApi: false };
}

/** Polls until both answer or `timeoutMs` passes (bounded: about a minute by default). */
export async function waitForGenbot(doFetch: Fetch, opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Promise<GenbotLive> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const interval = opts.intervalMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const end = now() + timeoutMs;
  let last: GenbotLive = { harnessPort: null, botApi: false };
  for (;;) {
    last = await probeGenbot(doFetch);
    if (last.harnessPort !== null && last.botApi) return last;
    if (now() >= end) return last;
    await sleep(interval);
  }
}

// ------------------------------------------------------------------ why it did not answer

export function genbotLogFile(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | null {
  if (platform === 'darwin') return path.join(home, 'Library', 'Logs', 'GenBot', 'server.log');
  if (platform === 'win32') return path.win32.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'GenBot', 'logs', 'server.log');
  return null;
}

export interface HarnessDiagnosis {
  kind: 'crash' | 'starting' | 'unknown';
  /** a short line from the log, redacted to its error sentence */
  detail?: string;
}

/**
 * Reads the end of GenBot's own server log (read-only) to tell a harness that crashes at start from one still starting.
 * Only the error sentence is shown: a log can hold anything, so it is data, never instructions.
 */
export function diagnoseHarness(logTail: string): HarnessDiagnosis {
  const lines = logTail.split(/\r?\n/).slice(-80);
  const lastExit = lines.findLastIndex((l) => /exited code=[1-9]|exited before answering/.test(l));
  const lastSpawn = lines.findLastIndex((l) => /\bspawned pid=|\bfork .*port=/.test(l));
  if (lastExit >= 0 && lastExit >= lastSpawn) {
    const err = lines.slice(0, lastExit + 1).findLast((l) => /^\s*(?:Error|[A-Z]\w*Error): /.test(l));
    const detail = err?.trim().replace(/[^\p{L}\p{N} .,:;()'"/_-]/gu, '').slice(0, 160);
    return { kind: 'crash', ...(detail ? { detail } : {}) };
  }
  if (lastSpawn >= 0) return { kind: 'starting' };
  return { kind: 'unknown' };
}

export function readTail(file: string, bytes = 16_384): string {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(bytes, size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Whether the GenBot app process is up (its harness may still be down). */
export async function genbotProcessRunning(platform: NodeJS.Platform, exec: Exec = realExec): Promise<boolean> {
  if (platform === 'darwin') return (await exec('pgrep', ['-f', 'GenBot.app/Contents/MacOS/GenBot$'])).code === 0;
  if (platform === 'win32') {
    const r = await exec('tasklist', ['/FI', 'IMAGENAME eq GenBot.exe', '/NH']);
    return r.code === 0 && /GenBot\.exe/i.test(r.stdout);
  }
  return false;
}
