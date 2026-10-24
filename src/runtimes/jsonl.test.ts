import { describe, expect, it } from 'vitest';
import { clip, describeCommand, parseJsonLine } from './jsonl.js';

describe('parseJsonLine', () => {
  it('returns objects and skips noise', () => {
    expect(parseJsonLine('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLine('  {"a":1}  ')).toEqual({ a: 1 });
    expect(parseJsonLine('WARN something')).toBeNull();
    expect(parseJsonLine('{broken')).toBeNull();
    expect(parseJsonLine('[1,2]')).toBeNull();
    expect(parseJsonLine('')).toBeNull();
  });
});

describe('describeCommand', () => {
  it('replaces the prompt and masks secrets', () => {
    const prompt = 'Hãy tóm tắt tài liệu bí mật này';
    const line = describeCommand('grok', ['--single', prompt, '--cwd', '/w'], { promptArgs: [prompt] });
    expect(line).toBe(`grok --single <prompt ${prompt.length} chars> --cwd /w`);
    expect(line).not.toContain('bí mật');
  });

  it('masks -c overrides with secret-looking keys and token-like values', () => {
    const line = describeCommand('codex', ['exec', '-c', 'mcp_servers.x.env.API_KEY="abc"', '-c', 'model="o3"', '--flag', 'sk-ant-abcdefghijklmnopqrstuvwxyz']);
    expect(line).toContain('mcp_servers.x.env.API_KEY=[redacted]');
    expect(line).toContain('model="o3"');
    expect(line).not.toContain('abcdefghijklmnop');
  });
});

describe('clip', () => {
  it('shortens long text', () => {
    expect(clip('abcdef', 3)).toBe('abc…');
    expect(clip('abc', 3)).toBe('abc');
  });
});
