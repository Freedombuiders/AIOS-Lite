import { afterEach, describe, expect, it } from 'vitest';
import type { CareReplyPort } from './ports.js';
import type { CareAccountDto, CareConversationDto, CareConversationListDto, CareStatusDto } from './dto.js';
import type { CareNoteDto } from './dto-inbox.js';
import { addMessage } from '../workflow/test-kit.js';
import { T0, makeApi, readStream, seedChat, sseEvents, zaloAccount, type ApiFixture } from './test-helpers.js';

let api: ApiFixture | null = null;
afterEach(() => {
  api?.close();
  api = null;
});

const json = async <T = any>(res: Response): Promise<T> => (await res.json()) as T;
const MIN = 60_000;

function setup(opts: { replyPort?: boolean; canReadSource?: (id: string) => boolean } = {}): { api: ApiFixture } {
  api = makeApi({
    ...(opts.replyPort ? { replyPort: {} as CareReplyPort } : {}),
    ...(opts.canReadSource ? { canReadSource: opts.canReadSource } : {}),
  });
  api.clock.now = T0 + 10 * MIN; // after the seeded messages (T0 + small offsets)
  return { api };
}

describe('GET /status and /accounts (delivery)', () => {
  it('replyEnabled follows the reply port', async () => {
    let s = setup();
    expect((await json<CareStatusDto>(await s.api.get('/api/m/care/status'))).replyEnabled).toBe(false);
    api!.close();
    s = setup({ replyPort: true });
    expect((await json<CareStatusDto>(await s.api.get('/api/m/care/status'))).replyEnabled).toBe(true);
  });

  it('accounts carry delivery: none without a port, core with one', async () => {
    const { api: a } = setup();
    zaloAccount(a.stores, 'DZ');
    const none = (await json<{ items: CareAccountDto[] }>(await a.get('/api/m/care/accounts'))).items[0];
    expect(none.delivery).toEqual({ replyVia: 'none', attachments: false, sendQuota: null });
    expect(none.signature).toBeNull();
    api!.close();

    const { api: b } = setup({ replyPort: true });
    zaloAccount(b.stores, 'CP');
    const res = await b.get('/api/m/care/accounts');
    expect(res.status).toBe(200);
    expect((await json<{ items: CareAccountDto[] }>(res)).items[0].delivery?.replyVia).toBe('core');
  });
});

describe('GET /conversations with wf, view and inboxCounts', () => {
  it('filters by effective status and tab, returns workflow on rows and the single view, validates params', async () => {
    const { api: a } = setup();
    const z = zaloAccount(a.stores);
    const open = seedChat(a.stores, z, 'p:o', 'Open', [{ at: T0 + 1 }]);
    const answered = seedChat(a.stores, z, 'p:a', 'Answered', [{ at: T0 + 1 }, { at: T0 + 2, dir: 'out' }]);
    const ai = seedChat(a.stores, z, 'p:ai', 'AI', [{ at: T0 + 3 }]);

    const all = await json<CareConversationListDto>(await a.get('/api/m/care/conversations'));
    expect(all.items).toHaveLength(3);
    expect(all.items.find((c) => c.id === open.id)?.workflow).toMatchObject({ status: 'open', stateRevision: 0, pendingDrafts: 0 });
    expect(all.inboxCounts).toEqual({ byStatus: { open: 2, pending: 1, snoozed: 0, done: 0 }, byView: { me: 2, ai: 0, none: 3, all: 3 } });

    const pending = await json<CareConversationListDto>(await a.get('/api/m/care/conversations?wf=pending'));
    expect(pending.items.map((c) => c.id)).toEqual([answered.id]);
    const meTab = await json<CareConversationListDto>(await a.get('/api/m/care/conversations?view=me&wf=open'));
    expect(meTab.items.map((c) => c.id).sort()).toEqual([open.id, ai.id].sort());
    const text = await json<CareConversationListDto>(await a.get('/api/m/care/conversations?q=answered'));
    expect(text.inboxCounts).toBeNull();

    const one = await json<CareConversationDto>(await a.get(`/api/m/care/conversations/${ai.id}`));
    expect(one.workflow?.assignee).toEqual({ kind: 'none', agentId: null, source: 'none' });

    expect((await a.get('/api/m/care/conversations?wf=bogus')).status).toBe(400);
    expect((await a.get('/api/m/care/conversations?view=bogus')).status).toBe(400);
  });

  it('snooze expiry uses the API clock, not the wall clock', async () => {
    const { api: a } = setup();
    const c = seedChat(a.stores, zaloAccount(a.stores), 'p:sn', 'S', [{ at: T0 + 1 }]);
    const until = a.clock.now + 30 * MIN;
    expect((await a.send('PUT', `/api/m/care/conversations/${c.id}/workflow`, { action: 'snooze', snoozeUntilMs: until })).status).toBe(200);
    expect((await json<CareConversationListDto>(await a.get('/api/m/care/conversations?wf=snoozed'))).items).toHaveLength(1);
    a.clock.now = until + 1;
    expect((await json<CareConversationListDto>(await a.get('/api/m/care/conversations?wf=snoozed'))).items).toHaveLength(0);
    expect((await json<CareConversationListDto>(await a.get('/api/m/care/conversations?wf=open'))).items).toHaveLength(1);
  });
});

describe('PUT /conversations/:id/workflow|assignee|ai|takeover', () => {
  it('status: done / reopen / snooze return the conversation with the new workflow; stale revision is 409 with currentRevision', async () => {
    const { api: a } = setup();
    const c = seedChat(a.stores, zaloAccount(a.stores), 'p:1', 'C', [{ at: T0 + 1 }]);
    const put = (body: unknown) => a.send('PUT', `/api/m/care/conversations/${c.id}/workflow`, body);

    let res = await put({ action: 'done', expectedStateRevision: 0 });
    expect(res.status).toBe(200);
    expect((await json<CareConversationDto>(res)).workflow).toMatchObject({ status: 'done', stateRevision: 1 });

    res = await put({ action: 'reopen', expectedStateRevision: 0 });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'STALE_REVISION', currentRevision: 1 });

    res = await put({ action: 'snooze', snoozeUntilMs: a.clock.now + MIN, expectedStateRevision: 1 });
    expect((await json<CareConversationDto>(res)).workflow?.status).toBe('snoozed');

    for (const bad of [{ action: 'snooze' }, { action: 'explode' }, { action: 'done', extra: 1 }, { action: 'snooze', snoozeUntilMs: 5 }]) {
      expect((await put(bad)).status).toBe(400);
    }
    expect((await a.send('PUT', '/api/m/care/conversations/nope/workflow', { action: 'done' })).status).toBe(404);
  });

  it('assignee / ai / takeover are stored and validated', async () => {
    const { api: a } = setup();
    const c = seedChat(a.stores, zaloAccount(a.stores), 'p:lg', 'L', [{ at: T0 + 1 }]);
    const url = (p: string) => `/api/m/care/conversations/${c.id}/${p}`;

    let res = await a.send('PUT', url('assignee'), { kind: 'agent', agentId: 'sales' });
    expect(res.status).toBe(200);
    expect((await json<CareConversationDto>(res)).workflow).toMatchObject({ assignee: { kind: 'agent', agentId: 'sales' }, ai: { agentId: 'sales' } });
    res = await a.send('PUT', url('ai'), { mode: 'auto' });
    expect((await json<CareConversationDto>(res)).workflow?.ai.mode).toBe('auto');
    res = await a.send('PUT', url('takeover'), { on: true });
    expect((await json<CareConversationDto>(res)).workflow).toMatchObject({ assignee: { kind: 'owner' }, ai: { takenOver: true } });
    res = await a.send('PUT', url('assignee'), { kind: 'default' });
    expect((await json<CareConversationDto>(res)).workflow?.ai.takenOver).toBe(false);

    expect((await a.send('PUT', url('assignee'), { kind: 'agent' })).status).toBe(400);
    expect((await a.send('PUT', url('ai'), { mode: 'loud' })).status).toBe(400);
    expect((await a.send('PUT', url('takeover'), { on: 'yes' })).status).toBe(400);
  });

  it('unreadable or missing conversations are 404 for every route', async () => {
    const hidden = { id: '' };
    const { api: a } = setup({ canReadSource: (id) => id !== hidden.id });
    const z = zaloAccount(a.stores, 'W');
    const h = zaloAccount(a.stores, 'H');
    hidden.id = h.id;
    const c = seedChat(a.stores, z, 'p:w', 'W', [{ at: T0 + 1 }]);
    const secret = seedChat(a.stores, h, 'p:h', 'H', [{ at: T0 + 1 }]);

    const res = await a.send('PUT', `/api/m/care/conversations/${c.id}/assignee`, { kind: 'owner' });
    expect((await json<CareConversationDto>(res)).workflow).toMatchObject({ assignee: { kind: 'owner' }, ai: { supported: false, note: 'CORE_AI_UNAVAILABLE' } });

    for (const [method, path, body] of [
      ['PUT', 'workflow', { action: 'done' }],
      ['PUT', 'assignee', { kind: 'owner' }],
      ['PUT', 'ai', { mode: 'off' }],
      ['PUT', 'takeover', { on: true }],
      ['GET', 'notes', undefined],
      ['POST', 'notes', { body: 'x', clientRequestId: 'r' }],
    ] as const) {
      expect((await a.send(method, `/api/m/care/conversations/${secret.id}/${path}`, body)).status, `${method} ${path}`).toBe(404);
    }
  });
});

describe('notes and canned routes', () => {
  it('notes: create (idempotent), list oldest first, delete; bad bodies are 400', async () => {
    const { api: a } = setup();
    const c = seedChat(a.stores, zaloAccount(a.stores), 'p:n', 'N', [{ at: T0 + 1 }]);
    const base = `/api/m/care/conversations/${c.id}/notes`;
    const first = await a.send('POST', base, { body: 'Goi lai chieu', clientRequestId: 'cr-1' });
    expect(first.status).toBe(201);
    const n1 = await json<CareNoteDto>(first);
    a.clock.now += 5000;
    const n2 = await json<CareNoteDto>(await a.send('POST', base, { body: 'Da bao gia', clientRequestId: 'cr-2' }));
    expect((await json<CareNoteDto>(await a.send('POST', base, { body: 'Goi lai chieu', clientRequestId: 'cr-1' }))).id).toBe(n1.id);
    expect((await a.send('POST', base, { body: 'different', clientRequestId: 'cr-1' })).status).toBe(409);

    expect((await json<{ items: CareNoteDto[] }>(await a.get(base))).items.map((n) => n.id)).toEqual([n1.id, n2.id]);
    for (const bad of [{ body: '', clientRequestId: 'x' }, { body: 'x'.repeat(4001), clientRequestId: 'x' }, { body: 'ok' }, { body: 'ok', clientRequestId: 'x', extra: 1 }]) {
      expect((await a.send('POST', base, bad)).status).toBe(400);
    }
    expect((await a.send('DELETE', `/api/m/care/notes/${n1.id}`)).status).toBe(200);
    expect((await json<{ items: CareNoteDto[] }>(await a.get(base))).items.map((n) => n.id)).toEqual([n2.id]);
    expect((await a.send('DELETE', `/api/m/care/notes/${n1.id}`)).status).toBe(404);
    expect((await a.send('DELETE', '/api/m/care/notes/missing')).status).toBe(404);
  });

  it('a note on a closed source is 404 to read, write and delete', async () => {
    const hidden = { id: '' };
    const { api: a } = setup({ canReadSource: (id) => id !== hidden.id });
    const h = zaloAccount(a.stores, 'HN');
    const c = seedChat(a.stores, h, 'p:hn', 'H', [{ at: T0 + 1 }]);
    const note = await json<CareNoteDto>(await a.send('POST', `/api/m/care/conversations/${c.id}/notes`, { body: 'private', clientRequestId: 'r' }));
    hidden.id = h.id;
    expect((await a.get(`/api/m/care/conversations/${c.id}/notes`)).status).toBe(404);
    expect((await a.send('DELETE', `/api/m/care/notes/${note.id}`)).status).toBe(404);
  });

  it('canned: CRUD, 409 on a duplicate shortcut, 400 on bad shapes, 404 on unknown ids', async () => {
    const { api: a } = setup();
    const body = { shortcut: 'gia', title: 'Bao gia', body: 'Gia 100k' };
    const created = await a.send('POST', '/api/m/care/canned', body);
    expect(created.status).toBe(201);
    const c1 = await json<any>(created);
    expect(c1).toMatchObject({ shortcut: 'gia', emailBody: null });

    const dup = await a.send('POST', '/api/m/care/canned', { ...body, title: 'again' });
    expect(dup.status).toBe(409);
    expect((await json(dup)).code).toBe('CONFIGURATION_CONFLICT');

    const c2 = await json<any>(await a.send('POST', '/api/m/care/canned', { shortcut: 'ship', title: 'Ship', body: 'Ship nhanh', emailBody: 'Dear customer' }));
    expect((await json<{ items: any[] }>(await a.get('/api/m/care/canned'))).items.map((c) => c.shortcut)).toEqual(['gia', 'ship']);

    const upd = await a.send('PUT', `/api/m/care/canned/${c1.id}`, { ...body, title: 'Gia moi', sort: 5 });
    expect(await json(upd)).toMatchObject({ id: c1.id, title: 'Gia moi', sort: 5 });
    expect((await a.send('PUT', `/api/m/care/canned/${c2.id}`, body)).status).toBe(409); // renaming onto an existing shortcut
    expect((await a.send('PUT', '/api/m/care/canned/missing', body)).status).toBe(404);

    for (const bad of [{ ...body, shortcut: 'Bad Shortcut!' }, { ...body, title: '' }, { ...body, body: 'x'.repeat(4001) }, { ...body, emailBody: 'x'.repeat(20_001) }, { ...body, nope: 1 }]) {
      expect((await a.send('POST', '/api/m/care/canned', bad)).status).toBe(400);
    }
    expect((await a.send('DELETE', `/api/m/care/canned/${c1.id}`)).status).toBe(200);
    expect((await a.send('DELETE', `/api/m/care/canned/${c1.id}`)).status).toBe(404);
    expect((await json<{ items: any[] }>(await a.get('/api/m/care/canned'))).items).toHaveLength(1);
  });

  it('the read gate stops these routes like every other /api/m/care route', async () => {
    const { api: a } = setup();
    a.gate.canRead = false;
    expect((await a.get('/api/m/care/canned')).status).toBe(403);
    expect((await a.send('PUT', '/api/m/care/conversations/x/workflow', { action: 'done' })).status).toBe(403);
  });
});

describe('SSE: a state write reaches the open stream (no text in it)', () => {
  it('PUT workflow and POST notes push conversation.updated for that conversation', async () => {
    const { api: a } = setup();
    const c = seedChat(a.stores, zaloAccount(a.stores), 'p:sse', 'SSE', [{ at: T0 + 1, text: 'CUSTOMER SECRET' }]);
    const res = await a.get('/api/m/care/events');
    const reader = res.body!.getReader();
    await readStream(reader, (t) => t.includes('event: snapshot'));

    await a.send('PUT', `/api/m/care/conversations/${c.id}/workflow`, { action: 'done' });
    await a.send('POST', `/api/m/care/conversations/${c.id}/notes`, { body: 'NOTE SECRET', clientRequestId: 'sse-1' });
    a.handle.hub()!.tick();
    const live = await readStream(reader, (t) => (t.match(/event: care_event/g) ?? []).length >= 2);
    const evs = sseEvents(live.text).filter((e) => e.event === 'care_event');
    expect(evs.map((e) => e.data.type)).toEqual(['conversation.updated', 'conversation.updated']);
    expect(evs.every((e) => e.data.conversationId === c.id)).toBe(true);
    expect(live.text).not.toContain('SECRET');
    await reader.cancel();
  });
});

describe('a customer message after done reopens through the API read path', () => {
  it('GET /conversations/:id flips from done to open', async () => {
    const { api: a } = setup();
    const z = zaloAccount(a.stores);
    const c = seedChat(a.stores, z, 'p:re', 'Re', [{ at: T0 + 1 }]);
    await a.send('PUT', `/api/m/care/conversations/${c.id}/workflow`, { action: 'done' });
    expect((await json<CareConversationDto>(await a.get(`/api/m/care/conversations/${c.id}`))).workflow?.status).toBe('done');
    addMessage(a.stores, z, c.id, 'p:re', 'in', a.clock.now + 1000);
    expect((await json<CareConversationDto>(await a.get(`/api/m/care/conversations/${c.id}`))).workflow?.status).toBe('open');
  });
});
