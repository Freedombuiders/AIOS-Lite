// Stand-in for daemon.ts in supervisor tests: same env contract, same pid file, a tiny control server.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const port = Number(process.env.ZALO_CONTROL_PORT);
const token = process.env.ZALO_CONTROL_TOKEN;
const dir = process.env.ZALO_DATA_DIR;
if (!port || !token || !dir || !process.env.ZALO_DB_PATH) process.exit(2);
const pidFile = path.join(dir, 'zalo-daemon.pid');
fs.writeFileSync(pidFile, String(process.pid));

const server = http.createServer((req, res) => {
  if (req.headers['x-zalo-token'] !== token) {
    res.writeHead(401).end('{"error":"unauthorized"}');
    return;
  }
  if (req.url === '/crash') process.exit(1);
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ pid: process.pid, env: { db: process.env.ZALO_DB_PATH } }));
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => {
  server.close();
  try { fs.unlinkSync(pidFile); } catch { /* gone */ }
  process.exit(0);
});
