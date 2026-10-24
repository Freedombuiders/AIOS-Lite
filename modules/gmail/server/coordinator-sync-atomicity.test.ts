import { expect, it, vi } from 'vitest';
import { makeContext } from './test-context.js';
import { gmailMessage } from './connectors/email/fake-transport.js';
it('does not move coverage beyond an event rejected by Care and retries it', async () => {
  const h = makeContext();
  try {
    h.transport.deliver(gmailMessage({ sentAtMs: Date.now() - 30_000 }));
    vi.mocked(h.care.careChannels.ingest).mockRejectedValueOnce(new Error('database full'));
    await expect(h.sync.syncAccountNow(h.accountId)).rejects.toThrow('chưa lưu đủ');
    const state = h.sync.connector.store.getMailbox(h.accountId)!;
    expect(state.window).not.toBeNull(); expect(state.coveredSec).toBe(h.store.getEmailAccount(h.accountId)!.care_since);
    expect(await h.sync.syncAccountNow(h.accountId)).toMatchObject({ inserted: 1 });
    expect(h.care.careChannels.ingest).toHaveBeenCalledTimes(2);
  } finally { h.close(); }
});
