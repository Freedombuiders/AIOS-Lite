import { describe, expect, it } from 'vitest';
import { createLineSplitter, runProcess, startProcess } from './process.js';

const node = process.execPath;
const env = { PATH: process.env.PATH ?? '' };
const base = { command: node, cwd: process.cwd(), env };

describe('createLineSplitter', () => {
  it('joins partial chunks, strips CR and flushes the tail', () => {
    const lines: string[] = [];
    const s = createLineSplitter((l) => lines.push(l));
    s.push(Buffer.from('{"a":1}\r\n{"b"'));
    s.push(Buffer.from(':2}\n\nlast'));
    s.end();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', 'last']);
  });

  it('keeps multibyte characters that straddle chunks', () => {
    const lines: string[] = [];
    const s = createLineSplitter((l) => lines.push(l));
    const buf = Buffer.from('Việt Nam\n');
    s.push(buf.subarray(0, 3));
    s.push(buf.subarray(3));
    s.end();
    expect(lines).toEqual(['Việt Nam']);
  });

  it('drops a line longer than the cap but keeps the next ones', () => {
    const lines: string[] = [];
    const s = createLineSplitter((l) => lines.push(l), 10);
    s.push(Buffer.from('x'.repeat(50)));
    s.push(Buffer.from('xxxx\nok\n'));
    s.end();
    expect(lines).toEqual(['ok']);
  });
});

describe('runProcess', () => {
  it('writes stdin and parses stdout lines', async () => {
    const lines: string[] = [];
    const res = await runProcess({ ...base, args: ['-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(s.toUpperCase());console.log("two")})'], stdin: 'hello', onStdoutLine: (l) => lines.push(l) });
    expect(res.exitCode).toBe(0);
    expect(lines).toEqual(['HELLO', 'two']);
  });

  it('reports a missing binary as spawnError', async () => {
    const res = await runProcess({ ...base, command: '/nonexistent/aios-cli', args: [] });
    expect(res.spawnError?.code).toBe('ENOENT');
    expect(res.exitCode).toBeNull();
  });

  it('times out: SIGTERM, then SIGKILL after the grace period', async () => {
    const t0 = Date.now();
    const res = await runProcess({ ...base, args: ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], timeoutMs: 200, graceMs: 300 });
    expect(res.timedOut).toBe(true);
    expect(res.signal).toBe('SIGKILL');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('SIGTERM is enough for a well-behaved child', async () => {
    const res = await runProcess({ ...base, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 150 });
    expect(res.timedOut).toBe(true);
    expect(res.signal).toBe('SIGTERM');
  });

  it('abort signal stops the child and flags aborted', async () => {
    const ac = new AbortController();
    const p = runProcess({ ...base, args: ['-e', 'setInterval(()=>{},1000)'], signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    const res = await p;
    expect(res.aborted).toBe(true);
    expect(res.timedOut).toBe(false);
  });

  it('an already aborted signal kills immediately', async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await runProcess({ ...base, args: ['-e', 'setInterval(()=>{},1000)'], signal: ac.signal });
    expect(res.aborted).toBe(true);
  });

  it('kills the whole process group (grandchildren too)', async () => {
    const lines: string[] = [];
    const script = 'const {spawn}=require("child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(c.pid);setInterval(()=>{},1000)';
    const p = runProcess({ ...base, args: ['-e', script], timeoutMs: 600, graceMs: 200, onStdoutLine: (l) => lines.push(l) });
    const res = await p;
    expect(res.timedOut).toBe(true);
    const pid = Number(lines[0]);
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('keeps only a capped stderr tail', async () => {
    const res = await runProcess({ ...base, args: ['-e', 'process.stderr.write("a".repeat(100000)+"END")'], maxStderrBytes: 1000 });
    expect(res.stderrTail.length).toBe(1000);
    expect(res.stderrTail.endsWith('END')).toBe(true);
  });

  it('survives a child that exits before reading stdin (EPIPE)', async () => {
    const res = await runProcess({ ...base, args: ['-e', 'process.exit(3)'], stdin: 'x'.repeat(1_000_000) });
    expect(res.exitCode).toBe(3);
  });

  it('does not inherit the parent env beyond what is passed', async () => {
    const lines: string[] = [];
    await runProcess({ ...base, env: { ...env, ONLY_ME: '1' }, args: ['-e', 'console.log(Object.keys(process.env).includes("HOME"), process.env.ONLY_ME)'], onStdoutLine: (l) => lines.push(l) });
    expect(lines).toEqual(['false 1']);
  });
});

describe('startProcess', () => {
  it('supports interactive write/endStdin', async () => {
    const lines: string[] = [];
    const h = startProcess({ ...base, args: ['-e', 'process.stdin.on("data",d=>process.stdout.write(d))'], onStdoutLine: (l) => lines.push(l) });
    h.write('one\n');
    await new Promise((r) => setTimeout(r, 150));
    h.endStdin();
    await h.done;
    expect(lines).toEqual(['one']);
  });
});
