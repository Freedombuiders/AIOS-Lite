#!/usr/bin/env tsx
/**
 * Signs this machine in to the cloud through the desktop flow and prints a
 * machine session token (90 days):
 *
 *   npm run login -- --url https://cloud.example.com [--label "Máy ở tiệm"]
 *
 * Opens /auth/web/start in the browser with a return address on a one-off
 * 127.0.0.1 port, waits for the one-time code, checks the state, and trades
 * the code at POST /auth/exchange. Paste the token into Integrations ›
 * AgenticOS Cloud, or export it as AGENTICOS_CLOUD_TOKEN for scripts/pack.ts.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
}

const base = (flag('url') ?? process.env.AGENTICOS_CLOUD_URL ?? '').replace(/\/+$/, '');
if (!/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) {
  console.error('Dùng: npm run login -- --url https://<địa chỉ cloud>');
  process.exit(2);
}
const label = flag('label') ?? 'Máy tính';
const state = randomBytes(24).toString('base64url');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
  const done = (message: string, code = 0) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<p>${message}</p><p>Có thể đóng cửa sổ này.</p>`);
    server.close();
    process.exitCode = code;
  };
  if (url.searchParams.get('state') !== state) return done('Sai state, đã dừng.', 1);
  const code = url.searchParams.get('code');
  if (!code) return done(`Đăng nhập không thành công (${url.searchParams.get('error') ?? 'không rõ lỗi'}).`, 1);
  const r = await fetch(`${base}/auth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, state, kind: 'machine', label }),
  });
  const body = await r.json() as { token?: string; user?: { email: string }; error?: { message: string } };
  if (!r.ok || !body.token) return done(`Không đổi được mã: ${body.error?.message ?? r.status}`, 1);
  console.log(`Đã đăng nhập ${body.user?.email}. Mã phiên của máy (giữ kín):\n${body.token}`);
  done('Đã đăng nhập. Quay lại cửa sổ dòng lệnh.');
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address() as AddressInfo;
  const start = `${base}/auth/web/start?return=${encodeURIComponent(`http://127.0.0.1:${port}/callback`)}&state=${state}`;
  console.log(`Mở trình duyệt để đăng nhập Google:\n${start}`);
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(opener, [start], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
});

setTimeout(() => { console.error('Hết 5 phút chờ đăng nhập.'); process.exit(1); }, 5 * 60_000).unref();
