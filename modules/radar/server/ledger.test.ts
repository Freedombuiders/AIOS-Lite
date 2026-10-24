import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './test-db.js';
import { classifySeen, getPain, isRising, recentPains, recordSeen, resolvePains } from './ledger.js';

beforeEach(() => _initTestDatabase());

const item = (id: string, comments: number) => ({ id, url: `https://x.test/${id}`, title: id, comments });

describe('posts', () => {
  it('rising needs +20% and +10 comments', () => {
    expect(isRising(20, 40)).toBe(true);
    expect(isRising(100, 115)).toBe(false);
    expect(isRising(5, 14)).toBe(false);
  });

  it('new on first sight, stays new on a same-day rerun, rising later', () => {
    expect(classifySeen('nganh', '2026-10-17', [item('a', 20)]).get('a')).toEqual({ isNew: true });
    recordSeen('nganh', '2026-10-17', [item('a', 20)]);
    recordSeen('nganh', '2026-10-17', [item('a', 25)]);
    expect(classifySeen('nganh', '2026-10-17', [item('a', 25)]).get('a')?.isNew).toBe(true);
    expect(classifySeen('vn', '2026-10-18', [item('a', 25)]).get('a')?.isNew).toBe(true); // other layer

    expect(classifySeen('nganh', '2026-10-18', [item('a', 26)]).get('a')).toEqual({ isNew: false });
    expect(classifySeen('nganh', '2026-10-18', [item('a', 60)]).get('a')).toEqual({ isNew: false, rising: { times: 2, prevComments: 25 } });
    recordSeen('nganh', '2026-10-18', [item('a', 60)]);
    recordSeen('nganh', '2026-10-18', [item('a', 90)]); // same-day rerun leaves the baseline alone
    expect(classifySeen('nganh', '2026-10-19', [item('a', 90)]).get('a')).toEqual({ isNew: false, rising: { times: 3, prevComments: 60 } });
  });
});

describe('pains', () => {
  const p = (title: string, matchId?: string) => ({ title, detail: 'd', professions: ['Giáo viên'], topics: [], matchId });

  it('assigns global ids across layers', () => {
    const a = resolvePains('nganh', '2026-10-17', [p('Một'), p('Hai')]);
    const b = resolvePains('vn', '2026-10-17', [p('Ba')]);
    expect([...a, ...b].map((r) => r.id)).toEqual(['P001', 'P002', 'P003']);
    expect(a.every((r) => r.isNew && r.times === 1)).toBe(true);
  });

  it('counts a recurring pain once per report day', () => {
    resolvePains('nganh', '2026-10-17', [p('Một')]);
    const rerun = resolvePains('nganh', '2026-10-17', [p('Khác', 'P001')]);
    expect(rerun[0]).toMatchObject({ id: 'P001', isNew: true, times: 1 });
    const next = resolvePains('nganh', '2026-10-18', [p('Một', 'P001')]);
    expect(next[0]).toMatchObject({ id: 'P001', isNew: false, times: 2, firstSeen: '2026-10-17' });
    const again = resolvePains('nganh', '2026-10-18', [p('Một', 'P001')]);
    expect(again[0].times).toBe(2);
    expect(getPain('P001')?.reportDays).toEqual(['2026-10-17', '2026-10-18']);
  });

  it('reuses a pain restated with the same title on the same day, ignores unknown matchIds', () => {
    resolvePains('nganh', '2026-10-17', [p('Mua ChatGPT cho công ty')]);
    const r = resolvePains('nganh', '2026-10-17', [p('mua chatgpt cho cong ty', 'P099')]);
    expect(r[0].id).toBe('P001');
    expect(resolvePains('nganh', '2026-10-17', [p('Mới', 'P099')])[0].id).toBe('P002');
  });

  it('lists pains of the last 30 days', () => {
    resolvePains('nganh', '2026-08-01', [p('Cũ')]);
    resolvePains('nganh', '2026-10-10', [p('Mới')]);
    expect(recentPains('2026-10-17', 30).map((x) => x.title)).toEqual(['Mới']);
  });
});
