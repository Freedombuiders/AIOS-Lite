#!/usr/bin/env node
// `npm run setup` steps c–g (install.sh / install.ps1 did a: prerequisites and b: npm ci, then run this file).
// Every step checks what is already there first, so running setup again skips what is done and repairs what is
// missing. It never deletes user data: brain folders, data/, .env, GenBot's own data folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.js';
import { aiosHealth, openUrl, pairLinkForWeb, startDev, waitForHttp, watchDevOutput, WEB_PORT } from './app-run.js';
import { connectSteps, HEADLESS_CONNECT_POSSIBLE } from './connect.js';
import {
  diagnoseHarness,
  findInstalled,
  genbotLogFile,
  genbotProcessRunning,
  installMac,
  installWindows,
  isAppleSilicon,
  probeGenbot,
  readTail,
  realExec,
  startGenbot,
  waitForGenbot,
  type Exec,
  type Installed,
} from './genbot-app.js';
import { decideAppStart, decideEnv, decideGenbot, needsLatest, parseFlags, SETUP_HELP, type SetupFlags } from './plan.js';
import { downloadText, downloadVerified, fetchLatestRelease, manifestAssetOf, parseManifest, selectAsset, SetupError, targetFor, type Fetch } from './release.js';

const TOTAL = 7;

export interface SetupIO {
  out(line: string): void;
}

const consoleIO: SetupIO = { out: (l) => console.log(l) };

function step(io: SetupIO, n: number, title: string): void {
  io.out('');
  io.out(`▸ [${n}/${TOTAL}] ${title}`);
}
const ok = (io: SetupIO, s: string) => io.out(`  ✓ ${s}`);
const note = (io: SetupIO, s: string) => io.out(`  • ${s}`);
const warn = (io: SetupIO, s: string) => io.out(`  ! ${s}`);

export interface SetupDeps {
  rootDir: string;
  platform: NodeJS.Platform;
  arch: string;
  fetch: Fetch;
  exec: Exec;
  io: SetupIO;
}

interface Outcome {
  genbotPath: string | null;
  genbotLive: boolean;
  todo: string[];
}

// ------------------------------------------------------------------ c. .env

export function stepEnv(deps: SetupDeps, flags: SetupFlags): void {
  const { io, rootDir } = deps;
  step(io, 3, 'File cấu hình .env');
  const env = path.join(rootDir, '.env');
  const example = path.join(rootDir, '.env.example');
  const d = decideEnv(fs.existsSync(env), fs.existsSync(example));
  if (d === 'keep') return ok(io, 'Đã có .env, giữ nguyên.');
  if (d === 'no-example') return warn(io, 'Không thấy .env.example; app vẫn chạy với giá trị mặc định.');
  if (flags.dryRun) return note(io, '(thử) Sẽ tạo .env từ .env.example.');
  fs.copyFileSync(example, env, fs.constants.COPYFILE_EXCL);
  try {
    fs.chmodSync(env, 0o600);
  } catch {
    /* Windows */
  }
  ok(io, 'Đã tạo .env từ .env.example. Khoá mã hoá được app tự tạo ở lần chạy đầu.');
}

// ------------------------------------------------------------------ d. GenBot install

async function stepGenbotInstall(deps: SetupDeps, flags: SetupFlags, outcome: Outcome): Promise<Installed | null> {
  const { io, platform, exec } = deps;
  step(io, 4, 'Cài GenBot (bộ máy chạy bot)');
  const armMac = platform === 'darwin' ? await isAppleSilicon(exec) : deps.arch === 'arm64';
  const target = targetFor(platform, deps.arch, armMac);
  const installed = await findInstalled(platform, exec);
  if (!target.ok) {
    warn(io, target.reason);
    note(io, target.instead);
    outcome.todo.push(target.instead);
    return null;
  }
  if (target.note) note(io, target.note);
  if (flags.resume) {
    if (installed) ok(io, `GenBot ${installed.version ?? '(không rõ bản)'} ở ${installed.path}.`);
    else warn(io, 'Chưa thấy GenBot; chạy "npm run setup" (không có --resume) để cài.');
    return installed;
  }

  let latest: string | null = null;
  let picked: { release: Awaited<ReturnType<typeof fetchLatestRelease>>; sel: ReturnType<typeof selectAsset> } | null = null;
  if (needsLatest(target, installed, flags.updateGenbot)) {
    note(io, 'Hỏi GitHub bản GenBot mới nhất (github.com/Freedombuiders/genbot-releases)…');
    try {
      const release = await fetchLatestRelease(deps.fetch);
      const manifest = parseManifest(await downloadText(deps.fetch, manifestAssetOf(release, target.target)));
      const sel = selectAsset(release, target.target, manifest);
      latest = sel.version;
      picked = { release, sel };
    } catch (e) {
      const err = e as SetupError;
      warn(io, err.message);
      if (err.hint) note(io, err.hint);
      if (installed) {
        note(io, `Giữ GenBot ${installed.version ?? ''} đang cài.`);
        return installed;
      }
      outcome.todo.push('Cài GenBot: chạy lại "npm run setup" khi có mạng.');
      return null;
    }
  }

  const decision = decideGenbot(target, installed, flags.updateGenbot, latest);
  if (decision.action === 'skip') {
    ok(io, `Đã có GenBot ${decision.installed.version ?? '(không rõ bản)'} ở ${decision.installed.path}; không cài lại (cập nhật: npm run setup -- --update-genbot).`);
    return decision.installed;
  }
  if (decision.action === 'up-to-date') {
    ok(io, `GenBot ${decision.installed.version} đã là bản mới nhất (${decision.latest}).`);
    return decision.installed;
  }
  if (decision.action === 'unsupported') return null;
  const { sel } = picked!;
  const mb = Math.round(sel.asset.size / 1024 / 1024);
  if (decision.action === 'update' && (await genbotProcessRunning(platform, exec))) {
    warn(io, `Có bản GenBot ${decision.latest} nhưng GenBot đang mở. Thoát hẳn GenBot (menu GenBot › Thoát) rồi chạy lại: npm run setup -- --update-genbot`);
    return decision.installed;
  }
  if (flags.dryRun) {
    note(io, `(thử) Sẽ tải ${sel.asset.name} (${mb} MB) từ ${sel.asset.url}, kiểm sha512 theo ${target.target.manifest}, rồi cài${decision.action === 'update' ? ` thay bản ${decision.installed.version}` : ''}.`);
    return installed;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-genbot-'));
  try {
    const file = path.join(work, sel.asset.name);
    note(io, `Tải ${sel.asset.name} (${mb} MB)…`);
    let lastTenth = -1;
    await downloadVerified(deps.fetch, sel.asset, sel.expected, file, (done, total) => {
      const tenth = total > 0 ? Math.floor((done / total) * 10) : -1;
      if (tenth > lastTenth && tenth < 10) {
        lastTenth = tenth;
        if (tenth > 0) io.out(`    ${tenth * 10}%`);
      }
    });
    ok(io, `Đã tải và kiểm sha512 khớp với ${target.target.manifest}.`);
    if (platform === 'darwin') {
      const r = await installMac(file, work, { system: flags.system, exec, log: io.out });
      ok(io, `Đã cài GenBot ${sel.version} vào ${r.path}.`);
      if (r.gatekeeper.notarized) {
        note(io, 'Apple đã kiểm (notarized). Lần đầu mở, macOS hỏi "GenBot là ứng dụng tải từ Internet…": bấm Mở.');
      } else {
        warn(io, `GenBot chưa được Apple notarize (${r.gatekeeper.detail || 'Gatekeeper từ chối'}). macOS sẽ chặn lần mở đầu; trình cài không tắt Gatekeeper.`);
        note(io, 'Mở một lần: Cài đặt hệ thống › Quyền riêng tư & Bảo mật › kéo xuống, bấm "Vẫn mở" cạnh GenBot; hoặc trong Finder › Ứng dụng, giữ Control, bấm GenBot › Mở.');
        outcome.todo.push('Mở GenBot một lần qua Quyền riêng tư & Bảo mật › Vẫn mở, rồi chạy: npm run setup -- --resume');
      }
      return { path: r.path, version: sel.version };
    }
    const r = await installWindows(file, sel.asset.url, { exec, log: io.out });
    note(io, `Bản cài ${r.signature}.`);
    const after = await findInstalled(platform, exec);
    if (!after) throw new SetupError('Trình cài GenBot chạy xong nhưng không thấy GenBot.exe.', 'Cài tay từ github.com/Freedombuiders/genbot-releases/releases/latest rồi chạy lại "npm run setup".');
    ok(io, `Đã cài GenBot ${after.version ?? sel.version} vào ${after.path}.`);
    return after;
  } catch (e) {
    const err = e as SetupError;
    warn(io, err.message);
    if (err.hint) note(io, err.hint);
    outcome.todo.push('Cài GenBot: xem lỗi ở bước 4 rồi chạy lại "npm run setup".');
    return installed;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ e. start GenBot

async function stepGenbotStart(deps: SetupDeps, flags: SetupFlags, installed: Installed | null, outcome: Outcome): Promise<void> {
  const { io, platform, exec } = deps;
  step(io, 5, 'Khởi động GenBot');
  if (!installed) return note(io, 'Bỏ qua: máy này chưa có GenBot.');
  let live = await probeGenbot(deps.fetch);
  if (live.harnessPort !== null && live.botApi) {
    outcome.genbotLive = true;
    return ok(io, `GenBot đang chạy: harness 127.0.0.1:${live.harnessPort}, Bot API 127.0.0.1:${live.harnessPort + 1}.`);
  }
  if (flags.dryRun) return note(io, `(thử) Sẽ mở ${installed.path} và chờ tối đa 60 giây cho cổng 8799 và 8800.`);
  if (!(await genbotProcessRunning(platform, exec))) {
    const r = await startGenbot(platform, installed.path, exec);
    if (r.code !== 0) {
      warn(io, `Không mở được GenBot: ${r.stderr.trim().slice(0, 160)}`);
      outcome.todo.push('Mở app GenBot bằng tay rồi chạy: npm run setup -- --resume');
      return;
    }
    note(io, 'Đã mở GenBot. Chờ GenBot sẵn sàng (tối đa 60 giây)…');
  } else note(io, 'GenBot đang mở. Chờ phần chạy nền trả lời (tối đa 60 giây)…');
  const started = Date.now();
  let lastTick = 0;
  live = await waitForGenbot(deps.fetch, {
    timeoutMs: 60_000,
    sleep: async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      const s = Math.floor((Date.now() - started) / 15_000);
      if (s > lastTick) {
        lastTick = s;
        io.out(`    … ${s * 15} giây`);
      }
    },
  });
  if (live.harnessPort !== null && live.botApi) {
    outcome.genbotLive = true;
    return ok(io, `GenBot sẵn sàng: harness 127.0.0.1:${live.harnessPort}, Bot API 127.0.0.1:${live.harnessPort + 1}.`);
  }
  const logFile = genbotLogFile(platform);
  const diag = diagnoseHarness(logFile ? readTail(logFile) : '');
  if (diag.kind === 'crash') {
    warn(io, `Cửa sổ GenBot mở được nhưng phần chạy nền của nó dừng ngay khi khởi động${diag.detail ? `: "${diag.detail}"` : ''}.`);
    note(io, 'Đây là lỗi bên trong GenBot; trình cài không sửa hay xoá dữ liệu của GenBot.');
    note(io, `Nhật ký: ${logFile}`);
    note(io, 'Thử thoát hẳn GenBot rồi mở lại. Vẫn lỗi thì gửi nhật ký trên cho hỗ trợ GenBot (https://genbot.io/ho-tro).');
    outcome.todo.push('Sửa lỗi khởi động của GenBot (xem bước 5), rồi chạy: npm run setup -- --resume');
    return;
  }
  warn(io, live.harnessPort !== null ? 'GenBot đã chạy nhưng cổng Bot API (8800) chưa trả lời.' : 'GenBot chưa trả lời ở 127.0.0.1:8799 sau 60 giây.');
  note(io, 'Có thể GenBot đang chờ bạn làm bước đầu trong cửa sổ của nó:');
  io.out('    1. Bấm Đăng nhập, đăng nhập tài khoản GenBot trên trang app.genbot.io vừa mở, rồi quay lại GenBot.');
  io.out('    2. Nếu GenBot hỏi chọn AI: chọn Claude, Codex hoặc dán khoá API của nhà cung cấp AI bạn dùng.');
  io.out('    3. Khi thấy màn chính của GenBot, chạy: npm run setup -- --resume');
  outcome.todo.push('Làm bước đầu trong GenBot (đăng nhập, chọn AI), rồi chạy: npm run setup -- --resume');
}

// ------------------------------------------------------------------ f. connect

async function stepConnect(deps: SetupDeps, apiPort: number, outcome: Outcome): Promise<void> {
  const { io } = deps;
  step(io, 6, 'Nối bot GenBot với Open AgenticOS');
  const web = `http://127.0.0.1:${WEB_PORT}/bots`;
  // Already done on an earlier run? Read-only look at the running app (no key is ever returned by this route).
  const health = await aiosHealth(deps.fetch, apiPort);
  if (health.isAios) {
    try {
      const res = await deps.fetch(`http://127.0.0.1:${apiPort}/api/genbot`, { signal: AbortSignal.timeout(3000) });
      const data = (await res.json()) as { bots?: { id: string; botId: string; key: { hasKey: boolean } }[] };
      const bots = data.bots ?? [];
      const connected = bots.filter((b) => b.botId && b.key?.hasKey);
      if (connected.length >= 3 || (bots.length > 0 && connected.length === bots.length)) {
        return ok(io, `Đã nối ${connected.length} bot (${connected.map((b) => b.id).join(', ')}). Kiểm lại: npm run doctor -- --probe`);
      }
      if (connected.length) note(io, `Đã nối ${connected.length}/${bots.length} bot.`);
    } catch {
      /* fall through to the steps */
    }
  }
  if (!HEADLESS_CONNECT_POSSIBLE) {
    note(io, 'Phải bấm trong app GenBot: bản desktop GenBot chỉ cho chính cửa sổ của nó tạo bot và cấp khoá Bot API (một lớp an toàn của GenBot), nên trình cài không làm thay được.');
  }
  connectSteps(web).forEach((s, i) => io.out(`    ${i + 1}. ${s}`));
  outcome.todo.push(`Nối ba bot: làm theo bước 6 ở trên (màn Đội AI · Bot: ${web}).`);
}

// ------------------------------------------------------------------ g. start the app

async function stepApp(deps: SetupDeps, flags: SetupFlags, apiPort: number, outcome: Outcome): Promise<number> {
  const { io, platform, exec } = deps;
  step(io, 7, 'Chạy Open AgenticOS');
  const webUrl = `http://127.0.0.1:${WEB_PORT}`;
  printTodo(io, outcome);
  if (!flags.start) {
    note(io, 'Bỏ qua (--no-start). Chạy app: npm run dev, rồi mở liên kết đăng nhập chủ nó in ra.');
    return 0;
  }
  if (flags.dryRun) {
    note(io, `(thử) Sẽ chạy "npm run dev", mở liên kết đăng nhập chủ một lần qua ${webUrl}, rồi mở ${webUrl}/bots.`);
    return 0;
  }
  const decision = decideAppStart(await aiosHealth(deps.fetch, apiPort));
  if (decision === 'port-taken') {
    warn(io, `Cổng ${apiPort} đang bị chương trình khác giữ. Tắt nó, hoặc đặt AIOS_PORT khác trong .env, rồi chạy lại.`);
    return 1;
  }
  if (decision === 'already-running') {
    ok(io, 'Open AgenticOS đã đang chạy; không chạy thêm bản thứ hai.');
    if (await waitForHttp(deps.fetch, `${webUrl}/`, 2000)) {
      if (flags.open) await openUrl(`${webUrl}/bots`, platform, exec);
      note(io, `Mở ${webUrl}/bots. Nếu thấy màn "Đăng nhập chủ", bấm "In mã mới": mã hiện ở terminal đang chạy app.`);
    } else note(io, `Giao diện dev chưa chạy ở ${webUrl}; app đang chạy ở chế độ khác (npm start). Mở http://127.0.0.1:${apiPort}/bots.`);
    return 0;
  }

  note(io, 'Chạy "npm run dev" (Ctrl-C để dừng). Dòng của app hiện bên dưới.');
  const onReady = (link: string, web: string) => {
    void (async () => {
      if (!(await waitForHttp(deps.fetch, `${web}/`, 60_000))) {
        warn(io, `Giao diện chưa trả lời ở ${web}. Mở liên kết đăng nhập chủ ở trên khi giao diện chạy.`);
        return;
      }
      if (web !== webUrl) io.out(`\n  • Cổng ${WEB_PORT} đang bận nên giao diện chạy ở ${web}.`);
      if (flags.open) {
        await openUrl(pairLinkForWeb(link, web), platform, exec);
        await new Promise((r) => setTimeout(r, 2500));
        await openUrl(`${web}/bots`, platform, exec);
        io.out(`\n  ✓ Đã mở liên kết đăng nhập chủ (dùng một lần) và màn Đội AI · Bot (${web}/bots) trong trình duyệt.`);
      } else {
        io.out(`\n  • Mở liên kết đăng nhập chủ in ở trên (dùng một lần), rồi vào ${web}/bots. Nếu dùng localhost thay cho 127.0.0.1, nhập mã ở màn "Đăng nhập chủ".`);
      }
      io.out('  • Dừng app: Ctrl-C. Chạy lại sau này: npm run dev. Kiểm tra máy: npm run doctor\n');
    })();
  };
  const child = startDev(deps.rootDir, platform, watchDevOutput(onReady));
  process.on('SIGINT', () => undefined); // the terminal sends Ctrl-C to npm too; wait for it to stop
  return await new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
}

function printTodo(io: SetupIO, outcome: Outcome): void {
  if (!outcome.todo.length) return;
  io.out('  Việc còn lại cho bạn:');
  outcome.todo.forEach((t, i) => io.out(`    ${i + 1}. ${t}`));
}

// ------------------------------------------------------------------ main

export async function runSetup(argv: string[], deps: SetupDeps): Promise<number> {
  const { flags, unknown } = parseFlags(argv);
  if (flags.help) {
    deps.io.out(SETUP_HELP);
    return 0;
  }
  if (unknown.length) {
    deps.io.out(`Tuỳ chọn không rõ: ${unknown.join(' ')}\n\n${SETUP_HELP}`);
    return 2;
  }
  const outcome: Outcome = { genbotPath: null, genbotLive: false, todo: [] };
  stepEnv(deps, flags);
  const apiPort = loadConfig({ rootDir: deps.rootDir }).port;
  const installed = await stepGenbotInstall(deps, flags, outcome);
  outcome.genbotPath = installed?.path ?? null;
  await stepGenbotStart(deps, flags, installed, outcome);
  await stepConnect(deps, apiPort, outcome);
  return stepApp(deps, flags, apiPort, outcome);
}

if (process.argv[1] && /setup[\\/]main\.(ts|js)$/.test(process.argv[1])) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  runSetup(process.argv.slice(2), { rootDir, platform: process.platform, arch: process.arch, fetch, exec: realExec, io: consoleIO }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`Lỗi không mong đợi: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
