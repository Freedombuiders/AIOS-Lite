import { describe, expect, it, vi } from 'vitest';

import { falIntegration, higgsfieldIntegration, testFal, testHiggsfield } from './integrations.js';

const respond = (status: number) => vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status }));

describe('fal.ai integration', () => {
  it('is declared under "AI tạo ảnh & video" with a secret key field', () => {
    expect(falIntegration.id).toBe('fal');
    expect(falIntegration.category).toBe('AI tạo ảnh & video');
    expect(falIntegration.fields).toEqual([expect.objectContaining({ key: 'api_key', kind: 'secret', required: true })]);
    expect(falIntegration.setupSteps.length).toBeGreaterThanOrEqual(3);
  });

  it('checks the format, then probes a status read (free) and maps 401/404', async () => {
    expect((await testFal({})).ok).toBe(false);
    const fmt = await testFal({ api_key: 'no-colon-here' });
    expect(fmt.detail).toContain('dấu hai chấm');

    const bad = respond(401);
    const r1 = await testFal({ api_key: 'id:secret' }, undefined, bad);
    expect(r1).toMatchObject({ ok: false });
    expect(r1.detail).toContain('từ chối');
    expect(bad.mock.calls[0][0]).toMatch(/^https:\/\/queue\.fal\.run\/.*\/requests\/.*\/status$/);
    expect((bad.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: 'Key id:secret' });

    const ok = await testFal({ api_key: 'id:secret' }, undefined, respond(404));
    expect(ok).toMatchObject({ ok: true, accountLabel: 'fal.ai' });
    expect(ok.detail).toContain('miễn phí');
    expect(ok.detail).not.toContain('secret');

    const down = await testFal({ api_key: 'id:secret' }, undefined, vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => { throw new Error('ECONNRESET'); }));
    expect(down).toMatchObject({ ok: false });
    expect((await testFal({ api_key: 'id:secret' }, undefined, respond(500))).detail).toContain('500');
  });
});

describe('Higgsfield integration', () => {
  it('is registered with key id + key secret', () => {
    expect(higgsfieldIntegration.id).toBe('higgsfield');
    expect(higgsfieldIntegration.category).toBe('AI tạo ảnh & video');
    expect(higgsfieldIntegration.fields.map((f) => f.key)).toEqual(['key_id', 'key_secret']);
  });

  it('needs both values and maps the probe answer', async () => {
    expect((await testHiggsfield({ key_id: 'a' })).detail).toContain('cả Key ID và Key Secret');
    const bad = respond(401);
    expect((await testHiggsfield({ key_id: 'a', key_secret: 'b' }, undefined, bad)).ok).toBe(false);
    expect(bad.mock.calls[0][0]).toBe('https://api.higgsfield.ai/requests/00000000-0000-4000-8000-000000000000/status');
    expect((bad.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: 'Key a:b' });
    const ok = await testHiggsfield({ key_id: 'a', key_secret: 'b' }, undefined, respond(404));
    expect(ok.ok).toBe(true);
    expect(ok.detail).toContain('chưa công bố giá');
  });
});
