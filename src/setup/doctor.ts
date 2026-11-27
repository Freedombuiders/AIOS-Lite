// `aios doctor` / `npm run doctor`: one line per item with its fix. Reads only: it never installs, starts or writes
// anything. The one call that leaves this machine's loopback is optional: `--probe` sends each connected GenBot bot a
// "ping" through AIOS (owner-only route, needs AIOS_TOKEN), which costs one turn per bot.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { aiosHealth, WEB_PORT } from './app-run.js';
import { diagnoseHarness, findInstalled, genbotLogFile, genbotProcessRunning, harnessAnswers, httpAnswers, HARNESS_PORTS, readTail, realExec, type Exec, type Installed } from './genbot-app.js';
import { nodeMajor, requiredNodeMajor } from './plan.js';
import type { Fetch } from './release.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
  id: string;
  status: CheckStatus;
  label: string;
  message: string;
  fix?: string;
}

export interface DoctorEnv {
  platform: NodeJS.Platform;
  nodeVersion: string;
  rootDir: string;
  apiPort: number;
  token?: string;
  fetch: Fetch;
  exec: Exec;
  /** true when something accepts a TCP connection on 127.0.0.1:port */
  portOpen(port: number): Promise<boolean>;
  findGenbot(): Promise<Installed | null>;
  genbotRunning(): Promise<boolean>;
  /** GenBot's own server log, read only, and the end of it ('' when there is none) */
  genbotLog(): { file: string | null; tail: string };
  which(cmd: string): Promise<boolean>;
  readFile(file: string): string | null;
  exists(p: string): boolean;
  home: string;
  probe: boolean;
}

export function tcpOpen(port: number, host = '127.0.0.1', timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export function realDoctorEnv(rootDir: string, opts: { apiPort: number; token?: string; probe: boolean }): DoctorEnv {
  const platform = process.platform;
  return {
    platform,
    nodeVersion: process.version,
    rootDir,
    apiPort: opts.apiPort,
    ...(opts.token ? { token: opts.token } : {}),
    fetch,
    exec: realExec,
    portOpen: (p) => tcpOpen(p),
    findGenbot: () => findInstalled(platform),
    genbotRunning: () => genbotProcessRunning(platform),
    genbotLog: () => {
      const file = genbotLogFile(platform);
      return { file, tail: file ? readTail(file) : '' };
    },
    which: async (cmd) => (await realExec(platform === 'win32' ? 'where' : 'which', [cmd])).code === 0,
    readFile: (f) => {
      try {
        return fs.readFileSync(f, 'utf8');
      } catch {
        return null;
      }
    },
    exists: (p) => fs.existsSync(p),
    home: os.homedir(),
    probe: opts.probe,
  };
}

const installNode = (platform: NodeJS.Platform, major: number): string =>
  platform === 'darwin'
    ? `brew install node@${major}  (chưa có Homebrew: tải bản LTS ở https://nodejs.org)`
    : platform === 'win32'
      ? 'winget install OpenJS.NodeJS.LTS'
      : `cài Node ${major} bằng nvm: nvm install ${major}`;

// ------------------------------------------------------------------ checks

export function checkNode(env: DoctorEnv): Check {
  let engines: string | undefined;
  try {
    engines = (JSON.parse(env.readFile(path.join(env.rootDir, 'package.json')) ?? '{}') as { engines?: { node?: string } }).engines?.node;
  } catch {
    engines = undefined;
  }
  const need = requiredNodeMajor(engines) ?? 22;
  const have = nodeMajor(env.nodeVersion);
  if (have >= need) return { id: 'node', status: 'ok', label: 'Node', message: `${env.nodeVersion} (cần ${need} trở lên)` };
  return { id: 'node', status: 'fail', label: 'Node', message: `${env.nodeVersion}, cần ${need} trở lên`, fix: installNode(env.platform, need) };
}

const portFix = (env: DoctorEnv, port: number): string =>
  env.platform === 'win32' ? `xem chương trình nào giữ cổng: netstat -ano | findstr :${port}` : `xem chương trình nào giữ cổng: lsof -nP -iTCP:${port} -sTCP:LISTEN`;

export async function checkAiosPorts(env: DoctorEnv): Promise<Check[]> {
  const out: Check[] = [];
  const api = await aiosHealth(env.fetch, env.apiPort);
  if (api.isAios) out.push({ id: 'port.api', status: 'ok', label: `Cổng ${env.apiPort} (API)`, message: `Open AgenticOS đang chạy${api.version ? ` (bản ${api.version})` : ''}` });
  else if (api.ok || (await env.portOpen(env.apiPort))) out.push({ id: 'port.api', status: 'fail', label: `Cổng ${env.apiPort} (API)`, message: 'một chương trình khác đang giữ cổng này', fix: `${portFix(env, env.apiPort)}, hoặc đặt AIOS_PORT khác trong .env` });
  else out.push({ id: 'port.api', status: 'warn', label: `Cổng ${env.apiPort} (API)`, message: 'trống: Open AgenticOS chưa chạy', fix: 'npm run dev' });

  const web = await env.portOpen(WEB_PORT);
  out.push(
    web
      ? { id: 'port.web', status: 'ok', label: `Cổng ${WEB_PORT} (giao diện dev)`, message: 'có chương trình đang nghe ở 127.0.0.1 (thường là giao diện dev; nếu đó là checkout khác, giao diện của bạn chạy ở cổng kế tiếp, xem dòng "Local:" của npm run dev)' }
      : { id: 'port.web', status: api.isAios ? 'warn' : 'skip', label: `Cổng ${WEB_PORT} (giao diện dev)`, message: 'trống', fix: 'npm run dev (giao diện ở http://127.0.0.1:5173)' },
  );
  return out;
}

export interface GenbotState {
  installed: Installed | null;
  running: boolean;
  harnessPort: number | null;
  botApi: boolean;
}

export async function checkGenbot(env: DoctorEnv): Promise<{ checks: Check[]; state: GenbotState }> {
  const checks: Check[] = [];
  const installed = await env.findGenbot();
  const supported = env.platform === 'darwin' || env.platform === 'win32';
  if (installed) checks.push({ id: 'genbot.installed', status: 'ok', label: 'GenBot', message: `đã cài ở ${installed.path}${installed.version ? `, bản ${installed.version}` : ''}` });
  else if (!supported) checks.push({ id: 'genbot.installed', status: 'warn', label: 'GenBot', message: 'không có bản cho máy này', fix: 'dùng GenBot trên Mac Apple Silicon hoặc Windows và điền địa chỉ https:// của nó ở Đội AI · Bot' });
  else checks.push({ id: 'genbot.installed', status: 'fail', label: 'GenBot', message: 'chưa cài', fix: 'npm run setup' });

  let harnessPort: number | null = null;
  for (const p of HARNESS_PORTS) {
    if (await harnessAnswers(env.fetch, p)) {
      harnessPort = p;
      break;
    }
  }
  const running = harnessPort !== null || (await env.genbotRunning());
  if (harnessPort !== null) checks.push({ id: 'genbot.harness', status: 'ok', label: `Cổng ${harnessPort} (GenBot)`, message: 'harness GenBot đang trả lời' });
  else if (running) {
    const log = env.genbotLog();
    const diag = diagnoseHarness(log.tail);
    checks.push(
      diag.kind === 'crash'
        ? { id: 'genbot.harness', status: 'fail', label: 'Cổng 8799 (GenBot)', message: `app GenBot đang mở nhưng phần chạy nền dừng ngay khi khởi động${diag.detail ? `: "${diag.detail}"` : ''}`, fix: `lỗi bên trong GenBot (nhật ký: ${log.file}); thoát hẳn GenBot rồi mở lại, vẫn lỗi thì gửi nhật ký cho hỗ trợ GenBot` }
        : { id: 'genbot.harness', status: 'fail', label: 'Cổng 8799 (GenBot)', message: 'app GenBot đang mở nhưng harness không trả lời', fix: 'xem cửa sổ GenBot (đăng nhập, chọn AI lần đầu); rồi npm run setup -- --resume' },
    );
  }
  else if (await env.portOpen(HARNESS_PORTS[0])) checks.push({ id: 'genbot.harness', status: 'warn', label: 'Cổng 8799 (GenBot)', message: 'GenBot chưa chạy và một chương trình khác đang giữ cổng 8799 (GenBot sẽ dùng 18799)', fix: portFix(env, HARNESS_PORTS[0]) });
  else checks.push({ id: 'genbot.harness', status: installed ? 'warn' : 'skip', label: 'Cổng 8799 (GenBot)', message: 'GenBot chưa chạy', fix: installed ? 'mở app GenBot, hoặc npm run setup -- --resume' : undefined });

  const receiverPort = (harnessPort ?? 8799) + 1;
  const botApi = await httpAnswers(env.fetch, `http://127.0.0.1:${receiverPort}/`);
  if (botApi) checks.push({ id: 'genbot.botapi', status: 'ok', label: `Cổng ${receiverPort} (Bot API)`, message: 'cổng nhận Bot API của GenBot đang trả lời' });
  else checks.push({ id: 'genbot.botapi', status: running ? 'fail' : 'skip', label: `Cổng ${receiverPort} (Bot API)`, message: harnessPort === null ? 'không trả lời (đi cùng harness ở trên)' : 'không trả lời', fix: running ? (harnessPort === null ? 'sửa harness ở trên' : 'khởi động lại GenBot') : undefined });
  return { checks, state: { installed, running, harnessPort, botApi } };
}

interface GenbotBotCard {
  id: string;
  name: string;
  botId: string;
  enabled: boolean;
  key: { hasKey: boolean; source: 'store' | 'env' | null };
}

async function apiJson<T>(env: DoctorEnv, method: 'GET' | 'POST', p: string, body?: unknown): Promise<{ status: number; data?: T }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (env.token) headers.authorization = `Bearer ${env.token}`;
  const res = await env.fetch(`http://127.0.0.1:${env.apiPort}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) as T };
  } catch {
    return { status: res.status };
  }
}

/** Each GenBot agent: has a bot id and a key (never read: only "has a key"), and, with --probe, answers a ping. */
export async function checkAgents(env: DoctorEnv, aiosUp: boolean, botApiUp: boolean): Promise<Check[]> {
  if (!aiosUp) return [{ id: 'agents', status: 'skip', label: 'Bot GenBot', message: 'chưa kiểm được: Open AgenticOS chưa chạy', fix: 'npm run dev rồi chạy lại doctor' }];
  let bots: GenbotBotCard[];
  try {
    const r = await apiJson<{ bots?: GenbotBotCard[] }>(env, 'GET', '/api/genbot');
    if (r.status !== 200 || !Array.isArray(r.data?.bots)) return [{ id: 'agents', status: 'warn', label: 'Bot GenBot', message: `API /api/genbot trả ${r.status}` }];
    bots = r.data.bots;
  } catch (e) {
    return [{ id: 'agents', status: 'warn', label: 'Bot GenBot', message: `không đọc được danh sách bot (${(e as Error).message})` }];
  }
  if (!bots.length) return [{ id: 'agents', status: 'warn', label: 'Bot GenBot', message: 'chưa có bot nào', fix: 'Đội AI · Bot › Thêm bot GenBot (hoặc cài gói Đội AgenticOS mặc định)' }];
  const out: Check[] = [];
  for (const b of bots) {
    const label = `Bot ${b.id}`;
    if (!b.enabled) {
      out.push({ id: `agent.${b.id}`, status: 'skip', label, message: 'đang tạm dừng' });
      continue;
    }
    if (!b.botId) {
      out.push({ id: `agent.${b.id}`, status: 'warn', label, message: 'chưa nối GenBot (thiếu mã bot)', fix: 'Đội AI · Bot › thẻ bot › Sửa, điền Mã bot GenBot' });
      continue;
    }
    if (!b.key?.hasKey) {
      out.push({ id: `agent.${b.id}`, status: 'fail', label, message: 'chưa có khoá Bot API', fix: 'Đội AI · Bot › thẻ bot › Đổi khoá, dán khoá chép từ GenBot' });
      continue;
    }
    const keyWhere = b.key.source === 'env' ? 'khoá trong .env' : 'có khoá';
    if (!env.probe) {
      out.push({ id: `agent.${b.id}`, status: 'ok', label, message: `${keyWhere}, mã bot ${b.botId} (chưa gửi thử; thêm --probe để gửi "ping")` });
      continue;
    }
    if (!botApiUp) {
      out.push({ id: `agent.${b.id}`, status: 'fail', label, message: `${keyWhere}, nhưng GenBot không trả lời`, fix: 'mở app GenBot' });
      continue;
    }
    if (!env.token) {
      out.push({ id: `agent.${b.id}`, status: 'skip', label, message: `${keyWhere}; gửi thử cần quyền chủ`, fix: 'đặt AIOS_TOKEN trong .env, hoặc bấm Kiểm tra trên thẻ bot ở Đội AI · Bot' });
      continue;
    }
    try {
      const r = await apiJson<{ summary?: { ok?: boolean; message?: string } }>(env, 'POST', `/api/genbot/bots/${encodeURIComponent(b.id)}/check`, {});
      const ok = r.status === 200 && r.data?.summary?.ok === true;
      const msg = (r.data?.summary?.message ?? `HTTP ${r.status}`).replace(/\s+/g, ' ').slice(0, 140);
      out.push(ok ? { id: `agent.${b.id}`, status: 'ok', label, message: `trả lời "ping": ${msg}` } : { id: `agent.${b.id}`, status: 'fail', label, message: `gửi thử lỗi: ${msg}`, fix: 'xem bảng lỗi trong docs/huong-dan-noi-genbot.md' });
    } catch (e) {
      out.push({ id: `agent.${b.id}`, status: 'fail', label, message: `gửi thử lỗi: ${(e as Error).message}` });
    }
  }
  return out;
}

export async function checkMediaTools(env: DoctorEnv): Promise<Check[]> {
  const fix = (tool: 'yt-dlp' | 'ffmpeg') =>
    env.platform === 'darwin' ? `brew install ${tool}` : env.platform === 'win32' ? `winget install ${tool === 'yt-dlp' ? 'yt-dlp.yt-dlp' : 'Gyan.FFmpeg'}` : `cài ${tool} bằng trình quản lý gói của máy`;
  const out: Check[] = [];
  for (const tool of ['yt-dlp', 'ffmpeg'] as const) {
    const has = await env.which(tool);
    out.push(has ? { id: `tool.${tool}`, status: 'ok', label: tool, message: 'có (dùng cho Dream 100)' } : { id: `tool.${tool}`, status: 'warn', label: tool, message: 'chưa có; chỉ cần cho Dream 100 (không bắt buộc)', fix: fix(tool) });
  }
  return out;
}

function expandHome(p: string, home: string): string {
  return p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

/** Brain history only works in a folder that is itself the top of a git repo (src/shared/brain-git.ts never inits one). */
export function checkBrainGit(env: DoctorEnv): Check[] {
  const text = env.readFile(path.join(env.rootDir, 'config', 'brain.yaml'));
  if (text === null) return [{ id: 'brain', status: 'skip', label: 'Brain', message: 'chưa có config/brain.yaml' }];
  let folders: { id?: unknown; path?: unknown }[] = [];
  try {
    const doc = parseYaml(text) as { folders?: unknown };
    folders = Array.isArray(doc?.folders) ? (doc.folders as typeof folders) : [];
  } catch {
    return [{ id: 'brain', status: 'warn', label: 'Brain', message: 'config/brain.yaml không phải YAML hợp lệ', fix: 'sửa file hoặc quản lý thư mục ở trang Brain' }];
  }
  const out: Check[] = [];
  const root = path.resolve(env.rootDir);
  for (const f of folders) {
    if (typeof f?.id !== 'string' || typeof f.path !== 'string') continue;
    const abs = path.resolve(env.rootDir, expandHome(f.path, env.home));
    const label = `Brain ${f.id}`;
    if (!env.exists(abs)) {
      out.push({ id: `brain.${f.id}`, status: 'warn', label, message: `không thấy thư mục ${abs}`, fix: 'sửa đường dẫn ở trang Brain' });
      continue;
    }
    if (env.exists(path.join(abs, '.git'))) {
      out.push({ id: `brain.${f.id}`, status: 'ok', label, message: 'có git: sửa của máy được lưu lịch sử, hoàn tác được' });
      continue;
    }
    const insideApp = abs === root || abs.startsWith(root + path.sep);
    out.push(
      insideApp
        ? { id: `brain.${f.id}`, status: 'ok', label, message: 'thư mục mẫu nằm trong repo app: không lưu lịch sử riêng (bình thường)' }
        : { id: `brain.${f.id}`, status: 'warn', label, message: 'chưa có git: sửa của máy không hoàn tác được', fix: `git -C "${abs}" init` },
    );
  }
  return out.length ? out : [{ id: 'brain', status: 'skip', label: 'Brain', message: 'chưa có thư mục brain nào' }];
}

export async function runDoctor(env: DoctorEnv): Promise<Check[]> {
  const checks: Check[] = [checkNode(env)];
  const ports = await checkAiosPorts(env);
  checks.push(...ports);
  const genbot = await checkGenbot(env);
  checks.push(...genbot.checks);
  checks.push(...(await checkAgents(env, ports[0]?.status === 'ok', genbot.state.botApi)));
  checks.push(...(await checkMediaTools(env)));
  checks.push(...checkBrainGit(env));
  return checks;
}

const MARK: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'chú ', fail: 'LỖI ', skip: 'bỏ  ' };

export function formatChecks(checks: Check[]): string[] {
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${MARK[c.status]} ${c.label}: ${c.message}`);
    if (c.fix && c.status !== 'ok') lines.push(`      cách sửa: ${c.fix}`);
  }
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  lines.push(fails ? `${fails} lỗi, ${warns} lưu ý.` : warns ? `Không có lỗi, ${warns} lưu ý.` : 'Mọi thứ đều ổn.');
  return lines;
}
