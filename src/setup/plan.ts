// Pure decisions of `npm run setup`, kept apart so they are tested without a network, a GenBot or a disk.
import { compareVersions, type TargetResult } from './release.js';
import type { Installed } from './genbot-app.js';

export interface SetupFlags {
  dryRun: boolean;
  resume: boolean;
  updateGenbot: boolean;
  system: boolean;
  open: boolean;
  start: boolean;
  help: boolean;
}

export const SETUP_HELP = `npm run setup -- [tuỳ chọn]

  --update-genbot   Cập nhật GenBot lên bản mới nhất nếu đang cài bản cũ hơn
  --resume          Chạy tiếp từ bước khởi động GenBot (sau khi bạn làm xong bước trong app GenBot)
  --dry-run         Chỉ in việc sẽ làm, không tải, không cài, không ghi file, không mở app
  --system          (macOS) Cho phép dùng sudo để chép GenBot vào /Applications khi tài khoản này không ghi được ở đó
  --no-open         Không tự mở trình duyệt (vẫn in liên kết)
  --no-start        Cài xong thì dừng, không chạy Open AgenticOS
  --help            Hiện trợ giúp này`;

export function parseFlags(argv: string[]): { flags: SetupFlags; unknown: string[] } {
  const flags: SetupFlags = { dryRun: false, resume: false, updateGenbot: false, system: false, open: true, start: true, help: false };
  const unknown: string[] = [];
  for (const a of argv) {
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--resume') flags.resume = true;
    else if (a === '--update-genbot') flags.updateGenbot = true;
    else if (a === '--system') flags.system = true;
    else if (a === '--no-open') flags.open = false;
    else if (a === '--no-start') flags.start = false;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--skip-npm') continue; // handled by install.sh / install.ps1
    else unknown.push(a);
  }
  return { flags, unknown };
}

export type EnvDecision = 'keep' | 'create' | 'no-example';

/** .env is created once from .env.example and never overwritten; AIOS_ENCRYPTION_KEY is filled by the app itself. */
export function decideEnv(envExists: boolean, exampleExists: boolean): EnvDecision {
  if (envExists) return 'keep';
  return exampleExists ? 'create' : 'no-example';
}

export type GenbotDecision =
  | { action: 'unsupported'; reason: string; instead: string }
  | { action: 'skip'; installed: Installed }
  | { action: 'up-to-date'; installed: Installed; latest: string }
  | { action: 'update'; installed: Installed; latest: string }
  | { action: 'install'; latest: string };

/** Whether step d must ask GitHub at all: not when GenBot is there and no update was asked for. */
export function needsLatest(target: TargetResult, installed: Installed | null, updateGenbot: boolean): boolean {
  if (!target.ok) return false;
  return !installed || updateGenbot;
}

export function decideGenbot(target: TargetResult, installed: Installed | null, updateGenbot: boolean, latest: string | null): GenbotDecision {
  if (!target.ok) return { action: 'unsupported', reason: target.reason, instead: target.instead };
  if (installed && !updateGenbot) return { action: 'skip', installed };
  if (!latest) throw new Error('decideGenbot: latest version needed');
  if (!installed) return { action: 'install', latest };
  // An unknown installed version is treated as older: the owner asked for --update-genbot.
  if (installed.version && compareVersions(installed.version, latest) >= 0) return { action: 'up-to-date', installed, latest };
  return { action: 'update', installed, latest };
}

/** Node major from package.json engines ("">=22", "^22.3", "22.x"); the shell scripts parse it the same way. */
export function requiredNodeMajor(engines: string | undefined): number | null {
  const m = /(\d{1,3})/.exec(engines ?? '');
  return m ? Number(m[1]) : null;
}

export function nodeMajor(version: string): number {
  return Number(/^v?(\d+)/.exec(version)?.[1] ?? 0);
}

/** The pairing link the app prints at start (src/api/owner.ts announce). */
export const PAIR_LINK_RE = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{2,5}\/api\/owner\/pair\?code=[A-Za-z0-9%-]{4,64}/;

export function findPairLink(text: string): string | null {
  return PAIR_LINK_RE.exec(text)?.[0] ?? null;
}

/** What to do at step g when something already answers on the API port. */
export type AppStartDecision = 'start' | 'already-running' | 'port-taken';

export function decideAppStart(apiHealth: { ok: boolean; isAios: boolean }): AppStartDecision {
  if (!apiHealth.ok) return 'start';
  return apiHealth.isAios ? 'already-running' : 'port-taken';
}
