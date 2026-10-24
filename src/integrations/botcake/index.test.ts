import { afterEach, describe, expect, it, vi } from 'vitest';
import { botcakeIntegration, botcakeRequest } from './index.js';
const values = { page_id: '12345', api_key: 'secret-botcake-key' };
afterEach(() => vi.unstubAllGlobals());
describe('Botcake', () => {
  it('validates credentials with a read-only tag request', async () => {
    const fetch = vi.fn(async () => Response.json({ success: true, data: [] })); vi.stubGlobal('fetch', fetch);
    expect((await botcakeIntegration.test(values)).ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith('https://botcake.io/api/public_api/v1/pages/12345/get_list_tag', expect.objectContaining({ method: 'GET', redirect: 'error', headers: expect.objectContaining({ 'access-token': values.api_key }) }));
  });
  it('treats API-level failure as failure and never exposes token-containing errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: false, message: values.api_key })));
    expect((await botcakeIntegration.test(values)).ok).toBe(false);
    await expect(botcakeRequest(values, 'flows')).rejects.toThrow('Botcake không chấp nhận');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(values.api_key); }));
    expect(JSON.stringify(await botcakeIntegration.test(values))).not.toContain(values.api_key);
  });
  it('rejects injected page IDs before making a request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect((await botcakeIntegration.test({ ...values, page_id: '../../elsewhere' })).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('marks sending as write and makes only one attempt', async () => {
    const command = botcakeIntegration.commands.find(c => c.name === 'flows send')!;
    expect(command.access).toBe('write');
    const fetch = vi.fn(async () => { throw new Error('timeout'); }); vi.stubGlobal('fetch', fetch);
    await expect(command.run({ agentId: 'main', values }, { positionals: ['psid123', '42'], flags: {} })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
