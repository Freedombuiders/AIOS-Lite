import { describe, expect, it } from 'vitest';
import { readBlock, setBlock } from './note-blocks.js';

const FM = '---\nloai: khach-hang\n---\n';

describe('managed blocks', () => {
  it('appends a block after the body with a blank line, then replaces only its content', () => {
    const a = setBlock(`${FM}# Chị Lan\nghi chú tay\n`, 'nhat-ky', '- một');
    expect(a).toBe(`${FM}# Chị Lan\nghi chú tay\n\n<!-- aios:begin nhat-ky -->\n- một\n<!-- aios:end nhat-ky -->\n`);
    const withTail = `${a}\nchủ viết tiếp\n`;
    const b = setBlock(withTail, 'nhat-ky', '- một\n- hai\n');
    expect(b).toBe(`${FM}# Chị Lan\nghi chú tay\n\n<!-- aios:begin nhat-ky -->\n- một\n- hai\n<!-- aios:end nhat-ky -->\n\nchủ viết tiếp\n`);
    expect(readBlock(b, 'nhat-ky')).toBe('- một\n- hai\n');
    expect(readBlock(b, 'khac')).toBeUndefined();
    expect(setBlock(b, 'nhat-ky', '')).toContain('<!-- aios:begin nhat-ky -->\n<!-- aios:end nhat-ky -->');
  });

  it('keeps other blocks, CRLF, and a body without a final newline', () => {
    const two = setBlock(setBlock('x', 'a', '1'), 'b', '2');
    expect(two).toBe('x\n\n<!-- aios:begin a -->\n1\n<!-- aios:end a -->\n\n<!-- aios:begin b -->\n2\n<!-- aios:end b -->\n');
    expect(setBlock(two, 'a', 'mot')).toBe(two.replace('\n1\n', '\nmot\n'));
    const crlf = setBlock('dòng\r\n', 'a', 'x\ny');
    expect(crlf).toBe('dòng\r\n\r\n<!-- aios:begin a -->\r\nx\r\ny\r\n<!-- aios:end a -->\r\n');
    expect(setBlock('', 'a', 'x')).toBe('<!-- aios:begin a -->\nx\n<!-- aios:end a -->\n');
  });

  it('does not look for markers in the frontmatter and refuses broken or duplicated blocks', () => {
    expect(() => setBlock('<!-- aios:begin a -->\nx\n', 'a', 'y')).toThrow(/thiếu dòng kết thúc/);
    expect(() => setBlock('<!-- aios:end a -->\n', 'a', 'y')).toThrow();
    const dup = '<!-- aios:begin a -->\n<!-- aios:end a -->\n<!-- aios:begin a -->\n<!-- aios:end a -->\n';
    expect(() => setBlock(dup, 'a', 'y')).toThrow(/hai lần/);
    expect(() => setBlock('x', 'A B', 'y')).toThrow();
    expect(() => setBlock('x', 'a', 'ok\n<!-- aios:begin b -->')).toThrow();
  });
});
