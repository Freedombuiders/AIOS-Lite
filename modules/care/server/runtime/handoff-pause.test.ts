/**
 * T06: hard handoff ("gặp nhân viên"), timed pause and the inbound-turn debounce, through the real runtime composition
 * (ingest -> worker -> agent turn -> outbox -> guard -> fake connector). Fake runner, fake connector, manual clock:
 * nothing leaves the process; "sent" means the fake connector recorded a delivery.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeCareConnector } from '../connectors/fake-connector.js';
import { FakeRunner } from '../application/agent-test-support.js';
import type { CustomerHandoff } from '../application/conversation-hold.js';
import { CareReadModel } from '../api/read-model.js';
import { ApiError } from '../api/errors.js';
import { createCareWorkflowService } from '../workflow/index.js';
import { chatMessage } from '../test-fixtures.js';
import { createManualClock } from './clock.js';
import { createCareRuntime, type CareRuntime, type CareRuntimeDeps } from './care-runtime.js';
import { runtimeFixture } from './runtime-fixtures.js';

const MIN = 60_000;
const open: Array<() => void> = [];
afterEach(() => open.splice(0).forEach((c) => c()));

function rig(opts: { mode?: 'draft' | 'auto'; extra?: Partial<CareRuntimeDeps> } = {}) {
  const f = runtimeFixture();
  open.push(f.close);
  const connector = new FakeCareConnector('fake', 'zalo');
  const runner = new FakeRunner();
  runner.respond = () => ({ text: JSON.stringify({ action: 'reply', replies: [{ text: 'Dạ shop trả lời ạ' }] }) });
  const clock = createManualClock(Date.now());
  const handoffs: CustomerHandoff[] = [];
  const rt: CareRuntime = createCareRuntime({
    db: f.a,
    stores: f.storesA,
    connectors: { forAccount: () => connector },
    runner,
    workerId: 'w1',
    clock,
    worker: { lockTtlMs: 600_000, leaseMs: 600_000, batchPerAccount: 10 },
    autoDelaySeconds: () => 0,
    onHandoff: (h) => handoffs.push(h),
    ...opts.extra,
  });
  f.storesA.assignments.upsertAssignment({ scope: 'account', accountId: f.account.id, mode: opts.mode ?? 'auto', agentId: 'cskh' });
  const conversation = f.storesA.conversations.upsertConversation({ accountId: f.account.id, externalKey: 'peer:1', kind: 'direct', title: 'Khách' });
  const model = new CareReadModel(f.a, f.storesA, () => true);
  const wf = createCareWorkflowService({ db: f.a, stores: f.storesA, model, now: () => clock.now(), canReadSource: () => true });

  const customer = (text: string) =>
    rt.ingest.ingestNormalizedMessage(chatMessage(f.account, { externalConversationKey: 'peer:1', text, sentAtMs: clock.now() }));
  /** Lets every due job and outbox delivery run (the ingest stamps jobs with real time; the manual clock catches up). */
  const pump = async (ms = 5_000) => {
    await clock.advance(ms);
    for (let i = 0; i < 4; i++) await rt.tick();
  };
  const intent = (id: string) => f.a.prepare('SELECT status, status_reason AS reason, actor FROM care_delivery_intents WHERE id = ?').get(id) as { status: string; reason: string | null; actor: string };
  const intents = () => f.a.prepare('SELECT id, status, actor FROM care_delivery_intents ORDER BY created_at, id').all() as Array<{ id: string; status: string; actor: string }>;
  const conv = () => f.storesA.conversations.getConversation(conversation.id)!;
  const state = () =>
    f.a.prepare('SELECT taken_over_at AS takenOverAt, assignee_kind AS kind, handoff_at AS handoffAt, handoff_keyword AS keyword FROM care_conversation_state WHERE conversation_id = ?').get(conversation.id) as
      | { takenOverAt: number | null; kind: string; handoffAt: number | null; keyword: string | null }
      | undefined;
  const runs = () => f.a.prepare('SELECT status, skip_reason AS reason FROM care_agent_runs ORDER BY created_at').all() as Array<{ status: string; reason: string | null }>;
  const turnJobs = () => (f.a.prepare("SELECT COUNT(*) AS n FROM care_jobs WHERE job_type = 'inbound_turn'").get() as { n: number }).n;

  const content = (text: string) => ({ kind: 'chat' as const, text });
  const base = { accountId: f.account.id, conversationId: conversation.id };
  /** What the bot (and the owner) had queued before the customer asked for a person. */
  const queueBefore = () => {
    const auto = rt.service.enqueue({ ...base, clientRequestId: 'auto-1', actor: 'auto', content: content('trả lời tự động cũ'), sourceRunId: 'run-a', notBeforeMs: clock.now() + 10 * MIN }).intent;
    const draft = rt.service.createDraft({ ...base, clientRequestId: 'draft-1', actor: 'approved', content: content('nháp chưa duyệt'), sourceRunId: 'run-d' }).intent;
    const approvedDraft = rt.service.createDraft({ ...base, clientRequestId: 'draft-2', actor: 'approved', content: content('nháp đã duyệt'), sourceRunId: 'run-e' }).intent;
    rt.service.approveDraft(approvedDraft.id, { expectedRevision: approvedDraft.payloadRevision });
    const manual = rt.service.enqueue({ ...base, clientRequestId: 'manual-1', actor: 'manual', content: content('chủ shop tự nhắn') }).intent;
    return { auto, draft, approvedDraft, manual };
  };

  return { f, rt, runner, connector, clock, handoffs, conversation, wf, customer, pump, intent, intents, conv, state, runs, turnJobs, queueBefore, base, content };
}

describe('hard handoff: the customer asks for a person (T06)', () => {
  for (const text of ['Cho tôi gặp nhân viên', 'CHO TOI GAP NHAN VIEN', 'tôi muốn khieu nai', 'Gặp Người Thật giúp mình']) {
    it(`"${text}": no agent run, conversation paused and taken over, bot replies withdrawn, owner notified`, async () => {
      const r = rig();
      const q = r.queueBefore();
      const at = r.clock.now();
      const res = r.customer(text);

      // same transaction as the message: state recorded, no turn queued
      expect(res.outcome).toBe('created');
      expect(res.jobId).toBeUndefined();
      expect(res.handoff).toMatchObject({ conversationId: r.conversation.id, messageId: res.messageId, pausedUntilMs: at + 60 * MIN });
      expect(r.turnJobs()).toBe(0);
      expect(r.conv()).toMatchObject({ isPaused: true, pausedUntilMs: at + 60 * MIN });
      expect(r.state()).toMatchObject({ kind: 'owner', handoffAt: at });
      expect(r.state()!.takenOverAt).not.toBeNull();
      expect(r.handoffs).toHaveLength(1);
      expect(['gặp nhân viên', 'khiếu nại', 'gặp người thật']).toContain(r.handoffs[0]!.keyword);

      // the bot's queued work is withdrawn through the intent state machine; the owner's own reply is untouched
      expect(r.intent(q.auto.id)).toMatchObject({ status: 'cancelled', reason: 'HANDOFF' });
      expect(r.intent(q.draft.id)).toMatchObject({ status: 'discarded', reason: 'HANDOFF' });
      expect(r.intent(q.approvedDraft.id)).toMatchObject({ status: 'needs_review', reason: 'HANDOFF' });
      expect(r.intent(q.manual.id).status).toBe('pending');

      await r.pump();
      expect(r.runner.requests).toHaveLength(0);
      expect(r.connector.providerSendCount).toBe(1); // only the owner's manual reply
      expect(r.intent(q.manual.id).status).toBe('sent');
    });
  }

  it('nothing stale goes out after the pause, the bot stays off until the owner hands the conversation back', async () => {
    const r = rig();
    const q = r.queueBefore();
    r.customer('gặp nhân viên');
    await r.pump(61 * MIN); // the timed pause is over
    expect(r.intent(q.auto.id).status).toBe('cancelled');
    expect(r.connector.providerSendCount).toBe(1); // the manual reply, nothing of the bot

    // still handed off: a new customer message gets no reply from the bot
    r.customer('alo shop ơi');
    await r.pump();
    expect(r.runner.requests).toHaveLength(0);
    expect(r.runs().at(-1)).toMatchObject({ status: 'skipped', reason: 'conversation_taken_over' });

    // only the owner ends it: take-over off clears the handoff and the pause
    r.wf.setTakeover(r.conversation.id, false);
    expect(r.state()).toMatchObject({ handoffAt: null, keyword: null, takenOverAt: null });
    expect(r.conv().isPaused).toBe(false);
    r.customer('cho mình hỏi giá');
    await r.pump();
    expect(r.runner.requests).toHaveLength(1);
    expect(r.connector.providerSendCount).toBe(2);
  });

  it('a turn already running when the handoff arrives is discarded at the post-run recheck', async () => {
    const r = rig();
    r.runner.respond = () => {
      r.customer('thôi cho tôi gặp nhân viên'); // the customer writes while the model is thinking
      return { text: JSON.stringify({ action: 'reply', replies: [{ text: 'câu trả lời đã lỗi thời' }] }) };
    };
    r.customer('Cho mình hỏi giá áo');
    await r.pump();
    await r.pump();
    expect(r.runner.requests).toHaveLength(1);
    expect(r.runs()).toEqual([{ status: 'skipped', reason: 'conversation_paused' }]);
    expect(r.intents()).toEqual([]);
    expect(r.connector.providerSendCount).toBe(0);
  });

  it('an automatic reply queued just after the handoff is cancelled at send time, not deferred past the pause', async () => {
    const r = rig();
    r.customer('khiếu nại');
    // a run that passed its post-run check a moment before the handoff committed proposes now
    const late = r.rt.service.enqueue({ ...r.base, clientRequestId: 'late-auto', actor: 'auto', content: r.content('trả lời muộn'), sourceRunId: 'run-late' }).intent;
    await r.pump();
    expect(r.intent(late.id).status).toBe('cancelled');
    await r.pump(61 * MIN);
    expect(r.connector.providerSendCount).toBe(0);
  });

  it('the keywords and the pause come from the settings; an empty list switches the rule off', async () => {
    const custom = rig({ extra: { handoff: () => ({ keywords: ['gặp quản lý'], pauseMinutes: 15 }) } });
    const at = custom.clock.now();
    expect(custom.customer('gặp nhân viên').jobId).toBeDefined(); // not a configured phrase any more
    expect(custom.customer('cho GAP QUAN LY').handoff?.pausedUntilMs).toBe(at + 15 * MIN);

    const off = rig({ extra: { handoff: () => ({ keywords: [], pauseMinutes: 60 }) } });
    expect(off.customer('gặp nhân viên').jobId).toBeDefined();
    expect(off.conv().isPaused).toBe(false);
  });

  it('a replayed event does not hand off twice', () => {
    const r = rig();
    const msg = chatMessage(r.f.account, { externalConversationKey: 'peer:1', text: 'gặp nhân viên', sentAtMs: r.clock.now() });
    r.rt.ingest.ingestNormalizedMessage(msg, undefined, 1, 'ev-1');
    const again = r.rt.ingest.ingestNormalizedMessage(msg, undefined, 1, 'ev-1');
    expect(again.outcome).toBe('duplicate_event');
    expect(r.handoffs).toHaveLength(1);
  });
});

describe('timed pause (T06)', () => {
  it('blocks runs until it ends, cancels the queued automatic reply, and nothing stale is sent afterwards', async () => {
    const r = rig();
    const old = r.rt.service.enqueue({ ...r.base, clientRequestId: 'auto-old', actor: 'auto', content: r.content('cũ'), sourceRunId: 'run-o', notBeforeMs: r.clock.now() + 5 * MIN }).intent;
    const draft = r.rt.service.createDraft({ ...r.base, clientRequestId: 'd-1', actor: 'approved', content: r.content('nháp'), sourceRunId: 'run-d' }).intent;

    const dto = r.wf.setPause(r.conversation.id, 30);
    expect(dto).toMatchObject({ isPaused: true, pausedUntilMs: r.clock.now() + 30 * MIN });
    expect(r.intent(old.id)).toMatchObject({ status: 'cancelled', reason: 'PAUSED' });
    expect(r.intent(draft.id).status).toBe('draft'); // a draft waits for the owner anyway

    r.customer('shop ơi còn hàng không');
    await r.pump();
    expect(r.runner.requests).toHaveLength(0);
    expect(r.runs()).toEqual([{ status: 'skipped', reason: 'conversation_paused' }]);

    await r.pump(31 * MIN);
    expect(r.connector.providerSendCount).toBe(0); // the cancelled reply never comes back
    r.customer('shop ơi?');
    await r.pump();
    expect(r.runner.requests).toHaveLength(1);
    expect(r.connector.providerSendCount).toBe(1);
    expect(r.intent(old.id).status).toBe('cancelled');
  });

  it('until switched back on (null), resume, and only 30 / 120 minutes are accepted', async () => {
    const r = rig();
    expect(r.wf.setPause(r.conversation.id, null)).toMatchObject({ isPaused: true, pausedUntilMs: null });
    await r.pump(24 * 60 * MIN);
    r.customer('alo');
    await r.pump();
    expect(r.runner.requests).toHaveLength(0);

    expect(r.wf.resume(r.conversation.id)).toMatchObject({ isPaused: false, pausedUntilMs: null });
    r.customer('alo alo');
    await r.pump();
    expect(r.runner.requests).toHaveLength(1);

    const bad = (() => {
      try {
        r.wf.setPause(r.conversation.id, 45);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(bad).toBeInstanceOf(ApiError);
  });

  it('a pause that starts while a reply waits for its send delay cancels it at send time too', async () => {
    const r = rig({ extra: { autoDelaySeconds: () => 120 } });
    r.customer('cho mình hỏi');
    await r.pump(); // drafted as auto, due in 2 minutes
    const [auto] = r.intents();
    expect(auto).toMatchObject({ actor: 'auto', status: 'pending' });
    // set the pause flags directly (as another writer would), so only the send guard stands between the reply and the customer
    r.f.storesA.conversations.setCareFlags(r.conversation.id, { isPaused: true, pausedUntilMs: r.clock.now() + 30 * MIN });
    await r.pump(3 * MIN);
    expect(r.intent(auto!.id).status).toBe('cancelled');
    await r.pump(40 * MIN);
    expect(r.connector.providerSendCount).toBe(0);
  });

  it('taking over or switching the AI off also withdraws the queued automatic reply', () => {
    const r = rig();
    const a = r.rt.service.enqueue({ ...r.base, clientRequestId: 'a-1', actor: 'auto', content: r.content('x'), sourceRunId: 'r1', notBeforeMs: r.clock.now() + MIN }).intent;
    r.wf.setTakeover(r.conversation.id, true);
    expect(r.intent(a.id)).toMatchObject({ status: 'cancelled', reason: 'TAKEN_OVER' });
    const b = r.rt.service.enqueue({ ...r.base, clientRequestId: 'b-1', actor: 'auto', content: r.content('y'), sourceRunId: 'r2', notBeforeMs: r.clock.now() + MIN }).intent;
    r.wf.setAiMode(r.conversation.id, 'off');
    expect(r.intent(b.id)).toMatchObject({ status: 'cancelled', reason: 'AI_OFF' });
  });
});

describe('debounce: several messages in a row, one agent turn (T06)', () => {
  it('only the last message of a burst runs the model, and its context holds the whole burst', async () => {
    const r = rig({ mode: 'draft', extra: { turnDebounceMs: () => 3_000 } });
    vi.spyOn(Date, 'now').mockImplementation(() => r.clock.now()); // job timestamps follow the manual clock
    try {
      r.customer('shop ơi');
      await r.clock.advance(1_000);
      r.customer('áo này còn size M không');
      await r.clock.advance(1_000);
      r.customer('giá bao nhiêu vậy');
      await r.pump(1_000); // 3 s after the first message: its turn is due but superseded
      expect(r.runner.requests).toHaveLength(0);
      await r.pump(3_000);
      expect(r.runner.requests).toHaveLength(1);
      const prompt = r.runner.requests[0]!.prompt;
      for (const t of ['shop ơi', 'áo này còn size M không', 'giá bao nhiêu vậy']) expect(prompt).toContain(t);
      expect(r.intents()).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
