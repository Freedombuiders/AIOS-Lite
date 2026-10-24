import { afterEach, describe, expect, it } from 'vitest';
import type { CareApiError, CareConversationDto, CareConversationListDto, CareMessagePageDto, CareSearchResultDto, CareTaskDto } from './dto.js';
import { chatMessage } from '../test-fixtures.js';
import { T0, emailAccount, makeApi, seedChat, seedEmail, zaloAccount, type ApiFixture } from './test-helpers.js';

let api: ApiFixture | null = null;
afterEach(() => {
  api?.close();
  api = null;
});

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function pageAll(a: ApiFixture, query: string, limit: number): Promise<{ ids: string[]; pages: CareConversationListDto[] }> {
  const ids: string[] = [];
  const pages: CareConversationListDto[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i += 1) {
    const url: string = `/api/m/care/conversations?limit=${limit}${query ? `&${query}` : ''}${cursor ? `&cursor=${cursor}` : ''}`;
    const body = await json<CareConversationListDto>(await a.get(url));
    pages.push(body);
    ids.push(...body.items.map((c) => c.id));
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  return { ids, pages };
}

describe('GET /status, /accounts', () => {
  it('reports counts and hides credentials/health notes', async () => {
    api = makeApi();
    const z = zaloAccount(api.stores);
    api.stores.accounts.updateAccountFlags(z.id, { healthNote: 'provider said: token=SECRET-NOTE' });
    seedChat(api.stores, z, 'peer:a', 'An', [{ at: T0 + 1 }]);

    const status = await json<any>(await api.get('/api/m/care/status'));
    expect(status).toMatchObject({ ok: true, replyEnabled: false, conversations: { total: 1, waiting: 1, unread: 1 } });
    expect(status.accounts).toEqual({ total: 1, byChannel: { zalo: 1 } });
    expect(status.customerStages).toEqual(['new', 'consulting', 'quoted', 'deposit', 'won', 'lost']);
    expect(status.conversationStatuses).toEqual(['active', 'source_deleted']);

    const accounts = await api.get('/api/m/care/accounts');
    const text = await accounts.text();
    expect(text).not.toContain('SECRET-NOTE');
    expect(text).not.toContain('credentialRef');
    expect(JSON.parse(text).items[0]).toMatchObject({ id: z.id, channel: 'zalo', writeOwner: 'core' });
  });
});

describe('GET /conversations filters and cursors', () => {
  it('filters server-side before paging, with stable counters and no skip/duplicate across equal timestamps', async () => {
    api = makeApi();
    const z = zaloAccount(api.stores, 'Z1');
    const z2 = zaloAccount(api.stores, 'Z2');
    const e = emailAccount(api.stores);
    // Eight zalo conversations, five share ONE last-activity timestamp (tie-break by id).
    for (let i = 0; i < 8; i += 1) {
      const tie = i < 5 ? T0 + 500 : T0 + 100 * i;
      // Even ones are answered (not waiting); odd ones wait.
      const msgs = i % 2 === 0 ? [{ at: tie - 10 }, { at: tie, dir: 'out' as const }] : [{ at: tie }];
      seedChat(api.stores, z, `peer:${i}`, `Khach ${i}`, msgs);
    }
    seedChat(api.stores, z2, 'peer:other', 'Khac tai khoan', [{ at: T0 + 900 }]);
    seedEmail(api.stores, e, 'thread:1', 'Thu 1', [{ at: T0 + 700, subject: 'Bao gia' }]);
    seedEmail(api.stores, e, 'thread:2', 'Thu 2', [{ at: T0 + 710, subject: 'Hoi han' }]);

    // Unfiltered walk with small pages: every conversation exactly once, same counters on every page.
    const all = await pageAll(api, '', 3);
    expect(all.ids).toHaveLength(11);
    expect(new Set(all.ids).size).toBe(11);
    expect(all.pages.every((p) => p.counts?.total === 11)).toBe(true);
    const times = (await json<CareConversationListDto>(await api.get('/api/m/care/conversations?limit=200'))).items.map((c) => c.lastActivityMs);
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    // Channel filter happens before paging: 2 email rows come back as one 2-row page, counters match.
    const email = await json<CareConversationListDto>(await api.get('/api/m/care/conversations?channel=email&limit=1'));
    expect(email.items).toHaveLength(1);
    expect(email.counts).toEqual({ total: 2, waiting: 2, unread: 2 });
    expect(email.nextCursor).not.toBeNull();
    const emailAll = await pageAll(api, 'channel=email', 1);
    expect(emailAll.ids).toHaveLength(2);

    // Account filter
    const acc2 = await json<CareConversationListDto>(await api.get(`/api/m/care/conversations?account=${z2.id}`));
    expect(acc2.items.map((c) => c.title)).toEqual(['Khac tai khoan']);
    expect(acc2.counts?.total).toBe(1);

    // Waiting filter: odd zalo (4) + other (1) + 2 email = 7, spanning pages without gaps
    const waiting = await pageAll(api, 'waiting=1', 2);
    expect(waiting.ids).toHaveLength(7);
    expect(new Set(waiting.ids).size).toBe(7);
    expect(waiting.pages[0].counts).toEqual({ total: 7, waiting: 7, unread: expect.any(Number) });

    const notWaiting = await json<CareConversationListDto>(await api.get('/api/m/care/conversations?waiting=0&limit=200'));
    expect(notWaiting.items).toHaveLength(4);
    expect(notWaiting.items.every((c) => c.waitingSinceMs === null)).toBe(true);

    // Text filter (title metadata, diacritics and case insensitive) is applied before the page is cut
    const q = await json<CareConversationListDto>(await api.get('/api/m/care/conversations?q=KHAC%20TAI&limit=5'));
    expect(q.items.map((c) => c.title)).toEqual(['Khac tai khoan']);
    expect(q.counts).toBeNull();
    expect(q.truncated).toBe(false);

    // Care status
    const conv = api.stores.conversations.getConversationByExternalKey(z.id, 'peer:3')!;
    api.stores.conversations.setStatus(conv.id, 'source_deleted');
    const gone = await json<CareConversationListDto>(await api.get('/api/m/care/conversations?status=source_deleted'));
    api.stores.conversations.setStatus(conv.id, 'archived_elsewhere');
    expect((await json<{ conversationStatuses: string[] }>(await api.get('/api/m/care/status'))).conversationStatuses).toEqual(['active', 'source_deleted', 'archived_elsewhere']);
    api.stores.conversations.setStatus(conv.id, 'source_deleted');
    expect(gone.items.map((c) => c.id)).toEqual([conv.id]);
  });

  it('matches Vietnamese titles without diacritics', async () => {
    api = makeApi();
    const z = zaloAccount(api.stores);
    seedChat(api.stores, z, 'peer:vn', 'Nguyễn Văn Đức', [{ at: T0 }]);
    seedChat(api.stores, z, 'peer:other', 'Someone else', [{ at: T0 + 1 }]);
    const res = await json<CareConversationListDto>(await api.get('/api/m/care/conversations?q=nguyen%20van%20duc'));
    expect(res.items.map((c) => c.title)).toEqual(['Nguyễn Văn Đức']);
  });

  it('keeps the text-filter scan bounded and resumable', async () => {
    api = makeApi();
    const z = zaloAccount(api.stores);
    for (let i = 0; i < 6; i += 1) seedChat(api.stores, z, `peer:${i}`, i === 5 ? 'needle one' : `plain ${i}`, [{ at: T0 + i }]);
    const first = await json<CareConversationListDto>(await api.get('/api/m/care/conversations?q=plain&limit=2'));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await json<CareConversationListDto>(await api.get(`/api/m/care/conversations?q=plain&limit=2&cursor=${first.nextCursor}`));
    const seen = new Set([...first.items, ...second.items].map((c) => c.id));
    expect(seen.size).toBe(4);
  });

  it('answers invalid cursor, unknown channel and unknown account with typed errors', async () => {
    api = makeApi();
    zaloAccount(api.stores);
    const bad = await api.get('/api/m/care/conversations?cursor=%%%');
    expect(bad.status).toBe(400);
    expect((await json<CareApiError>(bad)).code).toBe('INVALID_CURSOR');

    const ch = await api.get('/api/m/care/conversations?channel=whatsapp');
    expect(ch.status).toBe(422);
    expect((await json<CareApiError>(ch)).code).toBe('UNSUPPORTED_CAPABILITY');

    const acc = await api.get('/api/m/care/conversations?account=nope');
    expect(acc.status).toBe(404);
    expect((await json<CareApiError>(acc)).code).toBe('NOT_FOUND');
    expect((await api.get('/api/m/care/conversations?limit=0')).status).toBe(400);
  });
});

describe('GET /conversations/:id/messages', () => {
  it('pages with before, and builds an around window that walks both ways without gaps', async () => {
    api = makeApi();
    const z = zaloAccount(api.stores);
    const msgs = Array.from({ length: 25 }, (_, i) => ({ at: T0 + i * 10, text: `m${i}` }));
    // Three messages share one timestamp to exercise the (sent_at, id) tie-break.
    msgs[10].at = msgs[11].at = msgs[12].at = T0 + 110;
    const conv = seedChat(api.stores, z, 'peer:long', 'Long', msgs);

    const first = await json<CareMessagePageDto>(await api.get(`/api/m/care/conversations/${conv.id}/messages?limit=10`));
    expect(first.items).toHaveLength(10);
    expect(first.newerCursor).toBeNull();
    const walked = [...first.items];
    let cursor = first.olderCursor;
    while (cursor) {
      const page = await json<CareMessagePageDto>(await api.get(`/api/m/care/conversations/${conv.id}/messages?limit=10&before=${cursor}`));
      walked.push(...page.items);
      cursor = page.olderCursor;
    }
    expect(walked).toHaveLength(25);
    expect(new Set(walked.map((m) => m.id)).size).toBe(25);

    // around: the window contains the target; stepping older+newer from it reconstructs everything
    const target = walked[12]; // somewhere in the middle
    const around = await json<CareMessagePageDto>(await api.get(`/api/m/care/conversations/${conv.id}/messages?limit=6&around=${target.id}`));
    expect(around.aroundId).toBe(target.id);
    expect(around.items.map((m) => m.id)).toContain(target.id);
    expect(around.items.length).toBeLessThanOrEqual(7);
    expect(around.olderCursor).not.toBeNull();
    expect(around.newerCursor).not.toBeNull();

    const collected = new Map(around.items.map((m) => [m.id, m]));
    for (let c = around.olderCursor; c; ) {
      const p = await json<CareMessagePageDto>(await api.get(`/api/m/care/conversations/${conv.id}/messages?limit=6&before=${c}`));
      p.items.forEach((m) => collected.set(m.id, m));
      c = p.olderCursor;
    }
    for (let c = around.newerCursor; c; ) {
      const p = await json<CareMessagePageDto>(await api.get(`/api/m/care/conversations/${conv.id}/messages?limit=6&after=${c}`));
      p.items.forEach((m) => collected.set(m.id, m));
      c = p.newerCursor;
    }
    expect(collected.size).toBe(25);
    expect(first.items[0].sentAtMs).toBeGreaterThanOrEqual(first.items[9].sentAtMs);
  });

  it('does not open a message through another conversation and rejects mixed cursors', async () => {
    api = makeApi();
    const z = zaloAccount(api.stores);
    const a = seedChat(api.stores, z, 'peer:a', 'A', [{ at: T0 }]);
    const b = seedChat(api.stores, z, 'peer:b', 'B', [{ at: T0 + 1 }]);
    const bMsg = api.stores.messages.listMessages(b.id)[0];

    const cross = await api.get(`/api/m/care/conversations/${a.id}/messages?around=${bMsg.id}`);
    expect(cross.status).toBe(404);
    expect(await cross.text()).not.toContain(bMsg.text);

    const mixed = await api.get(`/api/m/care/conversations/${a.id}/messages?around=${bMsg.id}&before=abc`);
    expect(mixed.status).toBe(400);
    expect((await api.get('/api/m/care/conversations/missing/messages')).status).toBe(404);
  });

  it('strips the provider raw envelope from message metadata', async () => {
    api = makeApi();
    const z = zaloAccount(api.stores);
    const conv = api.stores.conversations.upsertConversation({ accountId: z.id, externalKey: 'peer:raw', kind: 'direct', title: 'R' });
    api.stores.messages.insertMessage(
      {
        accountId: z.id,
        externalConversationKey: 'peer:raw',
        nativeMessageNamespace: 'zalo_chat',
        nativeMessageId: 'raw-1',
        senderIdentityKey: null,
        senderRole: 'customer',
        direction: 'in',
        origin: 'live',
        sentAtMs: T0,
        nativeVersion: null,
        text: 'hello',
        metadata: { type: 'chat', rawEnvelope: { providerSecret: 'RAW-ENVELOPE-VALUE' } },
      },
      conv.id,
    );
    const text = await (await api.get(`/api/m/care/conversations/${conv.id}/messages`)).text();
    expect(text).toContain('hello');
    expect(text).not.toContain('RAW-ENVELOPE-VALUE');
  });
});

describe('POST /conversations/:id/read', () => {
  it('marks local seen only: waiting and remote unread stay', async () => {
    api = makeApi();
    const z = zaloAccount(api.stores);
    const conv = seedChat(api.stores, z, 'peer:r', 'R', [{ at: T0 }, { at: T0 + 5 }]);
    expect(conv.waitingSinceMs).toBe(T0);
    expect(conv.remoteUnreadCount).toBe(2);

    const before = await json<CareConversationDto>(await api.get(`/api/m/care/conversations/${conv.id}`));
    expect(before.localUnread).toBe(true);

    const res = await api.send('POST', `/api/m/care/conversations/${conv.id}/read`, {});
    expect(res.status).toBe(200);
    const after = await json<CareConversationDto>(res);
    expect(after.localUnread).toBe(false);
    expect(after.localSeenMessageId).toBe(before.lastMessageId);
    expect(after.waitingSinceMs).toBe(T0); // not resolved by reading
    expect(after.remoteUnreadCount).toBe(2); // provider read marker untouched
    expect(after.status).toBe(before.status);

    const stored = api.stores.conversations.getConversation(conv.id)!;
    expect(stored.remoteReadMessageId).toBeNull();

    // A later customer message is unread again
    api.stores.messages.insertMessage(
      chatMessage(z, { externalConversationKey: 'peer:r', nativeMessageId: 'newer', sentAtMs: T0 + 50, text: 'again' }),
      conv.id,
    );
    api.stores.conversations.recomputeProjection(conv.id);
    const again = await json<CareConversationDto>(await api.get(`/api/m/care/conversations/${conv.id}`));
    expect(again.localUnread).toBe(true);
    const unreadFilter = await json<CareConversationListDto>(await api.get('/api/m/care/conversations?unread=1'));
    expect(unreadFilter.items.map((c) => c.id)).toEqual([conv.id]);
  });

  it('refuses a message of another conversation or another account', async () => {
    api = makeApi();
    const z = zaloAccount(api.stores);
    const z2 = zaloAccount(api.stores, 'Z2');
    const a = seedChat(api.stores, z, 'peer:a', 'A', [{ at: T0 }]);
    const b = seedChat(api.stores, z, 'peer:b', 'B', [{ at: T0 + 1 }]);
    const bMsg = api.stores.messages.listMessages(b.id)[0];
    const res = await api.send('POST', `/api/m/care/conversations/${a.id}/read`, { messageId: bMsg.id });
    expect(res.status).toBe(404);
    const wrongAccount = await api.send('POST', `/api/m/care/conversations/${a.id}/read`, { account: z2.id });
    expect(wrongAccount.status).toBe(404);
    expect(api.stores.conversations.getConversation(a.id)!.localSeenMessageId).toBeNull();
  });
});

describe('GET /search', () => {
  it('searches bounded candidates, reports scope/truncated and resumes from nextCursor', async () => {
    api = makeApi();
    const z = zaloAccount(api.stores);
    const msgs = Array.from({ length: 120 }, (_, i) => ({ at: T0 + i, text: i % 40 === 0 ? `Cần báo giá gấp ${i}` : `filler ${i}` }));
    const conv = seedChat(api.stores, z, 'peer:s', 'S', msgs);

    const res = await json<CareSearchResultDto>(await api.get('/api/m/care/search?q=bao%20gia&budget=50&limit=10'));
    expect(res.scope).toMatchObject({ query: 'bao gia', field: 'all', candidateBudget: 50, scannedCandidates: 50, conversationId: null });
    // The newest 50 candidates are i=119..70, so the only matching message in range is i=80.
    expect(res.items.map((h) => h.snippet).join(' ')).toContain('báo giá gấp 80');
    expect(res.truncated).toBe(true);
    expect(res.nextCursor).not.toBeNull();

    const next = await json<CareSearchResultDto>(await api.get(`/api/m/care/search?q=bao%20gia&budget=100&limit=10&cursor=${res.nextCursor}`));
    expect(next.items.map((h) => h.snippet).join(' ')).toContain('báo giá gấp 40');
    expect(next.items.map((h) => h.snippet).join(' ')).toContain('báo giá gấp 0');
    expect(next.truncated).toBe(false);
    expect(next.nextCursor).toBeNull();

    // A hit opens exactly that message
    const hit = res.items[0];
    const opened = await json<CareMessagePageDto>(await api.get(`/api/m/care/conversations/${hit.conversationId}/messages?around=${hit.around}&limit=4`));
    expect(opened.items.map((m) => m.id)).toContain(hit.messageId);
    expect(conv.id).toBe(hit.conversationId);
  });

  it('separates body search from metadata search and honours time range', async () => {
    api = makeApi();
    const e = emailAccount(api.stores);
    seedEmail(api.stores, e, 'thread:q', 'Q', [
      { at: T0 + 10, subject: 'Báo giá lô hàng', text: 'xin chao' },
      { at: T0 + 20, subject: 'Re: khac', text: 'bao gia nhe' },
    ]);
    const meta = await json<CareSearchResultDto>(await api.get('/api/m/care/search?q=lo%20hang&field=metadata'));
    expect(meta.items.map((h) => h.matchedIn)).toEqual(['metadata']);
    const body = await json<CareSearchResultDto>(await api.get('/api/m/care/search?q=lo%20hang&field=body'));
    expect(body.items).toHaveLength(0);
    const ranged = await json<CareSearchResultDto>(await api.get(`/api/m/care/search?q=bao%20gia&from=${T0 + 15}&to=${T0 + 30}`));
    expect(ranged.items.map((h) => h.matchedIn)).toEqual(['body']);
    expect(ranged.scope).toMatchObject({ fromMs: T0 + 15, toMs: T0 + 30 });
  });

  it('is scoped: a conversation through the wrong account is a 404, short queries are rejected', async () => {
    api = makeApi();
    const z = zaloAccount(api.stores);
    const z2 = zaloAccount(api.stores, 'Z2');
    const conv = seedChat(api.stores, z, 'peer:s', 'S', [{ at: T0, text: 'secret phrase' }]);
    const wrong = await api.get(`/api/m/care/search?q=secret&account=${z2.id}&conversation=${conv.id}`);
    expect(wrong.status).toBe(404);
    expect(await wrong.text()).not.toContain('secret phrase');
    const scopedOther = await json<CareSearchResultDto>(await api.get(`/api/m/care/search?q=secret&account=${z2.id}`));
    expect(scopedOther.items).toHaveLength(0);
    expect((await api.get('/api/m/care/search?q=a')).status).toBe(400);
    expect((await api.get('/api/m/care/search')).status).toBe(400);
  });
});

describe('customers and tasks', () => {
  it('lists customers with a text filter and shows detail with identities, conversations and tasks', async () => {
    api = makeApi();
    const z = zaloAccount(api.stores);
    const cust = api.stores.customers.createCustomer({ displayName: 'Trần Thị Bé', phone: '0900 000 111', stage: 'quoted' });
    api.stores.customers.createCustomer({ displayName: 'Other Person' });
    api.stores.identities.createIdentity({ customerId: cust.id, accountId: z.id, namespace: 'zalo_user', externalIdentityId: 'u1', displayName: 'Be', avatarUrl: 'https://example.com/a.png' });
    const conv = seedChat(api.stores, z, 'peer:c', 'Be chat', [{ at: T0 }]);
    api.stores.conversations.setPrimaryCustomer(conv.id, cust.id);
    api.stores.tasks.createTask({ customerId: cust.id, conversationId: conv.id, title: 'Goi lai', dueAtMs: T0 + 1000 });

    const list = await json<any>(await api.get('/api/m/care/customers?q=tran%20thi%20be'));
    expect(list.items.map((c: any) => c.id)).toEqual([cust.id]);
    const byStage = await json<any>(await api.get('/api/m/care/customers?stage=quoted'));
    expect(byStage.items).toHaveLength(1);
    const detail = await json<any>(await api.get(`/api/m/care/customers/${cust.id}`));
    expect(detail.identities).toHaveLength(1);
    expect(detail.identities[0]).not.toHaveProperty('avatarUrl');
    expect(detail.conversations.map((c: any) => c.id)).toEqual([conv.id]);
    expect(detail.tasks.map((t: any) => t.title)).toEqual(['Goi lai']);
    expect((await api.get('/api/m/care/customers/missing')).status).toBe(404);
  });

  it('creates tasks, lists them with filters and answers 409 with currentRevision on a stale PATCH', async () => {
    api = makeApi();
    const z = zaloAccount(api.stores);
    const cust = api.stores.customers.createCustomer({ displayName: 'Khach' });
    const conv = seedChat(api.stores, z, 'peer:t', 'T', [{ at: T0 }]);
    api.stores.conversations.setPrimaryCustomer(conv.id, cust.id);

    const created = await api.send('POST', '/api/m/care/tasks', { customerId: cust.id, conversationId: conv.id, title: 'Bao gia', dueAtMs: T0 + 5000 });
    expect(created.status).toBe(201);
    const task = await json<CareTaskDto>(created);
    expect(task).toMatchObject({ title: 'Bao gia', done: false, revision: 1 });
    await api.send('POST', '/api/m/care/tasks', { customerId: cust.id, title: 'Later', dueAtMs: T0 + 9000 });

    const open = await json<any>(await api.get(`/api/m/care/tasks?customer=${cust.id}&done=0&limit=1`));
    expect(open.items.map((t: CareTaskDto) => t.title)).toEqual(['Bao gia']);
    expect(open.nextCursor).not.toBeNull();
    const rest = await json<any>(await api.get(`/api/m/care/tasks?customer=${cust.id}&limit=1&cursor=${open.nextCursor}`));
    expect(rest.items.map((t: CareTaskDto) => t.title)).toEqual(['Later']);
    const due = await json<any>(await api.get(`/api/m/care/tasks?dueBefore=${T0 + 6000}`));
    expect(due.items).toHaveLength(1);

    const done = await json<CareTaskDto>(await api.send('PATCH', `/api/m/care/tasks/${task.id}`, { expectedRevision: 1, done: true }));
    expect(done).toMatchObject({ done: true, revision: 2 });

    const stale = await api.send('PATCH', `/api/m/care/tasks/${task.id}`, { expectedRevision: 1, done: false });
    expect(stale.status).toBe(409);
    expect(await json<CareApiError>(stale)).toMatchObject({ code: 'STALE_REVISION', currentRevision: 2 });
    expect(api.stores.tasks.getTask(task.id)!.done).toBe(true);

    const same = await json<CareTaskDto>(await api.send('PATCH', `/api/m/care/tasks/${task.id}`, { expectedRevision: 2, done: true }));
    expect(same.revision).toBe(2); // no-op does not churn the revision

    const title = await json<CareTaskDto>(await api.send('PATCH', `/api/m/care/tasks/${task.id}`, { expectedRevision: 2, title: '  Gui bao gia moi ' }));
    expect(title).toMatchObject({ title: 'Gui bao gia moi', revision: 3, done: true });
    const dueEdit = await json<CareTaskDto>(await api.send('PATCH', `/api/m/care/tasks/${task.id}`, { expectedRevision: 3, dueAtMs: T0 + 7777 }));
    expect(dueEdit).toMatchObject({ dueAtMs: T0 + 7777, revision: 4 });
    const owner = await json<CareTaskDto>(await api.send('PATCH', `/api/m/care/tasks/${task.id}`, { expectedRevision: 4, owner: 'Linh' }));
    expect(owner).toMatchObject({ owner: 'Linh', revision: 5 });
    const cleared = await json<CareTaskDto>(await api.send('PATCH', `/api/m/care/tasks/${task.id}`, { expectedRevision: 5, owner: null }));
    expect(cleared).toMatchObject({ owner: null, revision: 6 });
    const multi = await json<CareTaskDto>(await api.send('PATCH', `/api/m/care/tasks/${task.id}`, { expectedRevision: 6, title: 'A', dueAtMs: T0 + 1, done: false }));
    expect(multi).toMatchObject({ title: 'A', dueAtMs: T0 + 1, done: false, revision: 7 }); // one bump for several fields
    const noop = await json<CareTaskDto>(await api.send('PATCH', `/api/m/care/tasks/${task.id}`, { expectedRevision: 7, title: 'A', dueAtMs: T0 + 1 }));
    expect(noop.revision).toBe(7);
    const staleEdit = await api.send('PATCH', `/api/m/care/tasks/${task.id}`, { expectedRevision: 2, title: 'lost update' });
    expect(staleEdit.status).toBe(409);
    expect(await json<CareApiError>(staleEdit)).toMatchObject({ code: 'STALE_REVISION', currentRevision: 7 });
    expect(api.stores.tasks.getTask(task.id)!.title).toBe('A');

    for (const bad of [{ title: '' }, { title: 5 }, { dueAtMs: -1 }, { dueAtMs: 1.5 }, { done: 'yes' }, { unknown: 1 }, {}]) {
      const res = await api.send('PATCH', `/api/m/care/tasks/${task.id}`, { expectedRevision: 7, ...bad });
      expect(res.status).toBe(400);
    }
    expect((await api.send('PATCH', '/api/m/care/tasks/missing', { expectedRevision: 1, done: true })).status).toBe(404);
  });

  it('rejects a task whose conversation belongs to another customer, and malformed bodies', async () => {
    api = makeApi();
    const z = zaloAccount(api.stores);
    const mine = api.stores.customers.createCustomer({ displayName: 'Mine' });
    const other = api.stores.customers.createCustomer({ displayName: 'Other' });
    const conv = seedChat(api.stores, z, 'peer:o', 'O', [{ at: T0 }]);
    api.stores.conversations.setPrimaryCustomer(conv.id, other.id);

    const bad = await api.send('POST', '/api/m/care/tasks', { customerId: mine.id, conversationId: conv.id, title: 't', dueAtMs: 1 });
    expect(bad.status).toBe(400);
    expect((await json<CareApiError>(bad)).code).toBe('INVALID_TARGET');

    expect((await api.send('POST', '/api/m/care/tasks', { customerId: mine.id, title: '', dueAtMs: 1 })).status).toBe(400);
    expect((await api.send('POST', '/api/m/care/tasks', { customerId: mine.id, title: 't', dueAtMs: 1, extra: 1 })).status).toBe(400);
    const raw = await api.app.request('/api/m/care/tasks', { method: 'POST', body: '{not json' });
    expect(raw.status).toBe(400);
    expect((await json<CareApiError>(raw)).code).toBe('INVALID_COMMAND');
    const missing = await api.send('POST', '/api/m/care/tasks', { customerId: 'ghost-customer-id', title: 't', dueAtMs: 1 });
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain('ghost-customer-id');
  });
});

describe('error envelope and gates', () => {
  it('never reflects raw store, provider or SQLite text', async () => {
    api = makeApi();
    const stores = {
      ...api.stores,
      accounts: {
        ...api.stores.accounts,
        listAccounts() {
          throw new Error('provider said: Bearer sk-live-SECRET at /Users/x/claudeclaw.db');
        },
      },
    } as unknown as typeof api.stores;
    const faulty = makeApi({ stores, db: api.db });
    const res = await faulty.get('/api/m/care/accounts');
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal error.' });
    expect(text).not.toContain('sk-live-SECRET');
    expect(faulty.errors).toHaveLength(1); // the original error reaches the log hook only
    expect(String((faulty.errors[0] as Error).message)).toContain('sk-live-SECRET');
    faulty.close();

    // A SQLite failure (missing table) maps to a fixed STORE_UNAVAILABLE
    api.db.exec('DROP TABLE care_tasks');
    const sqlite = await api.get('/api/m/care/tasks');
    expect(sqlite.status).toBe(503);
    const body = await sqlite.text();
    expect(JSON.parse(body).code).toBe('STORE_UNAVAILABLE');
    expect(body).not.toMatch(/no such table|care_tasks/i);
  });

  it('answers cross-account and unknown IDs identically (no existence oracle)', async () => {
    api = makeApi();
    const z = zaloAccount(api.stores);
    const z2 = zaloAccount(api.stores, 'Z2');
    const conv = seedChat(api.stores, z, 'peer:x', 'Secret title', [{ at: T0, text: 'secret body' }]);
    const real = await api.get(`/api/m/care/conversations/${conv.id}?account=${z2.id}`);
    const fake = await api.get(`/api/m/care/conversations/not-a-real-id?account=${z2.id}`);
    expect(real.status).toBe(404);
    expect(fake.status).toBe(404);
    const realText = await real.text();
    expect(realText).toBe(await fake.text());
    expect(realText).not.toContain('Secret title');
    const msgs = await api.get(`/api/m/care/conversations/${conv.id}/messages?account=${z2.id}`);
    expect(msgs.status).toBe(404);
  });

  it('closes every route when the read gate is off, and answers unknown paths with the envelope', async () => {
    api = makeApi();
    zaloAccount(api.stores);
    api.gate.canRead = false;
    for (const path of ['/api/m/care/status', '/api/m/care/accounts', '/api/m/care/conversations', '/api/m/care/events']) {
      const res = await api.get(path);
      expect(res.status).toBe(403);
      expect((await json<CareApiError>(res)).code).toBe('READ_DISABLED');
    }
    expect((await api.send('POST', '/api/m/care/tasks', {})).status).toBe(403);
    api.gate.canRead = true;
    expect((await api.get('/api/m/care/status')).status).toBe(200);
    const unknown = await api.get('/api/m/care/nope');
    expect(unknown.status).toBe(404);
    expect((await json<CareApiError>(unknown)).code).toBe('NOT_FOUND');
  });

  it('fails closed when the gate itself throws, and reports a missing read handle as 503', async () => {
    api = makeApi({
      canRead: () => {
        throw new Error('gate exploded');
      },
    });
    expect((await api.get('/api/m/care/status')).status).toBe(403);

    // A mount without a db handle (e.g. production before the coordinator wires one)
    const bare = makeApi();
    const { Hono } = await import('hono');
    const { registerCareRoutes } = await import('./index.js');
    const app = new Hono();
    registerCareRoutes(app, { stores: bare.stores });
    const res = await app.request('/status');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('READ_MODEL_UNAVAILABLE');
    bare.close();
  });
});
