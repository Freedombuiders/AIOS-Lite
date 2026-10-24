import { describe, expect, it } from 'vitest';
import { BODY_MAX, TITLE_MAX, cannedBody, draftFromCanned, emptyCanned, hasErrors, isValidShortcut, nextSort, normalizeShortcut, sortCanned, validateCanned } from './canned';

const existing = [{ id: 'a', shortcut: 'stk', sort: 10 }, { id: 'b', shortcut: 'camon', sort: 20 }];
const ok = { shortcut: 'nhantien', title: 'Xác nhận đã nhận tiền', body: 'Dạ em đã nhận được ạ.', emailBody: '' };

describe('shortcut validation: [a-z0-9_-]{1,32}', () => {
  it.each(['a', 'nhantien', 'lich-hoc', 'lich_hoc', 'k12', 'a'.repeat(32), '0', '-', '_'])('accepts %s', (s) => expect(isValidShortcut(s)).toBe(true));
  it.each(['', 'a'.repeat(33), 'Nhan', 'nhận', 'a b', 'a/b', '/a', 'a.b', 'a@b', ' a'])('rejects %j', (s) => expect(isValidShortcut(s)).toBe(false));

  it('normalizes a typed slash, capitals and spaces before checking', () => {
    expect(normalizeShortcut(' /NhanTien ')).toBe('nhantien');
    expect(normalizeShortcut('//x')).toBe('x');
    expect(validateCanned({ ...ok, shortcut: '/NhanTien' }, existing)).toEqual({});
  });
});

describe('validateCanned', () => {
  it('accepts a complete reply', () => {
    expect(validateCanned(ok, existing)).toEqual({});
    expect(hasErrors(validateCanned(ok, existing))).toBe(false);
  });

  it('names every problem separately', () => {
    expect(validateCanned(emptyCanned(), existing)).toEqual({ shortcut: 'shortcutRequired', title: 'titleRequired', body: 'bodyRequired' });
    expect(validateCanned({ ...ok, shortcut: 'có dấu' }, existing).shortcut).toBe('shortcutInvalid');
    expect(validateCanned({ ...ok, title: 'x'.repeat(TITLE_MAX + 1) }, existing).title).toBe('titleTooLong');
    expect(validateCanned({ ...ok, body: 'x'.repeat(BODY_MAX + 1) }, existing).body).toBe('bodyTooLong');
    expect(validateCanned({ ...ok, emailBody: 'x'.repeat(BODY_MAX + 1) }, existing).emailBody).toBe('emailBodyTooLong');
    expect(validateCanned({ ...ok, body: '   ' }, existing).body).toBe('bodyRequired');
  });

  it('refuses a shortcut another reply uses, but lets a reply keep its own', () => {
    expect(validateCanned({ ...ok, shortcut: 'stk' }, existing).shortcut).toBe('shortcutTaken');
    expect(validateCanned({ ...ok, shortcut: 'STK' }, existing).shortcut).toBe('shortcutTaken');
    expect(validateCanned({ ...ok, shortcut: 'stk' }, existing, 'a')).toEqual({});
    expect(validateCanned({ ...ok, shortcut: 'stk' }, existing, 'b').shortcut).toBe('shortcutTaken');
  });
});

describe('request body', () => {
  it('trims, normalizes the shortcut and sends an empty email variant as null', () => {
    expect(cannedBody({ shortcut: '/Stk', title: ' Số tài khoản ', body: ' abc ', emailBody: '  ' })).toEqual({ shortcut: 'stk', title: 'Số tài khoản', body: 'abc', emailBody: null });
    expect(cannedBody({ ...ok, emailBody: 'Kính gửi anh/chị,\n...' }, 30)).toMatchObject({ emailBody: 'Kính gửi anh/chị,\n...', sort: 30 });
  });

  it('loads a saved reply into the form and orders the list like the composer menu', () => {
    expect(draftFromCanned({ shortcut: 'stk', title: 't', body: 'b', emailBody: null })).toEqual({ shortcut: 'stk', title: 't', body: 'b', emailBody: '' });
    expect(sortCanned([{ shortcut: 'b', sort: 5 }, { shortcut: 'a', sort: 5 }, { shortcut: 'z', sort: 1 }]).map((c) => c.shortcut)).toEqual(['z', 'a', 'b']);
    expect(nextSort(existing)).toBe(30);
    expect(nextSort([])).toBe(10);
  });
});
