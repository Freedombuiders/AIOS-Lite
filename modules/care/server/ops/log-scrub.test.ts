import { describe, expect, it } from 'vitest';
import { createScrubbedLogSink, scrubCareLog, scrubCareLogFields, scrubCareLogString } from './log-scrub.js';

describe('log scrubbing (AC-032)', () => {
  it('drops content, contact and credential fields by name and keeps ids/enums/numbers', () => {
    const out = scrubCareLogFields({
      event: 'job_failed',
      accountId: '0b1f0c3e-1111-4222-8333-444455556666',
      jobType: 'outbox_dispatch',
      attempts: 3,
      text: 'Chao ban, so dien thoai cua toi 0901234567',
      body: 'private',
      subject: 'Re: bao gia',
      to: ['buyer@example.com'],
      phone: '0901234567',
      claimToken: 'abc',
      authorization: 'Bearer abcdefghijklmnop',
      nested: { replay: { text: 'x' }, ok: true, apiKey: 'k' },
    });
    expect(out).toMatchObject({ event: 'job_failed', accountId: '0b1f0c3e-1111-4222-8333-444455556666', jobType: 'outbox_dispatch', attempts: 3 });
    for (const k of ['text', 'body', 'subject', 'to', 'phone', 'claimToken', 'authorization']) expect(out[k]).toBe('[redacted]');
    expect(out.nested).toEqual({ replay: '[redacted]', ok: true, apiKey: '[redacted]' });
  });

  it('pattern-scrubs free text hiding in generic fields (message, error, url)', () => {
    const s = scrubCareLogString(
      'failed for buyer@example.com / +84 901 234 567 with Bearer sk_live_abcdefghijklmnop1234 at https://x.test/cb?token=SECRET123&ok=1 jwt eyJhbGciOiJI.eyJzdWIiOiIx.sig123',
    );
    expect(s).not.toMatch(/buyer@example|901 234|sk_live|SECRET123|eyJhbGci/);
    expect(s).toContain('[email]');
    expect(s).toContain('[phone]');
    expect(s).toContain('ok=1');
  });

  it('keeps UUIDs and uuid-based event ids readable, masks long opaque secrets', () => {
    const id = '0b1f0c3e-1111-4222-8333-444455556666';
    expect(scrubCareLogString(`intent ${id} outbox:${id}:3`)).toBe(`intent ${id} outbox:${id}:3`);
    expect(scrubCareLogString('key=' + 'A'.repeat(40))).not.toContain('AAAA');
    expect(scrubCareLogString('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw')).toBe('[token]');
  });

  it('handles errors, buffers, cycles, depth and size without throwing', () => {
    const err = Object.assign(new Error('boom for a@b.co'), { code: 'RATE_LIMITED', stack: 'STACK a@b.co' });
    const cyc: Record<string, unknown> = { n: 1 };
    cyc.self = cyc;
    const out = scrubCareLog<Record<string, any>>({ err, buf: Buffer.from('secret'), cyc, big: 'x'.repeat(5000), list: Array.from({ length: 200 }, (_, i) => i) });
    expect(out.err).toEqual({ name: 'Error', code: 'RATE_LIMITED', message: 'boom for [email]' });
    expect(JSON.stringify(out)).not.toContain('STACK');
    expect(out.buf).toBe('[binary]');
    expect(out.cyc.self).toBe('[circular]');
    expect(out.big.length).toBeLessThan(600);
    expect(out.list).toHaveLength(51);
  });

  it('a scrubbed sink never writes the raw value', () => {
    const lines: string[] = [];
    const log = createScrubbedLogSink((l) => lines.push(l));
    log('send_failed', { text: 'hello customer', detail: 'user@example.com', accountId: 'a1' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('hello customer');
    expect(lines[0]).not.toContain('user@example.com');
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'send_failed', accountId: 'a1', text: '[redacted]', detail: '[email]' });
  });
});
