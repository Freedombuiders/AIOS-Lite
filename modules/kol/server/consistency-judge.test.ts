import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  return { gemini: false, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'kol-judge-route-')) };
});
vi.mock('./config.js', async (orig) => ({ ...(await orig<typeof import('./config.js')>()), STORE_DIR: flags.dir, GOOGLE_API_KEY: '' }));
vi.mock('./providers/gemini.js', async (orig) => ({ ...(await orig<typeof import('./providers/gemini.js')>()), judgeConfigured: () => flags.gemini }));

import fs from 'fs';

import { _initTestDatabase } from './test-db.js';
import { brainAgentId, CHATGPT_BRAIN } from './agent-turn.js';
import { _setCodexAuthModeForTests } from './codex.js';
import { activeJudgeModel, isJudgeRefusal, resolveJudge } from './consistency.js';
import { saveSettings } from './core.js';

beforeEach(() => {
  _initTestDatabase();
  flags.gemini = false;
});
afterEach(() => _setCodexAuthModeForTests(null));
afterAll(() => fs.rmSync(flags.dir, { recursive: true, force: true }));

describe('judge routing', () => {
  it('auto prefers Gemini when a key exists, else ChatGPT when Codex is signed in, else nothing', () => {
    expect(resolveJudge('auto')).toBeNull();
    _setCodexAuthModeForTests('chatgpt');
    expect(resolveJudge('auto')).toEqual({ provider: 'chatgpt', model: 'chatgpt' });
    flags.gemini = true;
    expect(resolveJudge('auto')).toEqual({ provider: 'gemini', model: 'gemini-2.5-flash' });
  });

  it('honours an explicit choice only when that provider is available', () => {
    expect(resolveJudge('chatgpt')).toBeNull();
    expect(resolveJudge('gemini-2.5-flash')).toBeNull();
    _setCodexAuthModeForTests('chatgpt');
    flags.gemini = true;
    expect(resolveJudge('chatgpt')).toEqual({ provider: 'chatgpt', model: 'chatgpt' });
    expect(resolveJudge('gemini-3-flash-preview')).toEqual({ provider: 'gemini', model: 'gemini-3-flash-preview' });
  });

  it('prices estimates with the judge in force', () => {
    _setCodexAuthModeForTests('chatgpt');
    saveSettings({ judgeModel: 'auto' });
    expect(activeJudgeModel()).toBe('chatgpt');
    flags.gemini = true;
    expect(activeJudgeModel()).toBe('gemini-2.5-flash');
  });
});

describe('@chatgpt brain', () => {
  it('needs an enabled agent on the Codex runtime (none while the module is not started)', () => {
    expect(brainAgentId(CHATGPT_BRAIN)).toBeNull();
  });
});

describe('judge refusals', () => {
  it('treats a zero score with "can\'t verify" text as a refusal, not drift', () => {
    expect(isJudgeRefusal({ score: 0, samePerson: false, issues: ['I can’t verify whether two images show the same person.'] })).toBe(true);
    expect(isJudgeRefusal({ score: 0, samePerson: false, issues: ['I cannot help identify people.'] })).toBe(true);
    expect(isJudgeRefusal({ score: 12, samePerson: false, issues: ['mũi to hơn', 'mắt khác màu'] })).toBe(false);
    expect(isJudgeRefusal({ score: 0, samePerson: false, issues: ['khuôn mặt khác hoàn toàn'] })).toBe(false);
    expect(isJudgeRefusal({ score: 95, samePerson: true, issues: [] })).toBe(false);
  });
});

