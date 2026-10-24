import { getZaloAccount, getZaloMessages, getZaloThread, upsertZaloThread } from './store.js';
import { resolveGroup, resolveUser, type IngestContext } from './ingest.js';

/** Resolve avatars only for the open conversation, using the shared lookup budgets/cache. */
export async function threadProfiles(ctx: IngestContext, threadId: number) {
  let thread = getZaloThread(threadId);
  if (!thread || thread.account_id !== ctx.accountId) throw new Error('Không tìm thấy hội thoại');
  if (!thread.avatar_url || !thread.name) {
    const profile = thread.thread_type === 'group'
      ? await resolveGroup(ctx, thread.external_id)
      : await resolveUser(ctx, thread.external_id);
    thread = upsertZaloThread({
      accountId: ctx.accountId, threadType: thread.thread_type, externalId: thread.external_id,
      name: profile.name, avatarUrl: profile.avatar,
    });
  }
  const senders: Record<string, { name: string; avatarUrl: string }> = {};
  const account = getZaloAccount(ctx.accountId);
  senders[ctx.ownUid] = { name: account?.display_name || account?.label || '', avatarUrl: account?.avatar_url || '' };
  if (thread.thread_type === 'user') {
    senders[thread.external_id] = { name: thread.name, avatarUrl: thread.avatar_url };
  }
  const uids = [...new Set(getZaloMessages(threadId, { limit: 60 }).map((m) => m.sender_uid).filter(Boolean))];
  // Large groups must not exhaust the nick's query budget on one page load.
  for (const uid of uids.filter((uid) => !senders[uid]).slice(-20)) {
    const profile = await resolveUser(ctx, uid);
    senders[uid] = { name: profile.name, avatarUrl: profile.avatar };
  }
  return { thread: { name: thread.name, avatarUrl: thread.avatar_url }, senders };
}
