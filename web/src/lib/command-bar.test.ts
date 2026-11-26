import { describe, expect, it } from 'vitest';
import { composeMessage, commandBarHidden, isTextFile, pickAgent, readAttachment, MAX_ATTACHMENT_CHARS, MAX_MESSAGE_CHARS } from './command-bar';

// The router's default parser, as AppMain gets it from useRouter().
import { useRouter } from 'wouter-preact';
import { renderHook } from './test-hooks';

const parser = renderHook(() => useRouter().parser);

const routes = [
  { path: '/', },
  { path: '/chat', hideCommandBar: true },
  { path: '/chat/:id', hideCommandBar: true },
  { path: '/m/care/inbox/:id', hideCommandBar: true },
  { path: '/tasks/:id' },
];

describe('commandBarHidden', () => {
  it('hides the bar only on routes that declare hideCommandBar', () => {
    expect(commandBarHidden('/chat', routes, parser)).toBe(true);
    expect(commandBarHidden('/chat/12', routes, parser)).toBe(true);
    expect(commandBarHidden('/m/care/inbox/7', routes, parser)).toBe(true);
    expect(commandBarHidden('/', routes, parser)).toBe(false);
    expect(commandBarHidden('/tasks/3', routes, parser)).toBe(false);
  });

  it('shows the bar on a path no route knows', () => {
    expect(commandBarHidden('/nowhere', routes, parser)).toBe(false);
  });

  it('follows the first matching route, like the router', () => {
    const list = [{ path: '/a/:x' }, { path: '/a/b', hideCommandBar: true }];
    expect(commandBarHidden('/a/b', list, parser)).toBe(false);
  });
});

describe('composeMessage', () => {
  it('returns null for nothing to send', () => {
    expect(composeMessage('   ', [])).toBeNull();
  });

  it('sends the typed line as is', () => {
    expect(composeMessage('  Viết bài Tết  ', [])).toBe('Viết bài Tết');
  });

  it('puts each file after the line, under its name', () => {
    const msg = composeMessage('Tóm tắt giúp', [{ name: 'ghi-chu.md', text: 'nội dung', truncated: false }, { name: 'dai.txt', text: 'abc', truncated: true }])!;
    expect(msg.startsWith('Tóm tắt giúp\n\n')).toBe(true);
    expect(msg).toContain('Tệp đính kèm: ghi-chu.md\n```\nnội dung\n```');
    expect(msg).toContain('Tệp đính kèm: dai.txt (đã cắt bớt cho vừa)');
  });

  it('allows a file with no typed line', () => {
    expect(composeMessage('', [{ name: 'a.txt', text: 'x', truncated: false }])).toContain('Xem các tệp đính kèm.');
  });

  it('stays under the chat API content limit', () => {
    const big = { name: 'a.txt', text: 'x'.repeat(MAX_ATTACHMENT_CHARS), truncated: false };
    expect(composeMessage('y'.repeat(MAX_MESSAGE_CHARS), [big, big, big])!.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  });
});

describe('attachments', () => {
  it('accepts plain-text files only', () => {
    expect(isTextFile('a.md')).toBe(true);
    expect(isTextFile('B.CSV')).toBe(true);
    expect(isTextFile('anh.png')).toBe(false);
    expect(isTextFile('hop-dong.pdf')).toBe(false);
  });

  it('reads a text file and cuts a long one', async () => {
    const a = await readAttachment(new File(['xin chào'], 'a.txt', { type: 'text/plain' }));
    expect(a).toEqual({ name: 'a.txt', text: 'xin chào', truncated: false });
    const long = await readAttachment(new File(['z'.repeat(MAX_ATTACHMENT_CHARS + 5)], 'b.txt'));
    expect(long.truncated).toBe(true);
    expect(long.text).toHaveLength(MAX_ATTACHMENT_CHARS);
  });

  it('refuses a file it cannot send, saying why in Vietnamese', async () => {
    await expect(readAttachment(new File(['x'], 'anh.png'))).rejects.toThrow(/Chưa gửi được tệp "anh.png"/);
  });
});

describe('pickAgent', () => {
  const agents = [{ id: 'cskh', enabled: true }, { id: 'main', enabled: true }, { id: 'off', enabled: false }];
  it('keeps the remembered bot while it is still on', () => {
    expect(pickAgent(agents, 'cskh')).toBe('cskh');
  });
  it('drops a remembered bot that is off or gone, preferring "main"', () => {
    expect(pickAgent(agents, 'off')).toBe('main');
    expect(pickAgent(agents, 'gone')).toBe('main');
  });
  it('falls back to the first enabled bot, or none', () => {
    expect(pickAgent([{ id: 'a', enabled: true }], null)).toBe('a');
    expect(pickAgent([{ id: 'a', enabled: false }], null)).toBe('');
    expect(pickAgent([], null)).toBe('');
  });
});
