import { afterEach, describe, expect, it } from 'vitest';
import en from '@/locales/en.json';
import vi from '@/locales/vi.json';
import { setLocale, t } from '@/lib/i18n';

// `ct` itself imports through the `@/` alias, which the root vitest config does not define, so these
// tests check the dictionaries (and `t`, which `ct` delegates to) directly.

function flatten(node: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (typeof node === 'string') {
    out[prefix] = node;
  }
  return out;
}

function placeholders(s: string): string[] {
  return [...new Set(s.match(/\{[A-Za-z0-9_]+\}/g) ?? [])].sort();
}

const enCare = flatten((en as Record<string, unknown>).care);
const viCare = flatten((vi as Record<string, unknown>).care);

describe('care i18n dictionaries', () => {
  it('en and vi carry exactly the same care.* keys', () => {
    expect(Object.keys(viCare).length).toBeGreaterThan(0);
    expect(Object.keys(enCare).sort()).toEqual(Object.keys(viCare).sort());
  });

  it('each key uses the same {placeholders} in en and vi', () => {
    const mismatched = Object.keys(viCare).filter((k) => JSON.stringify(placeholders(enCare[k] ?? '')) !== JSON.stringify(placeholders(viCare[k])));
    expect(mismatched).toEqual([]);
  });

  it('no English string is empty unless the Vietnamese one is intentionally empty', () => {
    const empty = Object.keys(enCare).filter((k) => enCare[k].trim() === '' && viCare[k]?.trim() !== '');
    expect(empty).toEqual([]);
  });
});

describe('care strings by locale', () => {
  afterEach(() => setLocale('en'));

  it('returns different text for en and vi', () => {
    setLocale('en');
    const english = t('care.page.title');
    setLocale('vi');
    const vietnamese = t('care.page.title');
    expect(english).toBe('Shared inbox');
    expect(vietnamese).not.toBe(english);
    expect(vietnamese).not.toBe('care.page.title');
  });

  it('interpolates params in English', () => {
    setLocale('en');
    expect(t('care.counts.total', { n: 3 })).toBe('3 conversations');
  });
});
