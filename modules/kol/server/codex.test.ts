import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _setCodexAuthModeForTests, cleanupThread, codexAccountModels, codexAuthMode } from './codex.js';

let home: string;
const savedHome = process.env.CODEX_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kol-codex-home-'));
  process.env.CODEX_HOME = home;
});

afterEach(() => {
  _setCodexAuthModeForTests(null);
  if (savedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('codex auth mode', () => {
  it('never reads the real login under vitest unless a test opts in', () => {
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
    expect(codexAuthMode()).toBe('none');
    _setCodexAuthModeForTests('chatgpt');
    expect(codexAuthMode()).toBe('chatgpt');
  });
});

describe('codex account models', () => {
  it('lists the visible gpt models of the Codex model cache, in cache order', () => {
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-reserve', visibility: 'hide' }, { slug: 'gpt-6-luna', visibility: 'list' }, { slug: 'codex-auto-review' }, { slug: 'gpt-5.6-luna' }] }));
    expect(codexAccountModels()).toEqual(['gpt-6-luna', 'gpt-5.6-luna']);
  });

  it('answers an empty list when there is no cache', () => {
    expect(codexAccountModels()).toEqual([]);
  });
});

describe('thread cleanup', () => {
  it('removes the thread images and session rollout, and nothing else', () => {
    const id = '01a1581a-d0ef-7931-9baf-5bf84faaed39';
    const other = '01a15820-d502-79a1-b8a9-e39072c400af';
    for (const t of [id, other]) {
      fs.mkdirSync(path.join(home, 'generated_images', t), { recursive: true });
      fs.writeFileSync(path.join(home, 'generated_images', t, 'exec-1.png'), 'x');
    }
    const day = path.join(home, 'sessions', '2026', '10', '20');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, `rollout-2026-10-20T14-06-11-${id}.jsonl`), 'x');
    fs.writeFileSync(path.join(day, `rollout-2026-10-20T14-05-10-${other}.jsonl`), 'x');

    cleanupThread(home, id);

    expect(fs.existsSync(path.join(home, 'generated_images', id))).toBe(false);
    expect(fs.existsSync(path.join(home, 'generated_images', other, 'exec-1.png'))).toBe(true);
    expect(fs.readdirSync(day)).toEqual([`rollout-2026-10-20T14-05-10-${other}.jsonl`]);
  });

  it('ignores a missing or unsafe thread id', () => {
    fs.mkdirSync(path.join(home, 'generated_images', 'keep'), { recursive: true });
    cleanupThread(home, null);
    cleanupThread(home, '../keep');
    expect(fs.existsSync(path.join(home, 'generated_images', 'keep'))).toBe(true);
  });
});
