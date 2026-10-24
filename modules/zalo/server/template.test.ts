import { describe, expect, it } from 'vitest';

import { buildTemplateVars, renderTemplate, TEMPLATE_VARIABLES, validateTemplate } from './template.js';

/** rng that yields the given values in turn. */
function seq(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

const vars = { name: 'Lan', sale: 'Rocket', gender: 'Chị' };

describe('renderTemplate', () => {
  it('substitutes variables case-insensitively and removes unknown ones', () => {
    const r = renderTemplate({ text: 'Chào {gender} {Name}, từ {sale}{nope}!', styles: [] }, vars);
    expect(r.text).toBe('Chào Chị Lan, từ Rocket!');
  });

  it('picks spintax options, supports nesting and empty options', () => {
    const t = { text: '{Chào|Hi} {a|{b1|b2}}{|!}', styles: [] };
    expect(renderTemplate(t, {}, { rng: seq(0, 0, 0) }).text).toBe('Chào a');
    expect(renderTemplate(t, {}, { rng: seq(0.99, 0.99, 0.99, 0.99) }).text).toBe('Hi b2!');
  });

  it('allows variables inside spintax options', () => {
    const r = renderTemplate({ text: '{Chào {name}|Hi {name}}', styles: [] }, vars, { rng: seq(0.9) });
    expect(r.text).toBe('Hi Lan');
  });

  it('treats {{ and }} as literal braces', () => {
    expect(renderTemplate({ text: 'giá {{100k}} {name}', styles: [] }, vars).text).toBe('giá {100k} Lan');
  });

  it('keeps unbalanced braces as text', () => {
    expect(renderTemplate({ text: 'a } b', styles: [] }, vars).text).toBe('a } b');
    expect(renderTemplate({ text: 'open { never', styles: [] }, vars).text).toBe('open { never');
  });

  it('makes a style over a variable cover its value', () => {
    // "Chào {name}!" with bold over "{name}" (6..12)
    const r = renderTemplate({ text: 'Chào {name}!', styles: [{ st: 'b', start: 5, len: 6 }] }, { name: 'Nguyễn Lan' });
    expect(r.text).toBe('Chào Nguyễn Lan!');
    expect(r.styles).toEqual([{ st: 'b', start: 5, len: 10 }]);
  });

  it('shifts styles after a substitution instead of letting them drift', () => {
    // red over "xong" after a longer value replaced {name}
    const text = 'Hi {name}, xong';
    const start = text.indexOf('xong');
    const r = renderTemplate({ text, styles: [{ st: 'c_db342e', start, len: 4 }] }, { name: 'Nguyễn Văn Lan' });
    expect(r.text.slice(r.styles[0].start, r.styles[0].start + r.styles[0].len)).toBe('xong');
  });

  it('shrinks or drops styles over removed text', () => {
    // bold over an unknown variable disappears; bold over a partly removed span shrinks
    const gone = renderTemplate({ text: 'a {nope} b', styles: [{ st: 'b', start: 2, len: 6 }] }, {});
    expect(gone.text).toBe('a  b');
    expect(gone.styles).toEqual([]);
  });

  it('keeps styles on the chosen spintax option only', () => {
    // "{AAA|BBB}" with bold over the first option and italic over the second
    const content = { text: '{AAA|BBB} end', styles: [{ st: 'b', start: 1, len: 3 }, { st: 'i', start: 5, len: 3 }] };
    const first = renderTemplate(content, {}, { rng: seq(0) });
    expect(first.text).toBe('AAA end');
    expect(first.styles).toEqual([{ st: 'b', start: 0, len: 3 }]);
    const second = renderTemplate(content, {}, { rng: seq(0.9) });
    expect(second.text).toBe('BBB end');
    expect(second.styles).toEqual([{ st: 'i', start: 0, len: 3 }]);
  });

  it('keeps a style that spans a spintax group and the text around it', () => {
    const r = renderTemplate({ text: 'x {A|BB} y', styles: [{ st: 'b', start: 0, len: 10 }] }, {}, { rng: seq(0.9) });
    expect(r.text).toBe('x BB y');
    expect(r.styles).toEqual([{ st: 'b', start: 0, len: 6 }]);
  });

  it('trims leftover whitespace without moving styles', () => {
    const r = renderTemplate({ text: '{gender} {name}', styles: [{ st: 'b', start: 9, len: 6 }] }, { name: 'Lan', gender: '' });
    expect(r.text).toBe('Lan');
    expect(r.styles).toEqual([{ st: 'b', start: 0, len: 3 }]);
  });
});

describe('buildTemplateVars', () => {
  it('builds name parts, group, sale and Vietnamese date/weekday in the target zone', () => {
    // 2026-09-09 18:00 UTC is already 10/09 01:00 in Ho Chi Minh (a Thursday).
    const v = buildTemplateVars({ threadName: 'Nguyễn Thị Lan', threadType: 'user', accountName: 'Rocket', now: new Date('2026-09-09T18:00:00Z') });
    expect(v).toMatchObject({
      name: 'Lan', name_first: 'Nguyễn', name_full: 'Nguyễn Thị Lan', group: '', sale: 'Rocket',
      date: '10/09', weekday: 'Thứ Năm', gender: 'Anh/Chị',
    });
  });

  it('fills {group} for groups, honours gender/timezone and survives a bad timezone', () => {
    const v = buildTemplateVars({ threadName: 'Nhóm VIP', threadType: 'group', accountName: 'R', gender: 'Anh', timezone: 'UTC', now: new Date('2026-09-09T18:00:00Z') });
    expect(v.group).toBe('Nhóm VIP');
    expect(v.gender).toBe('Anh');
    expect(v.date).toBe('09/09');
    expect(() => buildTemplateVars({ threadName: 'A', threadType: 'user', accountName: 'R', timezone: 'Not/AZone' })).not.toThrow();
  });

  it('weekday names cover Chủ Nhật', () => {
    const v = buildTemplateVars({ threadName: 'A', threadType: 'user', accountName: 'R', now: new Date('2026-09-13T05:00:00Z') });
    expect(v.weekday).toBe('Chủ Nhật');
  });
});

describe('validateTemplate', () => {
  it('is quiet for a clean template', () => {
    expect(validateTemplate('{Chào|Hi} {name}, {{ok}}')).toEqual([]);
  });

  it('warns about unbalanced braces, unknown variables and empty options', () => {
    expect(validateTemplate('a { b')).toHaveLength(1);
    expect(validateTemplate('a } b')).toHaveLength(1);
    expect(validateTemplate('{nope}')[0]).toContain('{nope}');
    expect(validateTemplate('{a|}')[0]).toContain('rỗng');
  });

  it('lists every documented variable', () => {
    expect(TEMPLATE_VARIABLES.map((v) => v.name)).toEqual(['name', 'name_full', 'name_first', 'group', 'sale', 'date', 'weekday', 'gender', 'age']);
  });
});
