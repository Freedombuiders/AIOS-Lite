import { expect, it, vi } from 'vitest';
import { makeContext } from './test-context.js';
import { EmailTransportError } from './connectors/email/transport.js';
it('raises a sanitized attention item for provider failure without leaking mail or tokens', async () => {
  const h = makeContext();
  try {
    h.transport.listFailures.push(new EmailTransportError('ambiguous', 'secret@example.com token=fake-key'));
    await h.sync.poll();
    expect(h.ctx.attention.raise).toHaveBeenCalledWith(expect.objectContaining({ key: `gmail:sync:${h.accountId}`, link: '/m/gmail' }));
    expect(JSON.stringify(vi.mocked(h.ctx.attention.raise).mock.calls)).not.toMatch(/secret@example|fake-key/);
  } finally { h.close(); }
});
