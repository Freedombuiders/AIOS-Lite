import { en } from './en';
import { translate } from './index';
import { vi } from './vi';

describe('i18n', () => {
  it('English has exactly the keys Vietnamese has, and none is empty', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(vi).sort());
    for (const [k, v] of [...Object.entries(vi), ...Object.entries(en)]) expect(v.trim()).not.toBe('');
    void 0;
  });

  it('keeps the same {placeholders} in both languages', () => {
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(vi) as (keyof typeof vi)[]) expect(holes(en[key])).toEqual(holes(vi[key]));
  });

  it('fills placeholders', () => {
    expect(translate('vi', 'store.version', { version: '1.2.0' })).toBe('Bản 1.2.0');
    expect(translate('en', 'store.version', { version: '1.2.0' })).toBe('Version 1.2.0');
  });
});
