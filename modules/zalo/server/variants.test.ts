import { describe, expect, it } from 'vitest';

import { buildVariantsPrompt, filterVariants, parseVariants } from './variants.js';

describe('parseVariants', () => {
  it('reads a bare JSON array', () => {
    expect(parseVariants('["a", "b"]')).toEqual(['a', 'b']);
  });

  it('reads a fenced block with chatter around it, and brackets inside strings', () => {
    const raw = 'Đây nhé:\n```json\n["Chào {name} [mới]", "Hi {name}"]\n```\nXong.';
    expect(parseVariants(raw)).toEqual(['Chào {name} [mới]', 'Hi {name}']);
  });

  it('accepts {"variants": [...]} and objects with text', () => {
    expect(parseVariants('{"variants": ["x", "y"]}')).toEqual(['x', 'y']);
    expect(parseVariants('[{"text":"x"},{"text":"y"}]')).toEqual(['x', 'y']);
  });

  it('returns [] for garbage', () => {
    expect(parseVariants('xin lỗi, không làm được')).toEqual([]);
  });
});

describe('filterVariants', () => {
  it('drops copies, duplicates and variants that lost a variable', () => {
    const out = filterVariants('Chào {name}, {sale} đây', [
      'Chào {name}, {sale} đây',
      'Hi {name}, mình là {sale}',
      'Hi {name}, mình là {sale}',
      'Hello bạn, mình là {sale}',
      'Alo {NAME}, {sale} nè',
    ], 5);
    expect(out).toEqual(['Hi {name}, mình là {sale}', 'Alo {NAME}, {sale} nè']);
  });

  it('caps at count', () => {
    expect(filterVariants('x', ['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });
});

describe('buildVariantsPrompt', () => {
  it('carries the text, count and extra instructions', () => {
    const p = buildVariantsPrompt({ text: 'Xin chào {name}', count: 3, instructions: 'Giọng trẻ trung' });
    expect(p).toContain('Xin chào {name}');
    expect(p).toContain('3 biến thể');
    expect(p).toContain('Giọng trẻ trung');
  });
});
