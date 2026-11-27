import { describe, expect, it } from 'vitest';
import { findWebUrl, pairLinkForWeb, watchDevOutput } from './app-run.js';
import { connectSteps, DEFAULT_BOTS, HEADLESS_CONNECT_POSSIBLE } from './connect.js';
import { decideAppStart, decideEnv, decideGenbot, findPairLink, needsLatest, nodeMajor, parseFlags, requiredNodeMajor } from './plan.js';
import { targetFor } from './release.js';

const mac = targetFor('darwin', 'arm64');
const intel = targetFor('darwin', 'x64', false);
const installed = { path: '/Applications/GenBot.app', version: '1.0.3' };

describe('flags', () => {
  it('reads every option and reports unknown ones', () => {
    const { flags, unknown } = parseFlags(['--dry-run', '--resume', '--update-genbot', '--system', '--no-open', '--no-start', '--bogus']);
    expect(flags).toMatchObject({ dryRun: true, resume: true, updateGenbot: true, system: true, open: false, start: false });
    expect(unknown).toEqual(['--bogus']);
    expect(parseFlags([]).flags).toMatchObject({ dryRun: false, open: true, start: true });
  });
});

describe('idempotency decisions', () => {
  it('.env: created once, never overwritten', () => {
    expect(decideEnv(true, true)).toBe('keep');
    expect(decideEnv(false, true)).toBe('create');
    expect(decideEnv(false, false)).toBe('no-example');
  });

  it('GenBot already installed: no network, no reinstall, unless --update-genbot', () => {
    expect(needsLatest(mac, installed, false)).toBe(false);
    expect(decideGenbot(mac, installed, false, null)).toEqual({ action: 'skip', installed });
    expect(needsLatest(mac, installed, true)).toBe(true);
    expect(decideGenbot(mac, installed, true, '1.0.4')).toMatchObject({ action: 'update', latest: '1.0.4' });
    expect(decideGenbot(mac, { ...installed, version: '1.0.4' }, true, '1.0.4')).toMatchObject({ action: 'up-to-date' });
    expect(decideGenbot(mac, { ...installed, version: null }, true, '1.0.4')).toMatchObject({ action: 'update' });
  });

  it('GenBot missing: install the latest', () => {
    expect(needsLatest(mac, null, false)).toBe(true);
    expect(decideGenbot(mac, null, false, '1.0.4')).toEqual({ action: 'install', latest: '1.0.4' });
  });

  it('unsupported machine: never asks GitHub, says why', () => {
    expect(needsLatest(intel, null, true)).toBe(false);
    expect(decideGenbot(intel, null, true, null)).toMatchObject({ action: 'unsupported' });
  });

  it('app start: start, reuse a running AIOS, or stop on a foreign port', () => {
    expect(decideAppStart({ ok: false, isAios: false })).toBe('start');
    expect(decideAppStart({ ok: true, isAios: true })).toBe('already-running');
    expect(decideAppStart({ ok: true, isAios: false })).toBe('port-taken');
  });
});

describe('node version', () => {
  it('reads engines and process versions', () => {
    expect(requiredNodeMajor('>=22')).toBe(22);
    expect(requiredNodeMajor('^24.1.0')).toBe(24);
    expect(requiredNodeMajor(undefined)).toBeNull();
    expect(nodeMajor('v25.9.0')).toBe(25);
  });
});

describe('owner pairing link', () => {
  const printed = [
    '[api] ──────── Đăng nhập chủ AIOS-Lite ────────',
    '[api] Mở liên kết này trong trình duyệt của bạn (dùng một lần, hết hạn sau 60 phút):',
    '[api]   http://127.0.0.1:4380/api/owner/pair?code=ABCD-EFGH-JKLM',
    '[api] Hoặc nhập mã ABCD-EFGH-JKLM ở màn hình "Đăng nhập chủ".',
  ].join('\n');

  it('waits for both the pairing link and the web address, even split across chunks, and fires once', () => {
    expect(findPairLink(printed)).toBe('http://127.0.0.1:4380/api/owner/pair?code=ABCD-EFGH-JKLM');
    const seen: string[][] = [];
    const feed = watchDevOutput((l, w) => seen.push([l, w]));
    const cut = printed.indexOf('pair?co');
    feed(printed.slice(0, cut));
    feed(printed.slice(cut));
    expect(seen).toEqual([]);
    feed('[web]   \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://127.0.0.1:\x1b[1m5174\x1b[22m/\x1b[39m\n');
    feed(printed);
    expect(seen).toEqual([['http://127.0.0.1:4380/api/owner/pair?code=ABCD-EFGH-JKLM', 'http://127.0.0.1:5174']]);
  });

  it('reads the real web port (5173 may be taken)', () => {
    expect(findWebUrl('[web]   ➜  Local:   http://127.0.0.1:5173/')).toBe('http://127.0.0.1:5173');
    expect(findWebUrl('nothing here')).toBeNull();
  });

  it('opens it through the web dev server on 127.0.0.1 (same cookie host, lands on the app)', () => {
    expect(pairLinkForWeb('http://127.0.0.1:4380/api/owner/pair?code=ABCD-EFGH-JKLM')).toBe('http://127.0.0.1:5173/api/owner/pair?code=ABCD-EFGH-JKLM');
    expect(pairLinkForWeb('http://127.0.0.1:4380/api/owner/pair?code=X1', 'http://127.0.0.1:5174')).toBe('http://127.0.0.1:5174/api/owner/pair?code=X1');
  });
});

describe('connect step', () => {
  it('cannot be done without the GenBot window; the click path names every GenBot label and never asks to put a key in .env', () => {
    expect(HEADLESS_CONNECT_POSSIBLE).toBe(false);
    const text = connectSteps('http://127.0.0.1:5173/bots').join('\n');
    for (const label of ['Bot mới', 'Cài đặt', 'Nâng cao', 'Quyền truy cập', 'Bot API', 'Cho ứng dụng trò chuyện với bot này', 'Sao chép', 'Khóa mới', 'Đội AI · Bot', 'Thêm bot GenBot', 'Kiểm tra rồi lưu']) {
      expect(text).toContain(label);
    }
    for (const b of DEFAULT_BOTS) expect(text).toContain(b.name);
    expect(text).toMatch(/Đừng dán khoá vào \.env/);
  });
});
