import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, putFbReplyRule } from '../store.js';
import { DEFAULT_REPLY_RULES } from '../types.js';
import {
  dropPostOverrides,
  effectiveRules,
  FAQ_MAX_BYTES,
  loadPageRules,
  loadPostOverrides,
  parseRulePatch,
  readFaqFile,
  readSkillText,
  savePageRules,
  savePostOverrides,
} from './config.js';

describe('parseRulePatch', () => {
  it('accepts a partial valid config and cleans keyword lists', () => {
    const r = parseRulePatch({ minWords: 4, spamKeywords: [' a ', 'a', '', 'b'], sendMode: 'delay' });
    expect(r).toEqual({ ok: true, value: { minWords: 4, spamKeywords: ['a', 'b'], sendMode: 'delay' } });
  });

  it('accepts null for onlyIfNotRepliedHours', () => {
    expect(parseRulePatch({ onlyIfNotRepliedHours: null }).ok).toBe(true);
    expect(parseRulePatch({ onlyIfNotRepliedHours: 24 }).ok).toBe(true);
  });

  it('rejects unknown keys, wrong types and out-of-range values with a Vietnamese message', () => {
    for (const bad of [{ nope: 1 }, { minWords: 'x' }, { maxPerHour: 0 }, { pollMinutes: 1 }, { sendMode: 'now' }, { agentId: '../x' }, 'str', null]) {
      const r = parseRulePatch(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/^Cấu hình không hợp lệ/);
    }
  });
});

describe('rule layering', () => {
  beforeEach(() => _initTestDatabase(':memory:'));

  it('a Page without stored rules uses the defaults', () => {
    expect(loadPageRules('p1')).toEqual(DEFAULT_REPLY_RULES);
    expect(effectiveRules('p1', 'post9')).toEqual(DEFAULT_REPLY_RULES);
    expect(loadPostOverrides('post9')).toBeNull();
  });

  it('page config overrides defaults and post overrides override the page', () => {
    savePageRules('p1', { minWords: 3, maxPerHour: 10 });
    savePostOverrides('p1', 'post9', { minWords: 12 });
    expect(effectiveRules('p1').minWords).toBe(3);
    expect(effectiveRules('p1', 'post9')).toMatchObject({ minWords: 12, maxPerHour: 10 });
    expect(effectiveRules('p1', 'other').minWords).toBe(3);
    expect(loadPostOverrides('post9')).toEqual({ minWords: 12 });
  });

  it('saving merges into what is stored', () => {
    savePageRules('p1', { minWords: 3 });
    savePageRules('p1', { maxPerHour: 5 });
    expect(loadPageRules('p1')).toMatchObject({ minWords: 3, maxPerHour: 5 });
  });

  it('dropping a post override restores inheritance', () => {
    savePostOverrides('p1', 'post9', { minWords: 12 });
    expect(dropPostOverrides('post9')).toBe(true);
    expect(loadPostOverrides('post9')).toBeNull();
    expect(dropPostOverrides('post9')).toBe(false);
  });

  it('one bad stored field does not discard the others', () => {
    putFbReplyRule('page:p1', 'p1', null, JSON.stringify({ minWords: 'many', maxPerHour: 7, bogus: 1 }));
    const r = loadPageRules('p1');
    expect(r.maxPerHour).toBe(7);
    expect(r.minWords).toBe(DEFAULT_REPLY_RULES.minWords);
    putFbReplyRule('page:p2', 'p2', null, '{not json');
    expect(loadPageRules('p2')).toEqual(DEFAULT_REPLY_RULES);
  });
});

describe('readFaqFile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbfaq-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads a text file, relative to the base dir or absolute', () => {
    fs.writeFileSync(path.join(dir, 'faq.md'), 'Học phí: liên hệ');
    expect(readFaqFile(path.join(dir, 'faq.md'))).toBe('Học phí: liên hệ');
    expect(readFaqFile('faq.md', dir)).toBe('Học phí: liên hệ');
  });

  it('truncates to 20 KB', () => {
    fs.writeFileSync(path.join(dir, 'big.txt'), 'a'.repeat(FAQ_MAX_BYTES + 5000));
    expect(readFaqFile(path.join(dir, 'big.txt')).length).toBe(FAQ_MAX_BYTES);
  });

  it('returns empty for missing paths, directories, odd extensions and credential-like names', () => {
    expect(readFaqFile('')).toBe('');
    expect(readFaqFile(path.join(dir, 'missing.md'))).toBe('');
    expect(readFaqFile(dir)).toBe('');
    fs.writeFileSync(path.join(dir, 'tool.sh'), 'echo hi');
    expect(readFaqFile(path.join(dir, 'tool.sh'))).toBe('');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
    expect(readFaqFile(path.join(dir, '.env'))).toBe('');
    fs.writeFileSync(path.join(dir, 'server.pem'), 'x');
    expect(readFaqFile(path.join(dir, 'server.pem'))).toBe('');
    fs.mkdirSync(path.join(dir, '.ssh'));
    fs.writeFileSync(path.join(dir, '.ssh', 'notes.txt'), 'x');
    expect(readFaqFile(path.join(dir, '.ssh', 'notes.txt'))).toBe('');
  });

  it('does not follow a symlink to a credential file', () => {
    fs.writeFileSync(path.join(dir, 'secret.key'), 'k');
    fs.symlinkSync(path.join(dir, 'secret.key'), path.join(dir, 'innocent.md'));
    expect(readFaqFile(path.join(dir, 'innocent.md'))).toBe('');
  });
});

describe('readSkillText', () => {
  it('loads the shipped fb-comment-reply skill without its frontmatter', () => {
    const text = readSkillText('fb-comment-reply');
    expect(text).toContain('Trả lời bình luận Fanpage');
    expect(text.startsWith('---')).toBe(false);
  });

  it('rejects path-like names and unknown skills', () => {
    expect(readSkillText('../../etc/passwd')).toBe('');
    expect(readSkillText('does-not-exist')).toBe('');
  });
});
