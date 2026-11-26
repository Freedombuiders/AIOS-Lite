import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HANDOFF_KEYWORDS,
  DEFAULT_HANDOFF_PAUSE_MINUTES,
  matchHandoffKeyword,
  parseHandoffKeywords,
  parseHandoffPauseMinutes,
} from './handoff.js';

const kw = DEFAULT_HANDOFF_KEYWORDS;

describe('hard handoff keywords (T06)', () => {
  it('matches with and without accents, in any case', () => {
    expect(matchHandoffKeyword({ text: 'cho tôi gặp nhân viên' }, kw)).toBe('gặp nhân viên');
    expect(matchHandoffKeyword({ text: 'CHO TOI GAP NHAN VIEN' }, kw)).toBe('gặp nhân viên');
    expect(matchHandoffKeyword({ text: 'Cho Gặp Người Thật đi' }, kw)).toBe('gặp người thật');
    expect(matchHandoffKeyword({ text: 'tôi muốn KHIẾU NẠI' }, kw)).toBe('khiếu nại');
    expect(matchHandoffKeyword({ text: 'toi muon khieu nai ve don hang' }, kw)).toBe('khiếu nại');
  });

  it('does not match ordinary questions or a phrase glued inside another word', () => {
    expect(matchHandoffKeyword({ text: 'Cho mình hỏi giá áo này' }, kw)).toBeNull();
    expect(matchHandoffKeyword({ text: 'nhân viên giao hàng tới chưa' }, kw)).toBeNull();
    expect(matchHandoffKeyword({ text: 'xgặp nhân viên' }, kw)).toBeNull();
    expect(matchHandoffKeyword({ text: '' }, kw)).toBeNull();
    expect(matchHandoffKeyword({ text: 'gặp nhân viên' }, [])).toBeNull();
  });

  it('email: the subject and the new text count, quoted history does not', () => {
    expect(matchHandoffKeyword({ text: 'Xin chào', subject: 'Khiếu nại đơn 123', email: true }, kw)).toBe('khiếu nại');
    const quoted = 'Cảm ơn shop.\n\nOn Mon, 1 Jan 2026 at 10:00, Shop <shop@x.vn> wrote:\n> bạn có thể gặp nhân viên tại cửa hàng';
    expect(matchHandoffKeyword({ text: quoted, subject: 'Re: đơn hàng', email: true }, kw)).toBeNull();
  });

  it('settings: comma list, defaults when absent, empty switches the rule off; pause minutes are bounded', () => {
    expect(parseHandoffKeywords(undefined)).toEqual([...kw]);
    expect(parseHandoffKeywords(' gặp  quản lý , hoàn tiền;; hoàn tiền\n')).toEqual(['gặp quản lý', 'hoàn tiền']);
    expect(parseHandoffKeywords('')).toEqual([]);
    expect(parseHandoffPauseMinutes(undefined)).toBe(DEFAULT_HANDOFF_PAUSE_MINUTES);
    expect(parseHandoffPauseMinutes('90')).toBe(90);
    expect(parseHandoffPauseMinutes(0)).toBe(DEFAULT_HANDOFF_PAUSE_MINUTES);
    expect(parseHandoffPauseMinutes(10_000_000)).toBe(7 * 24 * 60);
  });
});
