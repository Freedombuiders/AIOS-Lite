import { describe, expect, it } from 'vitest';
import { loadConfig } from '../core/config.js';
import type { Task } from '../core/types.js';
import { parseDirectives, validateDirectives } from './directives.js';
import { agent } from './test-kit.js';

const config = loadConfig({ rootDir: '/tmp/x', env: {}, loadDotEnv: false });
const boss = agent('boss', { canDelegate: true });
const dev = agent('dev');
const off = agent('off', { enabled: false });
const reg = { get: (id: string) => [boss, dev, off].find((a) => a.id === id) };
const task = (extra: Partial<Task> = {}): Task => ({ id: 1, depth: 0, meta: {} } as Task & {}) && ({ id: 1, depth: 0, meta: {}, ...extra } as Task);
const ctx = (t = task(), a = boss, teamMemory = true) => ({ agent: a, task: t, agents: reg, config, teamMemory });

describe('parseDirectives', () => {
  it('parses all three kinds and cleans the output', () => {
    const p = parseDirectives(
      'Xong rồi.\n<aios-task to="dev" title="Làm A" wait="false">Viết hàm</aios-task>\n<aios-memory scope="team">Khách thích X</aios-memory>\n<aios-status>review</aios-status>\nHết.',
    );
    expect(p.directives).toEqual([
      { kind: 'task', to: 'dev', title: 'Làm A', wait: false, body: 'Viết hàm' },
      { kind: 'memory', scope: 'team', text: 'Khách thích X' },
      { kind: 'status', status: 'review' },
    ]);
    expect(p.cleanOutput).not.toContain('aios-');
    expect(p.cleanOutput).toContain('Xong rồi.');
    expect(p.cleanOutput).toContain('Hết.');
  });

  it('defaults: wait=true, memory scope private', () => {
    const p = parseDirectives('<aios-task to="dev">x</aios-task><aios-memory>y</aios-memory>');
    expect(p.directives[0]).toMatchObject({ wait: true });
    expect(p.directives[1]).toMatchObject({ scope: 'private' });
  });

  it('malformed and nested tags are dropped from output and reported', () => {
    const p = parseDirectives('a <aios-task to="dev">x <aios-task to="boss">y</aios-task></aios-task> b <aios-task>no target</aios-task> <aios-status>done</aios-status> <aios-memory scope="all">z</aios-memory>');
    expect(p.directives).toEqual([]);
    expect(p.malformed.length).toBe(4);
    expect(p.cleanOutput).not.toMatch(/aios-/);
  });

  it('unclosed tags are not directives', () => {
    const p = parseDirectives('<aios-task to="dev">never closed');
    expect(p.directives).toEqual([]);
    expect(p.cleanOutput).not.toMatch(/aios-/);
  });

  it('caps the number of parsed directives (huge counts)', () => {
    const many = Array.from({ length: 5000 }, () => '<aios-task to="dev">x</aios-task>').join('');
    const p = parseDirectives(many);
    expect(p.directives.length).toBeLessThanOrEqual(50);
    expect(p.cleanOutput).toBe('');
  });

  it('case-insensitive tags and single-quoted attributes', () => {
    const p = parseDirectives("<AIOS-TASK to='dev'>x</AIOS-TASK>");
    expect(p.directives).toHaveLength(1);
  });

  it('a directive inside a code fence of the final output still counts (engine only passes final output)', () => {
    const p = parseDirectives('```\n<aios-status>review</aios-status>\n```');
    expect(p.directives).toEqual([{ kind: 'status', status: 'review' }]);
  });

  it('plain text without tags is untouched', () => {
    const p = parseDirectives('  hello <b>world</b>  ');
    expect(p.directives).toEqual([]);
    expect(p.cleanOutput).toBe('hello <b>world</b>');
  });
});

describe('validateDirectives', () => {
  const t = (to = 'dev') => parseDirectives(`<aios-task to="${to}">do it</aios-task>`).directives;

  it('accepts a valid delegation', () => {
    expect(validateDirectives(t(), ctx()).accepted).toHaveLength(1);
  });
  it('rejects when caller cannot delegate', () => {
    expect(validateDirectives(t(), ctx(task(), dev)).rejected[0]!.reason).toMatch(/không được phép/);
  });
  it('rejects unknown, disabled and self targets', () => {
    expect(validateDirectives(t('ghost'), ctx()).rejected[0]!.reason).toMatch(/Không tìm thấy/);
    expect(validateDirectives(t('off'), ctx()).rejected[0]!.reason).toMatch(/đang tắt/);
    expect(validateDirectives(t('boss'), ctx()).rejected[0]!.reason).toMatch(/chính mình/);
  });
  it('enforces depth', () => {
    expect(validateDirectives(t(), ctx(task({ depth: config.maxDelegationDepth }))).accepted).toHaveLength(0);
    expect(validateDirectives(t(), ctx(task({ depth: config.maxDelegationDepth - 1 }))).accepted).toHaveLength(1);
  });
  it('enforces summary rounds', () => {
    expect(validateDirectives(t(), ctx(task({ meta: { round: config.maxSummaryRounds } }))).accepted).toHaveLength(0);
    expect(validateDirectives(t(), ctx(task({ meta: { round: config.maxSummaryRounds - 1 } }))).accepted).toHaveLength(1);
  });
  it('limits children per run', () => {
    const many = parseDirectives(Array.from({ length: 20 }, () => '<aios-task to="dev">x</aios-task>').join('')).directives;
    const r = validateDirectives(many, ctx());
    expect(r.accepted).toHaveLength(config.maxChildrenPerRun);
    expect(r.rejected).toHaveLength(20 - config.maxChildrenPerRun);
  });
  it('team memory needs access.memory.team', () => {
    const m = parseDirectives('<aios-memory scope="team">x</aios-memory><aios-memory scope="private">y</aios-memory>').directives;
    const r = validateDirectives(m, ctx(task(), boss, false));
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected).toHaveLength(1);
  });
  it('status review always passes; empty memory/body rejected', () => {
    const d = parseDirectives('<aios-status>review</aios-status><aios-memory> </aios-memory><aios-task to="dev"> </aios-task>').directives;
    const r = validateDirectives(d, ctx());
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected).toHaveLength(2);
  });
});
