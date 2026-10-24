#!/usr/bin/env node
// aios — command line for a running AIOS-Lite (talks to the HTTP API), plus `module new` which works offline.
import { parseArgs } from 'node:util';
import { loadConfig } from '../core/config.js';
import { scaffoldModule } from './scaffold.js';

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

export interface CliOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  token?: string;
  modulesDir?: string;
  io?: CliIO;
  pollMs?: number;
}

const HELP = `aios — điều khiển AIOS-Lite đang chạy

Dùng:
  aios agents                                  Liệt kê agent
  aios task "<yêu cầu>" [--agent id] [--wait]  Giao việc (--wait: chờ kết quả)
  aios tasks [--status queued,running] [--limit 20]
                                               Liệt kê việc gần đây
  aios memory add "<nội dung>" [--agent id] [--pin]
  aios memory search <từ khoá>
  aios brain search <từ khoá>                  Tìm trong Second Brain
  aios module list                             Liệt kê module
  aios module add <id> [--agents]              Thêm module (--agents: cài agent mẫu)
  aios module remove <id>                      Gỡ module (giữ dữ liệu)
  aios module new <id>                         Tạo module mới từ khuôn modules/_template
  aios help                                    Hiện trợ giúp này

Biến môi trường (hoặc trong .env): AIOS_HOST, AIOS_PORT, AIOS_TOKEN.`;

class CliError extends Error {}

const TERMINAL = ['done', 'failed', 'cancelled', 'review'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runCli(argv: string[], opts: CliOptions = {}): Promise<number> {
  const io: CliIO = opts.io ?? { out: (t) => console.log(t), err: (t) => console.error(t) };
  const doFetch = opts.fetch ?? fetch;
  const config = () => loadConfig();
  const baseUrl = () => opts.baseUrl ?? `http://${config().host}:${config().port}`;
  const token = () => opts.token ?? config().token;

  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'x-aios-source': 'api' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token()) headers.authorization = `Bearer ${token()}`;
    let res: Response;
    try {
      res = await doFetch(`${baseUrl()}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new CliError(`Không kết nối được AIOS-Lite tại ${baseUrl()}. Hãy chạy "npm run dev" hoặc "npm start" trước.`);
    }
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const msg = (data as { error?: { message?: string } } | undefined)?.error?.message ?? `HTTP ${res.status}`;
      throw new CliError(res.status === 401 ? 'Sai hoặc thiếu AIOS_TOKEN.' : msg);
    }
    return data as T;
  }

  const { values, positionals } = (() => {
    try {
      return parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
          agent: { type: 'string' },
          wait: { type: 'boolean' },
          status: { type: 'string' },
          limit: { type: 'string' },
          pin: { type: 'boolean' },
          agents: { type: 'boolean' },
          help: { type: 'boolean', short: 'h' },
        },
      });
    } catch (e) {
      throw new CliError(`Tham số không hợp lệ: ${(e as Error).message}\n\n${HELP}`);
    }
  })();

  const [cmd, sub, ...rest] = positionals;
  const need = (v: string | undefined, what: string): string => {
    if (!v?.trim()) throw new CliError(`Thiếu ${what}.\n\n${HELP}`);
    return v;
  };

  try {
    if (!cmd || cmd === 'help' || values.help) {
      io.out(HELP);
      return 0;
    }

    if (cmd === 'agents') {
      const { items } = await api<{ items: { id: string; name: string; runtime: string; enabled: boolean; stats: { running: number; queued: number } }[] }>('GET', '/api/agents');
      for (const a of items) io.out(`${a.id.padEnd(16)} ${a.runtime.padEnd(7)} ${a.enabled ? 'bật' : 'tắt'}  đang chạy ${a.stats.running}, chờ ${a.stats.queued}  ${a.name}`);
      return 0;
    }

    if (cmd === 'task') {
      const prompt = need([sub, ...rest].filter(Boolean).join(' '), 'yêu cầu (đặt trong dấu ngoặc kép)');
      const task = await api<{ id: number; status: string }>('POST', '/api/tasks', { prompt, ...(values.agent ? { agentId: values.agent } : {}) });
      io.out(`Đã tạo việc #${task.id}`);
      if (!values.wait) return 0;
      for (;;) {
        const { task: t } = await api<{ task: { id: number; status: string; result: string | null; error: string | null } }>('GET', `/api/tasks/${task.id}`);
        if (TERMINAL.includes(t.status)) {
          io.out(`Trạng thái: ${t.status}`);
          if (t.result) io.out(t.result);
          if (t.error) io.err(t.error);
          return t.status === 'failed' ? 1 : 0;
        }
        await sleep(opts.pollMs ?? 1000);
      }
    }

    if (cmd === 'tasks') {
      const q = new URLSearchParams({ limit: values.limit ?? '20' });
      if (values.status) q.set('status', values.status);
      const { items } = await api<{ items: { id: number; status: string; agentId: string; title: string }[] }>('GET', `/api/tasks?${q}`);
      for (const t of items) io.out(`#${String(t.id).padEnd(5)} ${t.status.padEnd(9)} ${t.agentId.padEnd(14)} ${t.title}`);
      return 0;
    }

    if (cmd === 'memory') {
      if (sub === 'add') {
        const content = need(rest.join(' '), 'nội dung ký ức');
        const m = await api<{ id: number }>('POST', '/api/memory', { content, agentId: values.agent ?? null, pinned: values.pin ?? false });
        io.out(`Đã lưu ký ức #${m.id}${values.agent ? ` cho ${values.agent}` : ' (chung cho đội)'}`);
        return 0;
      }
      if (sub === 'search') {
        const q = need(rest.join(' '), 'từ khoá');
        const { items } = await api<{ items: { id: number; agentId: string | null; content: string }[] }>('GET', `/api/memory?${new URLSearchParams({ q })}`);
        if (!items.length) io.out('Không có kết quả.');
        for (const m of items) io.out(`#${m.id} [${m.agentId ?? 'đội'}] ${m.content}`);
        return 0;
      }
      throw new CliError(`Dùng: aios memory add|search\n\n${HELP}`);
    }

    if (cmd === 'brain') {
      if (sub !== 'search') throw new CliError(`Dùng: aios brain search <từ khoá>\n\n${HELP}`);
      const q = need(rest.join(' '), 'từ khoá');
      const { items } = await api<{ items: { folderId: string; path: string; title: string; snippet: string }[] }>('GET', `/api/brain/search?${new URLSearchParams({ q })}`);
      if (!items.length) io.out('Không có kết quả.');
      for (const h of items) io.out(`${h.folderId}/${h.path}  ${h.title}\n    ${h.snippet}`);
      return 0;
    }

    if (cmd === 'module') {
      if (sub === 'new') {
        const id = need(rest[0], 'id module');
        const dir = scaffoldModule(opts.modulesDir ?? config().modulesDir, id);
        io.out(`Đã tạo module tại ${dir}\nBước tiếp: aios module add ${id}`);
        return 0;
      }
      if (sub === 'list') {
        const { items } = await api<{ items: { manifest: { id: string; name: string; version: string }; state: { enabled: boolean }; ready: boolean }[] }>('GET', '/api/modules');
        for (const m of items) io.out(`${m.manifest.id.padEnd(16)} ${(m.state.enabled ? 'đang bật' : m.ready ? 'chưa thêm' : 'thiếu điều kiện').padEnd(16)} v${m.manifest.version}  ${m.manifest.name}`);
        return 0;
      }
      if (sub === 'add') {
        const id = need(rest[0], 'id module');
        const r = await api<{ migrationsApplied: string[]; agentsInstalled: string[]; module: { error?: string } }>('POST', `/api/modules/${encodeURIComponent(id)}/add`, { installAgents: values.agents ?? false });
        io.out(`Đã thêm module ${id} (migration: ${r.migrationsApplied.length}, agent mẫu: ${r.agentsInstalled.length})`);
        if (r.module.error) io.err(`Cảnh báo: module khởi động lỗi: ${r.module.error}`);
        return 0;
      }
      if (sub === 'remove') {
        const id = need(rest[0], 'id module');
        await api('POST', `/api/modules/${encodeURIComponent(id)}/remove`);
        io.out(`Đã gỡ module ${id} (dữ liệu được giữ lại).`);
        return 0;
      }
      throw new CliError(`Dùng: aios module list|add|remove|new\n\n${HELP}`);
    }

    throw new CliError(`Lệnh không rõ: ${cmd}\n\n${HELP}`);
  } catch (e) {
    io.err(e instanceof CliError || e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (process.argv[1] && /aios\.(ts|js)$/.test(process.argv[1])) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
