import { afterEach, describe, expect, it } from 'vitest';
import { CareOutboxService } from '../application/outbox-service.js';
import { applyCustomerHandoff } from '../application/conversation-hold.js';
import type { CareBotPanelDto, CareBotStateDto } from '../api/dto-inbox.js';
import type { CareConversationListDto } from '../api/dto.js';
import { createTestCareDatabase } from '../persistence/index.js';
import { TEST_KEY } from '../test-fixtures.js';
import { T0, seedChat, wrapApi, zaloAccount, type ApiFixture } from '../api/test-helpers.js';
import { decideBotState, pauseRunning, type BotFacts } from './bot-state.js';

const MIN = 60_000;
const NOW = T0 + 60 * MIN;

const facts = (over: Partial<BotFacts> = {}): BotFacts => ({
  channel: 'zalo',
  kind: 'direct',
  nowMs: NOW,
  pendingDrafts: 0,
  rule: { agentId: 'cskh', mode: 'draft', humanPauseMinutes: 30 },
  aiModeOff: false,
  takenOver: false,
  handoff: null,
  isPaused: false,
  pausedUntilMs: null,
  lastHumanReplyAtMs: null,
  ...over,
});
const label = (over: Partial<BotFacts> = {}) => decideBotState(facts(over)).label;

describe('decideBotState (T07 state label)', () => {
  it('Bot đang chăm: an enabled draft or auto rule and nothing holding the bot back', () => {
    expect(label()).toBe('active');
    expect(label({ rule: { agentId: 'cskh', mode: 'auto', humanPauseMinutes: 30 } })).toBe('active');
    expect(decideBotState(facts())).toMatchObject({ agentId: 'cskh', mode: 'draft', paused: false, yieldReason: null });
  });

  it('Chờ bạn duyệt: a pending draft wins over every other state except a handoff', () => {
    expect(label({ pendingDrafts: 1 })).toBe('review');
    expect(label({ pendingDrafts: 2, isPaused: true, pausedUntilMs: NOW + MIN, takenOver: true })).toBe('review');
    expect(label({ pendingDrafts: 1, rule: null })).toBe('review');
    expect(label({ pendingDrafts: 1, handoff: { atMs: NOW - MIN, keyword: 'khiếu nại' } })).toBe('handoff');
  });

  it('Chuyển cho bạn: the handoff marker, with its keyword', () => {
    const s = decideBotState(facts({ handoff: { atMs: NOW - MIN, keyword: 'khiếu nại' }, takenOver: true, isPaused: true, pausedUntilMs: NOW + MIN }));
    expect(s.label).toBe('handoff');
    expect(s.handoff).toEqual({ atMs: NOW - MIN, keyword: 'khiếu nại' });
  });

  it('Bot nhường bạn: a running pause, a take-over, or the owner writing inside the rule window', () => {
    expect(decideBotState(facts({ isPaused: true, pausedUntilMs: NOW + MIN }))).toMatchObject({ label: 'yielded', yieldReason: 'paused', paused: true, pausedUntilMs: NOW + MIN });
    expect(decideBotState(facts({ isPaused: true, pausedUntilMs: null }))).toMatchObject({ label: 'yielded', yieldReason: 'paused', paused: true, pausedUntilMs: null });
    expect(decideBotState(facts({ takenOver: true }))).toMatchObject({ label: 'yielded', yieldReason: 'taken_over' });
    expect(decideBotState(facts({ lastHumanReplyAtMs: NOW - 29 * MIN }))).toMatchObject({ label: 'yielded', yieldReason: 'human_reply' });
  });

  it('a pause that already ended, or a reply older than the window, no longer holds the bot back', () => {
    expect(pauseRunning(true, NOW - 1, NOW)).toBe(false);
    expect(pauseRunning(true, null, NOW)).toBe(true);
    expect(pauseRunning(false, null, NOW)).toBe(false);
    expect(label({ isPaused: true, pausedUntilMs: NOW - 1 })).toBe('active');
    expect(label({ lastHumanReplyAtMs: NOW - 30 * MIN })).toBe('active');
    // a rule with a 0-minute window never yields to a recent reply
    expect(label({ lastHumanReplyAtMs: NOW - MIN, rule: { agentId: 'a', mode: 'draft', humanPauseMinutes: 0 } })).toBe('active');
  });

  it('Chưa gán bot: no rule, observe-only, AI off here, a group, Telegram', () => {
    expect(label({ rule: null })).toBe('none');
    expect(label({ rule: { agentId: 'cskh', mode: 'observe', humanPauseMinutes: 30 } })).toBe('none');
    expect(label({ aiModeOff: true })).toBe('none');
    expect(label({ kind: 'group' })).toBe('none');
    expect(label({ channel: 'telegram' })).toBe('none');
    // no rule means nothing to yield: a paused conversation without a rule stays "Chưa gán bot"
    expect(label({ rule: null, isPaused: true, pausedUntilMs: NOW + MIN })).toBe('none');
  });
});

let api: ApiFixture | null = null;
afterEach(() => {
  api?.close();
  api = null;
});
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

function setup() {
  const t = createTestCareDatabase(':memory:', TEST_KEY);
  const raw = t.rawDbForTestIsolationOnly;
  api = wrapApi(t.stores, raw, {}, () => t.close());
  api.clock.now = NOW;
  const account = zaloAccount(t.stores);
  return { a: api, stores: t.stores, db: raw, account, service: new CareOutboxService(raw, t.stores) };
}
const botOf = async (a: ApiFixture, id: string): Promise<CareBotStateDto> => {
  const dto = await json<{ workflow: { bot: CareBotStateDto } }>(await a.get(`/api/m/care/conversations/${id}`));
  return dto.workflow.bot;
};

describe('the conversation list carries the server-computed label', () => {
  it('walks every label through the real routes and the rule resolver', async () => {
    const { a, stores, db, account, service } = setup();
    const plain = seedChat(stores, account, 'p:plain', 'Plain', [{ at: T0 + 1 }]);
    const group = seedChat(stores, account, 'g:grp', 'Nhóm', [{ at: T0 + 1 }], 'group');

    // no rule at all
    expect((await botOf(a, plain.id)).label).toBe('none');

    // an account rule: draft by agent cskh
    stores.assignments.upsertAssignment({ scope: 'account', accountId: account.id, mode: 'draft', agentId: 'cskh', priority: 1 });
    expect(await botOf(a, plain.id)).toMatchObject({ label: 'active', agentId: 'cskh', mode: 'draft' });
    expect((await botOf(a, group.id)).label).toBe('none');

    // owner pause (the T06 route) -> yielded, resume -> active
    expect((await a.send('PUT', `/api/m/care/conversations/${plain.id}/pause`, { minutes: 30 })).status).toBe(200);
    expect(await botOf(a, plain.id)).toMatchObject({ label: 'yielded', yieldReason: 'paused', paused: true, pausedUntilMs: NOW + 30 * MIN });
    expect((await a.send('DELETE', `/api/m/care/conversations/${plain.id}/pause`)).status).toBe(200);
    expect((await botOf(a, plain.id)).label).toBe('active');

    // the owner types from the phone -> yielded for the rule's 30 minute window
    const phone = seedChat(stores, account, 'p:phone', 'Phone', [{ at: T0 + 1 }, { at: NOW - 5 * MIN, dir: 'out', role: 'self' }]);
    expect(await botOf(a, phone.id)).toMatchObject({ label: 'yielded', yieldReason: 'human_reply' });

    // AI off here -> none; back on -> active
    expect((await a.send('PUT', `/api/m/care/conversations/${plain.id}/ai`, { mode: 'off' })).status).toBe(200);
    expect((await botOf(a, plain.id)).label).toBe('none');
    expect((await a.send('PUT', `/api/m/care/conversations/${plain.id}/ai`, { mode: 'auto' })).status).toBe(200);
    expect((await botOf(a, plain.id)).label).toBe('active');

    // a bot draft waits -> review
    service.createDraft({ accountId: account.id, conversationId: plain.id, clientRequestId: 'agent-turn:run-9', actor: 'approved', content: { kind: 'chat', text: 'nháp' }, createdBy: 'agent:cskh' });
    expect((await botOf(a, plain.id)).label).toBe('review');

    // customer handoff -> handoff, until the owner hands the conversation back
    const handed = seedChat(stores, account, 'p:hand', 'Hand', [{ at: T0 + 1, text: 'cho tôi gặp nhân viên' }]);
    const msg = stores.messages.listMessages(handed.id, { limit: 5 })[0]!;
    db.transaction(() => applyCustomerHandoff(db, stores, { conversationId: handed.id, accountId: account.id, keyword: 'gặp nhân viên', messageId: msg.id, nowMs: NOW, pauseMinutes: 60 })).immediate();
    expect(await botOf(a, handed.id)).toMatchObject({ label: 'handoff', handoff: { atMs: NOW, keyword: 'gặp nhân viên' }, paused: true });
    expect((await a.send('PUT', `/api/m/care/conversations/${handed.id}/takeover`, { on: false })).status).toBe(200);
    expect(await botOf(a, handed.id)).toMatchObject({ label: 'active', handoff: null, paused: false });

    // the list answers with the same labels
    const list = await json<CareConversationListDto>(await a.get('/api/m/care/conversations?limit=50'));
    const byId = new Map(list.items.map((c) => [c.id, c.workflow?.bot?.label]));
    expect(byId.get(plain.id)).toBe('review');
    expect(byId.get(group.id)).toBe('none');
    expect(byId.get(phone.id)).toBe('yielded');
    expect(byId.get(handed.id)).toBe('active');
  });

  it('GET /conversations/:id/bot reports the effective rule, both rule scopes, the switch and the settings', async () => {
    const t = createTestCareDatabase(':memory:', TEST_KEY);
    const raw = t.rawDbForTestIsolationOnly;
    api = wrapApi(t.stores, raw, {
      botSettings: () => ({ aiEnabled: true, autoSendEnabled: false, handoffKeywords: ['khiếu nại'], handoffPauseMinutes: 60, turnDebounceSeconds: 3, quietHoursStart: '22:00', quietHoursEnd: '07:00' }),
    }, () => t.close());
    const a = api;
    const account = zaloAccount(t.stores);
    const conv = seedChat(t.stores, account, 'p:bot', 'Bot', [{ at: T0 + 1 }]);

    const empty = await json<CareBotPanelDto>(await a.get(`/api/m/care/conversations/${conv.id}/bot`));
    expect(empty).toMatchObject({ conversationId: conv.id, effective: { outcome: 'none', agentId: null, mode: null }, accountRule: null, conversationRule: null, aiMode: null, takenOver: false });
    expect(empty.rules).toMatchObject({ maxRepliesPerThreadDay: null, humanPauseMinutes: null, settings: { handoffKeywords: ['khiếu nại'], autoSendEnabled: false, turnDebounceSeconds: 3, quietHoursStart: '22:00' } });

    const acct = t.stores.assignments.upsertAssignment({ scope: 'account', accountId: account.id, mode: 'draft', agentId: 'cskh', priority: 1 });
    const own = t.stores.assignments.upsertAssignment({ scope: 'conversation', accountId: account.id, scopeTarget: 'p:bot', mode: 'auto', agentId: 'tro-ly', priority: 1 });
    await a.send('PUT', `/api/m/care/conversations/${conv.id}/ai`, { mode: 'draft' });
    const body = await json<CareBotPanelDto>(await a.get(`/api/m/care/conversations/${conv.id}/bot`));
    expect(body.effective).toEqual({ outcome: 'active', tier: 'conversation', agentId: 'tro-ly', mode: 'auto' });
    expect(body.accountRule).toMatchObject({ id: acct.id, scope: 'account', mode: 'draft', agentId: 'cskh' });
    expect(body.conversationRule).toMatchObject({ id: own.id, scope: 'conversation', mode: 'auto', agentId: 'tro-ly' });
    expect(body.aiMode).toBe('draft');
    expect(body.rules).toMatchObject({ maxRepliesPerThreadDay: 30, humanPauseMinutes: 30 });
    expect((await a.get('/api/m/care/conversations/missing/bot')).status).toBe(404);
  });
});
