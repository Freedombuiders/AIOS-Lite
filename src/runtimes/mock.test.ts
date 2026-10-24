import { describe, expect, it } from 'vitest';
import { createMockRuntime, mockReply } from './mock.js';
import { makeReq, tmpCwd } from './test-util.js';

describe('mockReply', () => {
  it('default output echoes the first line', () => {
    expect(mockReply('\nDòng đầu\nDòng hai')).toEqual({ ok: true, text: 'Đã xử lý: Dòng đầu' });
  });
  it('#delegate emits an aios-task directive', () => {
    const r = mockReply('làm đi #delegate:sales-a');
    expect(r.ok && r.text).toContain('<aios-task to="sales-a" title="Việc demo">Hãy làm phần việc demo.</aios-task>');
  });
  it('#memory and #review', () => {
    const r = mockReply('x #memory:khách thích giao nhanh #review');
    expect(r.ok && r.text).toContain('<aios-memory scope="team">khách thích giao nhanh</aios-memory>');
    const r2 = mockReply('x #review');
    expect(r2.ok && r2.text).toContain('<aios-status>review</aios-status>');
  });
  it('delegates only on a new assignment, not on re-runs', () => {
    const body = '## Việc: Tiêu đề #delegate:x\nlàm đi #delegate:sales-a';
    const fresh = mockReply(`Lý do: bạn được giao một việc mới.\n${body}`);
    expect(fresh.ok && fresh.text).toContain('to="sales-a"');
    const rerun = mockReply(`Lý do: các việc con bạn đã giao đã xong; hãy tổng hợp.\n${body}`);
    expect(rerun.ok && rerun.text).not.toContain('aios-task');
  });
  it('#memory reads the body, up to the next marker', () => {
    const r = mockReply('## Việc: Khách hàng ưu tiên #memory:SAI\nghi nhớ #memory:giao nhanh #review');
    expect(r.ok && r.text).toContain('<aios-memory scope="team">giao nhanh</aios-memory>');
    expect(r.ok && r.text).toContain('<aios-status>review</aios-status>');
  });
  it('#json returns the reply decision', () => {
    const r = mockReply('#json');
    expect(JSON.parse(r.ok ? r.text : '{}')).toEqual({ action: 'reply', text: 'Dạ, em đã nhận được tin nhắn ạ.', reason: 'mock' });
  });
  it('#fail fails', () => {
    expect(mockReply('#fail').ok).toBe(false);
  });
});

describe('mock runtime', () => {
  it('streams text chunks and reports zero cost', async () => {
    const cwd = await tmpCwd();
    const rt = createMockRuntime();
    const req = makeReq(cwd, { prompt: 'một câu khá dài để chia thành nhiều đoạn nhỏ #review', agent: { runtimeOptions: { delayMs: 0 } } });
    const res = await rt.run(req);
    expect(res.ok).toBe(true);
    expect(res.sessionId).toMatch(/^mock-/);
    expect(res.usage?.costUsd).toBe(0);
    const streamed = req.events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
    expect(streamed).toBe(res.output);
    expect(req.events.filter((e) => e.type === 'text').length).toBeGreaterThan(1);
  });
  it('keeps the session id on resume and fails on #fail', async () => {
    const cwd = await tmpCwd();
    const rt = createMockRuntime();
    const ok = await rt.run(makeReq(cwd, { sessionId: 'mock-keep', agent: { runtimeOptions: { delayMs: 0 } } }));
    expect(ok.sessionId).toBe('mock-keep');
    const bad = await rt.run(makeReq(cwd, { prompt: '#fail', agent: { runtimeOptions: { delayMs: 0 } } }));
    expect(bad.ok).toBe(false);
    expect(bad.error?.family).toBe('unknown');
  });
  it('honours the abort signal', async () => {
    const cwd = await tmpCwd();
    const ac = new AbortController();
    const p = createMockRuntime().run(makeReq(cwd, { prompt: 'x'.repeat(2000), signal: ac.signal, agent: { runtimeOptions: { delayMs: 20 } } }));
    setTimeout(() => ac.abort(), 60);
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.error?.family).toBe('cancelled');
  });
});
