import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { candidatePaths, diagnoseHarness, harnessAnswers, macDestination, probeGenbot, quarantineValue, versionFromPlist, waitForGenbot } from './genbot-app.js';
import type { Fetch } from './release.js';

/** A fake GenBot: only 127.0.0.1 ports are ever asked, so the fake maps the expected ports to its own server. */
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function listen(handler: http.RequestListener): Promise<number> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return (s.address() as AddressInfo).port;
}

/** Rewrites 127.0.0.1:<logical port> to the fake server bound to it; other ports refuse like a closed port. */
function portMap(map: Record<number, number>): Fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const real = map[Number(u.port)];
    if (!real) throw new TypeError('fetch failed: ECONNREFUSED');
    u.port = String(real);
    return fetch(u, init);
  }) as Fetch;
}

describe('where GenBot lives', () => {
  it('checks /Applications then ~/Applications on macOS, and the per-user NSIS folder on Windows', () => {
    expect(candidatePaths('darwin', {}, '/Users/a')).toEqual(['/Applications/GenBot.app', '/Users/a/Applications/GenBot.app']);
    expect(candidatePaths('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a')).toEqual(['C:\\Users\\a\\AppData\\Local\\Programs\\GenBot\\GenBot.exe']);
    expect(candidatePaths('linux', {}, '/home/a')).toEqual([]);
  });

  it('reads the version from an XML Info.plist', () => {
    expect(versionFromPlist('<dict><key>CFBundleShortVersionString</key>\n\t<string>1.0.4</string></dict>')).toBe('1.0.4');
    expect(versionFromPlist('<dict></dict>')).toBeNull();
  });

  it('installs into /Applications when writable, else ~/Applications, and uses sudo only with --system', () => {
    expect(macDestination({ system: false, home: '/Users/a', canWrite: () => true })).toEqual({ dir: '/Applications', sudo: false });
    expect(macDestination({ system: false, home: '/Users/a', canWrite: () => false })).toEqual({ dir: '/Users/a/Applications', sudo: false });
    expect(macDestination({ system: true, home: '/Users/a', canWrite: () => false })).toEqual({ dir: '/Applications', sudo: true });
  });

  it('marks the unpacked app as downloaded the way a browser does (Gatekeeper checks it on first open)', () => {
    expect(quarantineValue(0x65000000 * 1000)).toBe('0081;65000000;Open AgenticOS setup;');
  });
});

describe('waiting for GenBot', () => {
  it('finds the harness by its health answer and the Bot API receiver on the next port', async () => {
    const harness = await listen((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(req.url === '/api/health' ? '{"app":"openmausbot"}' : '{}');
    });
    const receiver = await listen((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const live = await probeGenbot(portMap({ 8799: harness, 8800: receiver }));
    expect(live).toEqual({ harnessPort: 8799, botApi: true });
  });

  it('follows the desktop to its fallback port 18799', async () => {
    const harness = await listen((_req, res) => res.end('{"app":"openmausbot"}'));
    const receiver = await listen((_req, res) => res.end());
    expect(await probeGenbot(portMap({ 18799: harness, 18800: receiver }))).toEqual({ harnessPort: 18799, botApi: true });
  });

  it('does not take another program on 8799 for GenBot', async () => {
    const other = await listen((_req, res) => res.end('{"ok":true}'));
    expect(await harnessAnswers(portMap({ 8799: other }), 8799)).toBe(false);
  });

  it('gives up after its bound with what it saw', async () => {
    let t = 0;
    const live = await waitForGenbot(portMap({}), { timeoutMs: 3000, intervalMs: 1000, now: () => t, sleep: async (ms) => void (t += ms) });
    expect(live).toEqual({ harnessPort: null, botApi: false });
    expect(t).toBe(3000);
  });
});

describe('reading why the harness is down', () => {
  it('sees a harness that crashes at start (as on the GenBot 1.0.4 log)', () => {
    const log = [
      '[2026-11-27T00:28:57.949Z] fork /Applications/GenBot.app/Contents/Resources/server/desktop-entry.mjs port=28799',
      '[2026-11-27T00:28:57.949Z] spawned pid=43239',
      '[2026-11-27T00:28:58.146Z] [err] file:///Applications/GenBot.app/Contents/Resources/server/index.js:32656',
      'Error: Invalid restore recovery paths.',
      '    at readJournal (file:///Applications/GenBot.app/Contents/Resources/server/index.js:32656:499)',
      'Node.js v24.21.0',
      '[2026-11-27T00:28:58.146Z] exited code=1',
      '[2026-11-27T00:28:58.158Z] child on port 28799 exited before answering /api/health',
    ].join('\n');
    expect(diagnoseHarness(log)).toEqual({ kind: 'crash', detail: 'Error: Invalid restore recovery paths.' });
  });

  it('tells a harness still starting from an empty log', () => {
    expect(diagnoseHarness('[t] spawned pid=1\n')).toEqual({ kind: 'starting' });
    expect(diagnoseHarness('')).toEqual({ kind: 'unknown' });
  });
});
