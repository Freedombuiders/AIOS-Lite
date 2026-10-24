import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isProcessAlive } from './compat.js';
import { callZaloDaemon, configureZaloControl, ZALO_TOKEN_HEADER, ZaloDaemonUnavailableError } from './control.js';
import { setZaloDataDir, ZALO_PID_FILE } from './paths.js';
import { createZaloSupervisor, type ZaloSupervisor } from './supervisor.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-fixtures', 'fake-daemon.mjs');
const log = { info() {}, warn() {}, error() {} };

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 8_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

describe('zalo daemon supervisor (fake daemon entry)', () => {
  let dir: string;
  let port: number;
  let sup: ZaloSupervisor;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zalo-sup-'));
    setZaloDataDir(dir);
    port = await freePort();
    sup = createZaloSupervisor({
      rootDir: dir, dataDir: dir, dbPath: path.join(dir, 'aios.db'), port, log,
      entryArgs: [FAKE], backoffMs: [50], killAfterMs: 2_000,
    });
  });

  afterEach(async () => {
    await sup.stop();
    configureZaloControl(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts the child with the module env, answers on the control channel, and refuses a wrong token', async () => {
    sup.start();
    expect(await sup.waitReady()).toBe(true);
    const res = await callZaloDaemon<{ pid: number; env: { db: string } }>('GET', '/status');
    expect(res.status).toBe(200);
    expect(res.data.pid).toBe(sup.pid());
    expect(res.data.env.db).toBe(path.join(dir, 'aios.db'));
    expect(fs.readFileSync(ZALO_PID_FILE, 'utf8')).toBe(String(sup.pid()));

    const bad = await fetch(`http://127.0.0.1:${port}/status`, { headers: { [ZALO_TOKEN_HEADER]: 'nope' } });
    expect(bad.status).toBe(401);
  });

  it('restarts the daemon with backoff after a crash', async () => {
    sup.start();
    expect(await sup.waitReady()).toBe(true);
    const first = sup.pid()!;
    await callZaloDaemon('GET', '/crash', { timeoutMs: 1_000 }).catch(() => {});
    expect(await until(() => sup.restarts() === 1 && sup.pid() !== null && sup.pid() !== first)).toBe(true);
    expect(await sup.waitReady()).toBe(true);
    expect(isProcessAlive(first)).toBe(false);
  });

  it('stop terminates the child gracefully, removes its pid file and closes the control channel', async () => {
    sup.start();
    expect(await sup.waitReady()).toBe(true);
    const pid = sup.pid()!;
    await sup.stop();
    expect(sup.pid()).toBeNull();
    expect(await until(() => !isProcessAlive(pid))).toBe(true);
    expect(fs.existsSync(ZALO_PID_FILE)).toBe(false);
    await expect(callZaloDaemon('GET', '/status')).rejects.toBeInstanceOf(ZaloDaemonUnavailableError);
    // a stopped supervisor does not resurrect the child
    await new Promise((r) => setTimeout(r, 150));
    expect(sup.pid()).toBeNull();
    expect(sup.restarts()).toBe(0);
  });

  it('terminates a daemon left behind by a previous run before starting', async () => {
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(ZALO_PID_FILE, String(orphan.pid));
    expect(isProcessAlive(orphan.pid!)).toBe(true);
    sup.start();
    expect(await sup.waitReady()).toBe(true);
    expect(await until(() => !isProcessAlive(orphan.pid!))).toBe(true);
    expect(sup.pid()).not.toBe(orphan.pid);
  });

  it('restart() swaps the child and the control token', async () => {
    sup.start();
    expect(await sup.waitReady()).toBe(true);
    const before = sup.pid()!;
    await sup.restart();
    expect(await sup.waitReady()).toBe(true);
    expect(sup.pid()).not.toBe(before);
  });
});
