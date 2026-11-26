import { afterEach, describe, expect, it } from 'vitest';
import { CareOutboxService } from '../application/outbox-service.js';
import { createTestCareDatabase } from '../persistence/index.js';
import { TEST_KEY } from '../test-fixtures.js';
import type { CareInlineDraftDto } from './dto-inbox.js';
import { DRAFT_STOP_CODES, draftSourcesOf, draftStopOf } from './draft-stop.js';
import { T0, seedChat, wrapApi, zaloAccount, type ApiFixture } from './test-helpers.js';

describe('draftStopOf (why the bot stopped at a draft)', () => {
  it('reads the delivery reason codes and the review reason of the run', () => {
    expect(draftStopOf({ delivery: { reasonCodes: ['draft_mode'] }, reviewReason: null })).toEqual({ codes: ['draft_mode'], detail: null });
    expect(draftStopOf({ delivery: { reasonCodes: ['needs_review', 'quiet_hours'] }, reviewReason: 'có con số giảm giá' })).toEqual({ codes: ['needs_review', 'quiet_hours'], detail: 'có con số giảm giá' });
    expect(draftStopOf({ delivery: { reasonCodes: ['needs_review'] }, reviewReason: 'review_keyword:giảm giá' })).toEqual({ codes: ['review_keyword', 'needs_review'], detail: 'giảm giá' });
  });

  it('puts the main reason first and drops codes it does not know', () => {
    expect(draftStopOf({ delivery: { reasonCodes: ['draft_mode', 'made_up', 'kill_switch_auto_send'] } })?.codes).toEqual(['kill_switch_auto_send', 'draft_mode']);
  });

  it('is null for a draft a person made (no run) or a run without reasons', () => {
    expect(draftStopOf(null)).toBeNull();
    expect(draftStopOf({})).toBeNull();
    expect(draftStopOf({ delivery: { reasonCodes: [] } })).toBeNull();
  });

  it('caps the agent note and every code it can return is a listed one', () => {
    expect(draftStopOf({ reviewReason: 'x'.repeat(500) })?.detail).toHaveLength(200);
    for (const c of ['needs_review', 'review_keyword', 'quiet_hours', 'kill_switch_auto_send', 'conversation_ai_draft', 'agent_scope_missing_send', 'draft_mode', 'manual_request']) {
      expect(DRAFT_STOP_CODES).toContain(c);
    }
  });

  it('brain sources: only the strings a run recorded, at most five', () => {
    expect(draftSourcesOf({ decision: { sources: ['a.md', 'b.md', 7, '', 'c.md', 'd.md', 'e.md', 'f.md'] } })).toEqual(['a.md', 'b.md', 'c.md', 'd.md', 'e.md']);
    expect(draftSourcesOf({ decision: {} })).toEqual([]);
    expect(draftSourcesOf(null)).toEqual([]);
  });
});

let api: ApiFixture | null = null;
afterEach(() => { api?.close(); api = null; });

describe('GET /conversations/:id/drafts carries the revision and the stop reason', () => {
  it('reads them from the agent run behind the draft', async () => {
    const t = createTestCareDatabase(':memory:', TEST_KEY);
    const raw = t.rawDbForTestIsolationOnly;
    api = wrapApi(t.stores, raw, {}, () => t.close());
    const account = zaloAccount(t.stores);
    const conv = seedChat(t.stores, account, 'peer:d', 'D', [{ at: T0 }]);
    const trigger = t.stores.messages.listMessages(conv.id, { limit: 1 })[0]!;
    const began = t.stores.agentRuns.beginRun({ accountId: account.id, conversationId: conv.id, triggerMessageId: trigger.id, contextRevision: 1, policyRevision: 'p@1', agentId: 'cskh', mode: 'draft' }, { nowMs: T0, leaseMs: 60_000 });
    t.stores.agentRuns.completeRun(began.run.id, { status: 'drafted', draftRef: 'x', decision: { decision: {}, delivery: { reasonCodes: ['draft_mode'] }, needsReview: true, reviewReason: 'review_keyword:giảm giá' } }, T0 + 1);
    const service = new CareOutboxService(raw, t.stores);
    const made = service.createDraft({ accountId: account.id, conversationId: conv.id, clientRequestId: 'agent-turn:run-1', actor: 'approved', content: { kind: 'chat', text: 'nháp' }, createdBy: 'agent:cskh' }).intent;
    raw.prepare('UPDATE care_delivery_intents SET source_run_id = ? WHERE id = ?').run(began.run.id, made.id);

    const { items } = (await (await api.get(`/api/m/care/conversations/${conv.id}/drafts`)).json()) as { items: CareInlineDraftDto[] };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: made.id, payloadRevision: made.payloadRevision, stop: { codes: ['review_keyword', 'draft_mode'], detail: 'giảm giá' }, sources: [] });
  });
});
