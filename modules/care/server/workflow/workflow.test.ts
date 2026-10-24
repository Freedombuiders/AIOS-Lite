import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors.js';
import { CareReadModel, LIMITS } from '../api/read-model.js';
import { encryptCareField } from '../persistence/crypto.js';
import { createTestCareDatabase, type CareStores } from '../persistence/index.js';
import { TEST_KEY, createEligibleAccount } from '../test-fixtures.js';
import { T0, seedChat } from '../api/test-helpers.js';
import { createCareWorkflowService } from './index.js';
import { addMessage } from './test-kit.js';
import type { CareConversationDto } from '../api/dto.js';
import type { CareWorkflowService } from './contract.js';

const MIN = 60_000;

interface Fx {
  stores: CareStores;
  db: ReturnType<typeof createTestCareDatabase>['rawDbForTestIsolationOnly'];
  model: CareReadModel;
  svc: CareWorkflowService;
  clock: { now: number };
  gate: { closed: Set<string> };
  close(): void;
}

let fx: Fx | null = null;
afterEach(() => {
  fx?.close();
  fx = null;
});

function make(): Fx {
  const t = createTestCareDatabase(':memory:', TEST_KEY);
  const clock = { now: T0 + 10 * MIN };
  const gate = { closed: new Set<string>() };
  const model = new CareReadModel(t.rawDbForTestIsolationOnly, t.stores, (id) => !gate.closed.has(id));
  const svc = createCareWorkflowService({
    db: t.rawDbForTestIsolationOnly,
    stores: t.stores,
    model,
    now: () => clock.now,
    canReadSource: (id) => !gate.closed.has(id),
  });
  return { stores: t.stores, db: t.rawDbForTestIsolationOnly, model, svc, clock, gate, close: t.close };
}

const zalo = (f: Fx, label = 'Z') => createEligibleAccount(f.stores, { channel: 'zalo', label, nativeAccountId: `z-${label}` });
const second = (f: Fx) => createEligibleAccount(f.stores, { channel: 'zalo', nativeAccountId: 'z-second', label: 'Second' });
const wfOf = (f: Fx, id: string) => f.model.getConversationDto(id)!.workflow!;
const list = (f: Fx, q: Parameters<CareReadModel['listConversations']>[0]) => f.model.listConversations(q, undefined, 200);
const ids = (r: { items: CareConversationDto[] }) => r.items.map((i) => i.id).sort();
const err = (fn: () => unknown): ApiError => {
  try {
    fn();
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('expected a throw');
};

describe('effective status (plan section 3)', () => {
  it('waiting = open, answered = pending, with the SQL filter and the JS value agreeing', () => {
    fx = make();
    const a = zalo(fx);
    const waiting = seedChat(fx.stores, a, 'p:w', 'W', [{ at: T0 + 1 }]);
    const answered = seedChat(fx.stores, a, 'p:a', 'A', [{ at: T0 + 1 }, { at: T0 + 2, dir: 'out' }]);
    expect(wfOf(fx, waiting.id).status).toBe('open');
    expect(wfOf(fx, answered.id).status).toBe('pending');
    expect(ids(list(fx, { wf: 'open' }))).toEqual([waiting.id]);
    expect(ids(list(fx, { wf: 'pending' }))).toEqual([answered.id]);
    expect(list(fx, {}).inboxCounts?.byStatus).toEqual({ open: 1, pending: 1, snoozed: 0, done: 0 });
  });

  it('done sticks while no new customer message arrives; any later customer message reopens, even on top of an older waiting one', () => {
    fx = make();
    const a = zalo(fx);
    const c = seedChat(fx.stores, a, 'p:1', 'C', [{ at: T0 + 1 }]); // waiting since T0+1
    fx.svc.setStatus(c.id, { action: 'done' });
    expect(wfOf(fx, c.id)).toMatchObject({ status: 'done', changedAtMs: fx.clock.now, stateRevision: 1 });
    expect(ids(list(fx, { wf: 'done' }))).toEqual([c.id]);
    expect(ids(list(fx, { wf: 'open' }))).toEqual([]);

    // The customer writes again: waiting_since stays at the OLDEST unanswered message, the newest one still reopens.
    addMessage(fx.stores, a, c.id, 'p:1', 'in', fx.clock.now + 5);
    expect(wfOf(fx, c.id).status).toBe('open');
    expect(ids(list(fx, { wf: 'open' }))).toEqual([c.id]);
    expect(ids(list(fx, { wf: 'done' }))).toEqual([]);

    // Done again, then OUR reply (waiting cleared): stays done, no reopen.
    fx.clock.now += 100;
    fx.svc.setStatus(c.id, { action: 'done' });
    addMessage(fx.stores, a, c.id, 'p:1', 'out', fx.clock.now + 1);
    expect(wfOf(fx, c.id).status).toBe('done');
    // A customer message after an answered+done conversation: waiting_since > changed_at.
    addMessage(fx.stores, a, c.id, 'p:1', 'in', fx.clock.now + 50);
    expect(wfOf(fx, c.id).status).toBe('open');
  });

  it('snooze: snoozed until the time passes, then open; a customer message during the snooze reopens at once', () => {
    fx = make();
    const a = zalo(fx);
    const c = seedChat(fx.stores, a, 'p:s', 'S', [{ at: T0 + 1 }]);
    const until = fx.clock.now + 60 * MIN;
    fx.svc.setStatus(c.id, { action: 'snooze', snoozeUntilMs: until });
    expect(wfOf(fx, c.id)).toMatchObject({ status: 'snoozed', snoozedUntilMs: until });
    expect(ids(list(fx, { wf: 'snoozed' }))).toEqual([c.id]);
    expect(list(fx, {}).inboxCounts?.byStatus.snoozed).toBe(1);

    fx.clock.now = until + 1; // expiry reopens (the waiting customer is still unanswered)
    expect(wfOf(fx, c.id)).toMatchObject({ status: 'open', snoozedUntilMs: null });
    expect(ids(list(fx, { wf: 'snoozed' }))).toEqual([]);
    expect(ids(list(fx, { wf: 'open' }))).toEqual([c.id]);

    fx.clock.now = until - 30 * MIN; // back inside the snooze window: snoozed again
    expect(wfOf(fx, c.id).status).toBe('snoozed');
    addMessage(fx.stores, a, c.id, 'p:s', 'in', fx.clock.now + 10);
    expect(wfOf(fx, c.id).status).toBe('open');
  });

  it('reopen clears done/snooze; pending after done reopens only on a customer message', () => {
    fx = make();
    const a = zalo(fx);
    const c = seedChat(fx.stores, a, 'p:r', 'R', [{ at: T0 + 1 }, { at: T0 + 2, dir: 'out' }]); // answered: pending
    fx.svc.setStatus(c.id, { action: 'done' });
    expect(wfOf(fx, c.id).status).toBe('done');
    fx.svc.setStatus(c.id, { action: 'reopen' });
    expect(wfOf(fx, c.id)).toMatchObject({ status: 'pending', stateRevision: 2 });
    fx.svc.setStatus(c.id, { action: 'snooze', snoozeUntilMs: fx.clock.now + MIN });
    fx.svc.setStatus(c.id, { action: 'reopen' });
    expect(wfOf(fx, c.id).status).toBe('pending');
  });

  it('rejects a snooze in the past, past a year, or without a time', () => {
    fx = make();
    const c = seedChat(fx.stores, zalo(fx), 'p:v', 'V', [{ at: T0 + 1 }]);
    for (const until of [undefined, fx.clock.now, fx.clock.now - 1, fx.clock.now + 400 * 86_400_000]) {
      expect(err(() => fx!.svc.setStatus(c.id, { action: 'snooze', snoozeUntilMs: until })).code).toBe('INVALID_COMMAND');
    }
    expect(fx.model.getConversationDto(c.id)!.workflow!.stateRevision).toBe(0);
  });

  it('expectedStateRevision mismatch is a 409 STALE_REVISION carrying currentRevision; the right one passes', () => {
    fx = make();
    const c = seedChat(fx.stores, zalo(fx), 'p:e', 'E', [{ at: T0 + 1 }]);
    fx.svc.setStatus(c.id, { action: 'done', expectedStateRevision: 0 });
    const e = err(() => fx!.svc.setStatus(c.id, { action: 'reopen', expectedStateRevision: 0 }));
    expect(e).toMatchObject({ code: 'STALE_REVISION', status: 409, extra: { currentRevision: 1 } });
    expect(fx.svc.setStatus(c.id, { action: 'reopen', expectedStateRevision: 1 }).workflow?.stateRevision).toBe(2);
  });

  it('the projector rewriting the conversation row does not touch the state (separate table)', () => {
    fx = make();
    const a = zalo(fx);
    const c = seedChat(fx.stores, a, 'p:b', 'B', [{ at: T0 + 1 }]);
    fx.svc.setStatus(c.id, { action: 'done' });
    fx.stores.conversations.setStatus(c.id, 'source_deleted');
    expect(wfOf(fx, c.id).status).toBe('done');
  });
});

describe('waiting() and viewCounts()', () => {
  it('lists effective-open conversations that waited long enough, oldest first, skipping done/snoozed/answered', () => {
    fx = make();
    const a = zalo(fx);
    const old = seedChat(fx.stores, a, 'p:old', 'Old', [{ at: T0 + 1 * MIN }]);
    const mid = seedChat(fx.stores, a, 'p:mid', 'Mid', [{ at: T0 + 4 * MIN }]);
    seedChat(fx.stores, a, 'p:new', 'New', [{ at: T0 + 9 * MIN }]); // waited 1 min only
    const done = seedChat(fx.stores, a, 'p:done', 'Done', [{ at: T0 + 2 * MIN }]);
    seedChat(fx.stores, a, 'p:ans', 'Ans', [{ at: T0 + 1 * MIN }, { at: T0 + 2 * MIN, dir: 'out' }]);
    fx.svc.setStatus(done.id, { action: 'done' });
    const out = fx.svc.waiting({ minWaitMs: 5 * MIN, now: fx.clock.now, limit: 10 });
    expect(out.map((w) => w.conversation.id)).toEqual([old.id, mid.id]);
    expect(out[0].waitingSinceMs).toBe(T0 + 1 * MIN);
    expect(out[0].conversation.workflow?.status).toBe('open');
    expect(fx.svc.waiting({ minWaitMs: 5 * MIN, now: fx.clock.now, limit: 1 })).toHaveLength(1);
  });

  it('counts tabs and statuses over every readable conversation (closed sources excluded)', () => {
    fx = make();
    const a = zalo(fx, 'A');
    const hidden = zalo(fx, 'H');
    seedChat(fx.stores, a, 'p:1', 'one', [{ at: T0 + 1 }]);
    seedChat(fx.stores, a, 'p:2', 'two', [{ at: T0 + 1 }, { at: T0 + 2, dir: 'out' }]);
    seedChat(fx.stores, hidden, 'p:h', 'hid', [{ at: T0 + 1 }]);
    fx.gate.closed.add(hidden.id);
    const c = fx.svc.viewCounts();
    expect(c.all).toBe(2);
    expect(c.byStatus).toEqual({ open: 1, pending: 1, snoozed: 0, done: 0 });
    expect(c.me).toBe(1); // only the open one needs the owner
    expect(c.none).toBe(2); // core accounts have no AI: nobody handles either
  });
});

describe('view classification (me / ai / none / all)', () => {
  it('applies the plan rules and counts them per scope', () => {
    fx = make();
    const a = zalo(fx, 'L');
    const W = [{ at: T0 + 1 }];
    const waiting = seedChat(fx.stores, a, 'waiting', 'waiting', W).id;
    const owner = seedChat(fx.stores, a, 'owner', 'owner', W).id;
    fx.svc.setTakeover(owner, true);
    const answered = seedChat(fx.stores, a, 'answered', 'answered', [{ at: T0 + 1 }, { at: T0 + 2, dir: 'out' }]).id;

    const byView = (view: 'me' | 'ai' | 'none' | 'all') => ids(list(fx!, { view }));
    expect(byView('ai')).toEqual([]); // no AI runtime is wired to the inbox state
    expect(byView('me')).toEqual([waiting, owner].sort());
    expect(byView('none')).toEqual([waiting, answered].sort());
    expect(byView('all')).toHaveLength(3);

    const counts = list(fx, {}).inboxCounts!;
    expect(counts.byView).toEqual({ me: 2, ai: 0, none: 2, all: 3 });
    const meList = list(fx, { view: 'me' });
    expect(meList.inboxCounts!.byStatus).toEqual({ open: 2, pending: 0, snoozed: 0, done: 0 });
    expect(meList.counts).toEqual({ total: 2, waiting: 2, unread: 2 });
    expect(meList.truncated).toBe(false);
  });

  it('byView follows the status filter and byStatus follows the view', () => {
    fx = make();
    const a = zalo(fx);
    const open = seedChat(fx.stores, a, 'p:o', 'o', [{ at: T0 + 1 }]);
    const done = seedChat(fx.stores, a, 'p:d', 'd', [{ at: T0 + 2 }]);
    fx.svc.setStatus(done.id, { action: 'done' });
    const openOnly = list(fx, { wf: 'open' });
    expect(ids(openOnly)).toEqual([open.id]);
    expect(openOnly.inboxCounts!.byView).toEqual({ me: 1, ai: 0, none: 1, all: 1 });
    expect(openOnly.inboxCounts!.byStatus).toEqual({ open: 1, pending: 0, snoozed: 0, done: 1 }); // not narrowed by wf
    const doneMe = list(fx, { wf: 'done', view: 'me' });
    expect(ids(doneMe)).toEqual([]); // done is not open, so it is not "needs me"
    expect(doneMe.inboxCounts!.byStatus).toEqual({ open: 1, pending: 0, snoozed: 0, done: 0 });
  });

  it('pages a tab list in memory with the usual cursor; no row skipped or repeated', () => {
    fx = make();
    const a = zalo(fx);
    const made: string[] = [];
    for (let i = 0; i < 7; i += 1) made.push(seedChat(fx.stores, a, `p:${i}`, `t${i}`, [{ at: T0 + 100 + i }]).id);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const r = fx.model.listConversations({ view: 'me' }, cursor, 3);
      seen.push(...r.items.map((x) => x.id));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    expect(seen).toEqual([...made].reverse());
  });

  it('a tab scan stops at the scan budget and says so (truncated); the plain counters stay exact SQL', () => {
    fx = make();
    const a = zalo(fx);
    const title = encryptCareField('x', TEST_KEY);
    const insert = fx.db.prepare(
      `INSERT INTO care_conversations (id, account_id, external_key, kind, title_enc, status, waiting_since, last_message_at, revision, created_at, updated_at)
       VALUES (?, ?, ?, 'direct', ?, 'active', ?, ?, 1, 1, 1)`,
    );
    const total = LIMITS.conversationScan + 5;
    fx.db.transaction(() => {
      for (let i = 0; i < total; i += 1) insert.run(`bulk-${String(i).padStart(5, '0')}`, a.id, `k${i}`, title, 1000 + i, 1000 + i);
    })();

    const seen = new Set<string>();
    let cursor: string | undefined;
    let first: ReturnType<CareReadModel['listConversations']> | null = null;
    for (let i = 0; i < 20; i += 1) {
      const r = fx.model.listConversations({ view: 'me' }, cursor, 200);
      first ??= r;
      for (const it of r.items) seen.add(it.id);
      expect(r.truncated).toBe(true);
      cursor = r.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(first!.items).toHaveLength(200);
    expect(seen.size).toBe(LIMITS.conversationScan); // the window, newest first: the 5 oldest are out of reach
    expect(seen.has('bulk-00000')).toBe(false);
    expect(first!.inboxCounts!.byView.me).toBe(LIMITS.conversationScan);

    const sql = fx.model.listConversations({}, undefined, 10);
    expect(sql.truncated).toBe(false);
    expect(sql.counts?.total).toBe(total);
    expect(sql.inboxCounts!.byStatus.open).toBe(total); // exact, not capped
    expect(sql.inboxCounts!.byView.all).toBe(total);
    expect(sql.inboxCounts!.byView.me).toBe(LIMITS.conversationScan); // classified window
  });
});

describe('assignee validation', () => {
  it('an agent assignment needs a valid agentId', () => {
    fx = make();
    const c = seedChat(fx.stores, zalo(fx, 'LG'), 'p:lg', 'LG', [{ at: T0 + 1 }]);
    expect(err(() => fx!.svc.setAssignee(c.id, { kind: 'agent' })).code).toBe('INVALID_COMMAND');
    expect(err(() => fx!.svc.setAssignee(c.id, { kind: 'agent', agentId: 'bad id!' })).code).toBe('INVALID_COMMAND');
  });
});

describe('accounts store assignee / AI in care_conversation_state', () => {
  it('stores owner, agent, none, default and mode; AI is reported unsupported with the right note', () => {
    fx = make();
    const tg = second(fx);
    const z = zalo(fx, 'CORE');
    const t = seedChat(fx.stores, tg, 'tg:c', 'T', [{ at: T0 + 1 }]);
    const c = seedChat(fx.stores, z, 'p:c', 'C', [{ at: T0 + 1 }]);

    expect(wfOf(fx, t.id)).toMatchObject({ stateRevision: 0, assignee: { kind: 'none', source: 'none' }, ai: { supported: false, note: 'CORE_AI_UNAVAILABLE', takenOver: false } });
    expect(wfOf(fx, c.id).ai.note).toBe('CORE_AI_UNAVAILABLE');

    let dto = fx.svc.setAssignee(t.id, { kind: 'owner' });
    expect(dto.workflow).toMatchObject({ assignee: { kind: 'owner' }, ai: { takenOver: true, supported: false }, stateRevision: 1 });
    dto = fx.svc.setAssignee(t.id, { kind: 'agent', agentId: 'helper' });
    expect(dto.workflow).toMatchObject({ assignee: { kind: 'agent', agentId: 'helper', source: 'conversation' }, ai: { takenOver: false, agentId: 'helper' } });
    dto = fx.svc.setAiMode(t.id, 'draft');
    expect(dto.workflow?.ai.mode).toBe('draft');
    dto = fx.svc.setTakeover(t.id, true);
    expect(dto.workflow?.assignee.kind).toBe('owner');
    dto = fx.svc.setTakeover(t.id, false); // hands back to the rules
    expect(dto.workflow?.assignee).toEqual({ kind: 'none', agentId: null, source: 'none' });
    dto = fx.svc.setAssignee(t.id, { kind: 'none' });
    expect(dto.workflow?.assignee).toEqual({ kind: 'none', agentId: null, source: 'conversation' });
    expect(dto.workflow?.stateRevision).toBe(6);
    // Core classification: an unassigned waiting chat needs the owner and has nobody on it.
    expect(ids(list(fx, { view: 'me' }))).toContain(t.id);
    expect(ids(list(fx, { view: 'ai' }))).toEqual([]);
  });

  it('counts core intents waiting for review as pending drafts and routes them to "me"', () => {
    fx = make();
    const z = zalo(fx, 'D');
    const c = seedChat(fx.stores, z, 'p:dr', 'D', [{ at: T0 + 1 }, { at: T0 + 2, dir: 'out' }]); // answered
    expect(ids(list(fx, { view: 'me' }))).toEqual([]);
    fx.db
      .prepare(
        `INSERT INTO care_delivery_intents (id, account_id, conversation_id, client_request_id, actor, purpose, status, channel, payload_enc, payload_hash, adapter_retry_token, owner_epoch, created_at, updated_at)
         VALUES ('i1', ?, ?, 'r1', 'approved', 'care', 'draft', 'zalo', 'x', 'h', 'tok', 1, 1, 1)`,
      )
      .run(z.id, c.id);
    expect(wfOf(fx, c.id).pendingDrafts).toBe(1);
    expect(ids(list(fx, { view: 'me' }))).toEqual([c.id]);
  });
});

describe('notes', () => {
  it('adds, lists oldest first, is idempotent on clientRequestId, validates, encrypts at rest, deletes', () => {
    fx = make();
    const c = seedChat(fx.stores, zalo(fx), 'p:n', 'N', [{ at: T0 + 1 }]);
    const n1 = fx.svc.addNote(c.id, 'Khach hen thu 6', 'req-1');
    fx.clock.now += 1000;
    const n2 = fx.svc.addNote(c.id, 'Da goi lai', 'req-2');
    expect(fx.svc.notes(c.id).map((n) => n.body)).toEqual(['Khach hen thu 6', 'Da goi lai']);
    expect(n1).toMatchObject({ conversationId: c.id, author: 'owner', createdAtMs: T0 + 10 * MIN });

    expect(fx.svc.addNote(c.id, 'Khach hen thu 6', 'req-1').id).toBe(n1.id); // retry: same note
    expect(fx.svc.notes(c.id)).toHaveLength(2);
    expect(err(() => fx!.svc.addNote(c.id, 'other text', 'req-1')).code).toBe('DUPLICATE_REQUEST_PAYLOAD_MISMATCH');

    for (const bad of ['', '   ', 'x'.repeat(4001)]) expect(err(() => fx!.svc.addNote(c.id, bad, 'req-bad')).code).toBe('INVALID_COMMAND');
    expect(err(() => fx!.svc.addNote(c.id, 'ok', '')).code).toBe('INVALID_COMMAND');
    expect(fx.svc.addNote(c.id, 'x'.repeat(4000), 'req-max').body).toHaveLength(4000);

    const raw = fx.db.prepare('SELECT body_enc FROM care_conversation_notes WHERE id = ?').get(n1.id) as { body_enc: string };
    expect(raw.body_enc).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]*$/);
    expect(JSON.stringify(fx.db.prepare('SELECT * FROM care_conversation_notes').all())).not.toContain('Da goi lai');

    fx.svc.deleteNote(n2.id);
    expect(fx.svc.notes(c.id).map((n) => n.id)).toHaveLength(2); // n1 + the 4000-char one
    expect(fx.svc.notes(c.id).some((n) => n.id === n2.id)).toBe(false);
    expect(err(() => fx!.svc.deleteNote(n2.id)).code).toBe('NOT_FOUND');
    expect(err(() => fx!.svc.deleteNote('nope')).code).toBe('NOT_FOUND');
  });

  it('a conversation behind a closed source reads as missing', () => {
    fx = make();
    const a = zalo(fx, 'N2');
    const c = seedChat(fx.stores, a, 'p:n2', 'N', [{ at: T0 + 1 }]);
    const note = fx.svc.addNote(c.id, 'secret', 'r');
    fx.gate.closed.add(a.id);
    expect(err(() => fx!.svc.notes(c.id)).code).toBe('NOT_FOUND');
    expect(err(() => fx!.svc.addNote(c.id, 'x', 'r2')).code).toBe('NOT_FOUND');
    expect(err(() => fx!.svc.deleteNote(note.id)).code).toBe('NOT_FOUND');
    expect(err(() => fx!.svc.setStatus(c.id, { action: 'done' })).code).toBe('NOT_FOUND');
    expect(fx.svc.conversation(c.id)).toBeNull();
  });
});

describe('canned replies', () => {
  const base = { shortcut: 'gia', title: 'Bao gia', body: 'Gia la 100k' };
  it('creates, normalises the shortcut, lists by sort, updates, deletes', () => {
    fx = make();
    const a = fx.svc.saveCanned({ ...base, shortcut: '/GIA ' });
    expect(a).toMatchObject({ shortcut: 'gia', title: 'Bao gia', body: 'Gia la 100k', emailBody: null, sort: 1 });
    const b = fx.svc.saveCanned({ shortcut: 'ship', title: 'Ship', body: 'Ship 2 ngay', emailBody: 'Dear customer...' });
    expect(b).toMatchObject({ sort: 2, emailBody: 'Dear customer...' });
    expect(fx.svc.canned().map((c) => c.shortcut)).toEqual(['gia', 'ship']);

    const upd = fx.svc.saveCanned({ id: a.id, shortcut: 'gia', title: 'Gia moi', body: 'Gia 90k', sort: 9 });
    expect(upd).toMatchObject({ id: a.id, title: 'Gia moi', sort: 9, emailBody: null });
    expect(fx.svc.canned().map((c) => c.shortcut)).toEqual(['ship', 'gia']);

    fx.svc.deleteCanned(a.id);
    expect(fx.svc.canned()).toHaveLength(1);
    expect(err(() => fx!.svc.deleteCanned(a.id)).code).toBe('NOT_FOUND');
    expect(err(() => fx!.svc.saveCanned({ ...base, id: 'missing' })).code).toBe('NOT_FOUND');
  });

  it('a duplicate shortcut is a 409 CONFIGURATION_CONFLICT (create and rename); keeping your own shortcut is fine', () => {
    fx = make();
    const a = fx.svc.saveCanned(base);
    const b = fx.svc.saveCanned({ ...base, shortcut: 'other' });
    expect(err(() => fx!.svc.saveCanned({ ...base, title: 'dup' }))).toMatchObject({ code: 'CONFIGURATION_CONFLICT', status: 409 });
    expect(err(() => fx!.svc.saveCanned({ ...base, id: b.id }))).toMatchObject({ code: 'CONFIGURATION_CONFLICT' });
    expect(fx.svc.saveCanned({ ...base, id: a.id, title: 'same shortcut' }).title).toBe('same shortcut');
  });

  it('validates shortcut, title, body and emailBody lengths', () => {
    fx = make();
    const bad: Array<Record<string, string>> = [
      { shortcut: '' },
      { shortcut: 'has space' },
      { shortcut: 'x'.repeat(33) },
      { shortcut: 'dấu' },
      { title: '' },
      { title: 'x'.repeat(81) },
      { body: '' },
      { body: 'x'.repeat(4001) },
      { emailBody: 'x'.repeat(20_001) },
    ];
    for (const over of bad) expect(err(() => fx!.svc.saveCanned({ ...base, ...over })).code).toBe('INVALID_COMMAND');
    expect(fx.svc.saveCanned({ shortcut: 'x'.repeat(32), title: 'x'.repeat(80), body: 'x'.repeat(4000), emailBody: 'y'.repeat(20_000) }).emailBody).toHaveLength(20_000);
  });
});

describe('SSE journal events written by the service', () => {
  it('every write appends one conversation.updated with a revision-keyed id and no text; notes use note:<id>', () => {
    fx = make();
    const a = zalo(fx);
    const tg = second(fx);
    const c = seedChat(fx.stores, a, 'p:ev', 'EV', [{ at: T0 + 1, text: 'SECRET CUSTOMER TEXT' }]);
    const t = seedChat(fx.stores, tg, 'tg:ev', 'EVT', [{ at: T0 + 1 }]);
    fx.svc.setStatus(c.id, { action: 'done' });
    fx.svc.setStatus(c.id, { action: 'reopen' });
    fx.svc.setAssignee(t.id, { kind: 'owner' });
    fx.svc.setAiMode(t.id, 'draft');
    fx.svc.setTakeover(t.id, false);
    const note = fx.svc.addNote(c.id, 'PRIVATE NOTE TEXT', 'r-ev');
    fx.svc.addNote(c.id, 'PRIVATE NOTE TEXT', 'r-ev'); // duplicate: no second event
    fx.svc.saveCanned({ shortcut: 'a', title: 'A', body: 'B' }); // account-less: no event

    const evs = fx.stores.events.listEventsSince(0, 100).filter((e) => e.eventType === 'conversation.updated');
    expect(evs.map((e) => e.eventId)).toEqual([
      `conv-state:${c.id}:1`,
      `conv-state:${c.id}:2`,
      `conv-state:${t.id}:1`,
      `conv-state:${t.id}:2`,
      `conv-state:${t.id}:3`,
      `note:${note.id}`,
    ]);
    expect(evs[0]).toMatchObject({ accountId: a.id, conversationId: c.id });
    const journal = JSON.stringify(fx.db.prepare('SELECT * FROM care_events').all());
    expect(journal).not.toContain('SECRET');
    expect(journal).not.toContain('PRIVATE');
    fx.svc.deleteNote(note.id);
    expect(fx.stores.events.hasEvent(a.id, `note-del:${note.id}`)).toBe(true);
  });
});

describe('inbox counts on the text path', () => {
  it('are null when a text filter makes them inexact; rows still carry workflow', () => {
    fx = make();
    const a = zalo(fx);
    seedChat(fx.stores, a, 'p:q', 'Nguyen Van A', [{ at: T0 + 1 }]);
    const r = list(fx, { q: 'nguyen' });
    expect(r.inboxCounts).toBeNull();
    expect(r.items[0].workflow?.status).toBe('open');
    expect(list(fx, { q: 'nguyen', view: 'none' }).items).toHaveLength(1);
    expect(list(fx, { q: 'nguyen', view: 'ai' }).items).toHaveLength(0);
  });
});
