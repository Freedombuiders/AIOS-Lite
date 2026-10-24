import { afterEach, describe, expect, it } from 'vitest';
import { CareOutboxService } from '../application/outbox-service.js';
import { setRuntimeSwitch } from '../runtime/switches.js';
import { chatMessage, createEligibleAccount } from '../test-fixtures.js';
import type { CareApiError } from './dto.js';
import type { CareActivityItemDto, CareAssignmentDto, CareDraftDto, CareDraftRequestDto, CareEffectiveRuleDto, CareRunDto } from './dto-ops.js';
import { makeFileApi } from './test-helpers.js';

let api: ReturnType<typeof makeFileApi> | null = null;
afterEach(() => {
  api?.close();
  api = null;
});
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

function setup(deps: Parameters<typeof makeFileApi>[0] = {}, opts: Parameters<typeof makeFileApi>[1] = {}) {
  const a = makeFileApi(deps, opts);
  api = a;
  const account = createEligibleAccount(a.stores, { channel: 'zalo', nativeAccountId: 'zalo-R' });
  const saved = a.put(chatMessage(account, { senderIdentityKey: 'u-1', externalConversationKey: 'peer:1', nativeMessageId: 'm1', sentAtMs: 1_000, text: 'Giá bao nhiêu?' }));
  const conv = a.stores.conversations.getConversationByExternalKey(account.id, 'peer:1')!;
  return { a, stores: a.stores, account, conv, trigger: saved.messageId! };
}

describe('assignments CRUD', () => {
  it('creates, lists, updates with configVersion and deletes with the version', async () => {
    const { a, account } = setup();
    const created = await a.send('POST', '/api/m/care/assignments', { scope: 'global', mode: 'draft', agentId: 'agent-1', priority: 10 });
    expect(created.status).toBe(201);
    const rule = await json<CareAssignmentDto>(created);
    expect(rule).toMatchObject({ scope: 'global', mode: 'draft', enabled: true, configVersion: 1, accountId: null });

    const acct = await json<CareAssignmentDto>(
      await a.send('POST', '/api/m/care/assignments', { scope: 'account', accountId: account.id, mode: 'auto', agentId: 'agent-2', policyExt: { humanPauseMinutes: 5 } }),
    );
    expect(acct.policyExt).toEqual({ humanPauseMinutes: 5 });

    const list = await json<{ items: CareAssignmentDto[] }>(await a.get(`/api/m/care/assignments?account=${account.id}`));
    expect(list.items.map((i) => i.id).sort()).toEqual([rule.id, acct.id].sort()); // account rules + account-less ones
    expect((await json<{ items: CareAssignmentDto[] }>(await a.get('/api/m/care/assignments?scope=account'))).items).toHaveLength(1);
    expect((await a.get('/api/m/care/assignments?scope=bogus')).status).toBe(400);
    expect((await a.get('/api/m/care/assignments/nope')).status).toBe(404);

    const updated = await json<CareAssignmentDto>(
      await a.send('PUT', `/api/m/care/assignments/${rule.id}`, { scope: 'global', mode: 'auto', agentId: 'agent-1', priority: 10, expectedConfigVersion: 1 }),
    );
    expect(updated).toMatchObject({ mode: 'auto', configVersion: 2 });
    const stale = await a.send('PUT', `/api/m/care/assignments/${rule.id}`, { scope: 'global', mode: 'draft', agentId: 'agent-1', priority: 10, expectedConfigVersion: 1 });
    expect(stale.status).toBe(409);
    expect(await json<CareApiError>(stale)).toMatchObject({ code: 'STALE_REVISION', currentRevision: 2 });

    expect((await a.send('DELETE', `/api/m/care/assignments/${rule.id}?expectedConfigVersion=1`)).status).toBe(409);
    expect((await a.send('DELETE', `/api/m/care/assignments/${rule.id}`)).status).toBe(400);
    expect((await a.send('DELETE', `/api/m/care/assignments/${rule.id}?expectedConfigVersion=2`)).status).toBe(200);
    expect((await a.get(`/api/m/care/assignments/${rule.id}`)).status).toBe(404);
  });

  it('refuses a tie at the same tier and priority, but allows a more specific kind-restricted rule', async () => {
    const { a, account } = setup();
    const post = (body: Record<string, unknown>) => a.send('POST', '/api/m/care/assignments', { mode: 'draft', agentId: 'agent-1', ...body });
    const first = await json<CareAssignmentDto>(await post({ scope: 'global', priority: 50 }));

    const tie = await post({ scope: 'global', priority: 50 });
    expect(tie.status).toBe(409);
    expect(await json<CareApiError>(tie)).toMatchObject({
      code: 'CONFIGURATION_CONFLICT',
      details: { reason: 'PRIORITY_CONFLICT', tier: 'global', priority: 50, assignmentIds: [first.id] },
    });
    expect((await post({ scope: 'global', priority: 51 })).status).toBe(201);
    // restricted to direct chats = more specific tier-internal rule, no tie with the unrestricted one
    const direct = await post({ scope: 'global', priority: 50, policyExt: { conversationKinds: ['direct'] } });
    expect(direct.status).toBe(201);
    // another restricted rule overlapping on 'direct' at the same priority is a tie; a disjoint one is not
    expect((await post({ scope: 'global', priority: 50, policyExt: { conversationKinds: ['direct', 'group'] } })).status).toBe(409);
    expect((await post({ scope: 'global', priority: 50, policyExt: { conversationKinds: ['group'] } })).status).toBe(201);
    // an account-scoped rule is another tier: same priority is fine; two on the same account tie
    expect((await post({ scope: 'account', accountId: account.id, priority: 50 })).status).toBe(201);
    expect((await post({ scope: 'account', accountId: account.id, priority: 50 })).status).toBe(409);
    // conversation tier is keyed by its target
    expect((await post({ scope: 'conversation', accountId: account.id, scopeTarget: 'peer:1', priority: 50 })).status).toBe(201);
    expect((await post({ scope: 'conversation', accountId: account.id, scopeTarget: 'peer:2', priority: 50 })).status).toBe(201);
    expect((await post({ scope: 'conversation', accountId: account.id, scopeTarget: 'peer:1', priority: 50 })).status).toBe(409);

    // a dry run reports the same conflict and writes nothing
    const before = (await json<{ items: unknown[] }>(await a.get('/api/m/care/assignments'))).items.length;
    expect((await post({ scope: 'global', priority: 50, dryRun: true })).status).toBe(409);
    expect((await post({ scope: 'global', priority: 77, dryRun: true })).status).toBe(200);
    expect((await json<{ items: unknown[] }>(await a.get('/api/m/care/assignments'))).items.length).toBe(before);
  });

  it('validates shape, policy extension, channel and source gate', async () => {
    const closed = new Set<string>();
    const { a, account } = setup({ canReadSource: (id) => !closed.has(id) });
    const post = (body: Record<string, unknown>) => a.send('POST', '/api/m/care/assignments', { mode: 'draft', agentId: 'agent-1', ...body });

    const badExt = await post({ scope: 'global', policyExt: { humanPauseMinutes: -1, groupTrigger: 'sometimes' } });
    expect(badExt.status).toBe(400);
    const body = await json<CareApiError>(badExt);
    expect(body.details?.reason).toBe('INVALID_POLICY_EXT');
    expect((body.details?.warnings as string[]).join(' ')).toContain('humanPauseMinutes');

    const channel = await post({ scope: 'channel', channel: 'whatsapp' });
    expect(channel.status).toBe(422);
    expect((await json<CareApiError>(channel)).code).toBe('UNSUPPORTED_CAPABILITY');
    expect((await post({ scope: 'account' })).status).toBe(400); // store: account scope needs an account
    expect((await post({ scope: 'global', mode: 'draft', unknown: 1 })).status).toBe(400);
    expect((await post({ scope: 'global', mode: 'draft', agentId: '' })).status).toBe(400); // non-observe mode needs an agent
    expect((await post({ scope: 'global', mode: 'observe', agentId: undefined })).status).toBe(201);

    const own = await json<CareAssignmentDto>(await post({ scope: 'account', accountId: account.id, priority: 5 }));
    closed.add(account.id);
    expect((await a.get(`/api/m/care/assignments/${own.id}`)).status).toBe(404);
    expect((await json<{ items: CareAssignmentDto[] }>(await a.get('/api/m/care/assignments'))).items.some((i) => i.id === own.id)).toBe(false);
    expect((await post({ scope: 'account', accountId: account.id, priority: 6 })).status).toBe(404);
  });
});

describe('GET /conversations/:id/effective-rule', () => {
  it('walks the same tiers as the resolver and reports denied, none and conflict instead of throwing', async () => {
    const { a, stores, account, conv } = setup();
    const url = `/api/m/care/conversations/${conv.id}/effective-rule`;
    expect(await json<CareEffectiveRuleDto>(await a.get(url))).toMatchObject({ outcome: 'none' });

    stores.assignments.upsertAssignment({ scope: 'global', mode: 'draft', agentId: 'g', priority: 1 });
    const acct = stores.assignments.upsertAssignment({ scope: 'account', accountId: account.id, mode: 'auto', agentId: 'acct', priority: 1 });
    const active = await json<CareEffectiveRuleDto>(await a.get(url));
    expect(active).toMatchObject({ outcome: 'active', rule: { assignmentId: acct.id, tier: 'account', mode: 'auto', agentId: 'acct', policyRevision: `${acct.id}@1` } });
    expect(active.trace.map((t) => t.tier)).toEqual(['conversation', 'customer', 'identity', 'domain', 'account']);
    expect((active.rule!.policy as { values: { humanPauseMinutes: number } }).values.humanPauseMinutes).toBe(30); // channel default

    const off = stores.assignments.upsertAssignment({ scope: 'conversation', accountId: account.id, scopeTarget: 'peer:1', mode: 'draft', agentId: 'x', enabled: false });
    expect(await json<CareEffectiveRuleDto>(await a.get(url))).toMatchObject({ outcome: 'denied', rule: { assignmentId: off.id, enabled: false } });

    // two equal rules written behind the API's back: the preview explains the conflict
    stores.assignments.deleteAssignment(off.id);
    const x = stores.assignments.upsertAssignment({ scope: 'conversation', accountId: account.id, scopeTarget: 'peer:1', mode: 'draft', agentId: 'x', priority: 9 });
    const y = stores.assignments.upsertAssignment({ scope: 'conversation', accountId: account.id, scopeTarget: 'peer:1', mode: 'draft', agentId: 'y', priority: 9 });
    const conflict = await json<CareEffectiveRuleDto>(await a.get(url));
    expect(conflict).toMatchObject({ outcome: 'conflict', conflict: { tier: 'conversation', priority: 9 } });
    expect(conflict.conflict!.assignmentIds.sort()).toEqual([x.id, y.id].sort());

    expect((await a.get('/api/m/care/conversations/nope/effective-rule')).status).toBe(404);
  });

  it('is a 404 for a source whose read gate is closed', async () => {
    const closed = new Set<string>();
    const { a, account, conv } = setup({ canReadSource: (id) => !closed.has(id) });
    closed.add(account.id);
    expect((await a.get(`/api/m/care/conversations/${conv.id}/effective-rule`)).status).toBe(404);
  });
});

describe('POST /conversations/:id/draft', () => {
  it('only enqueues a manual inbound_turn job, idempotently, after the dispatch gate (work)', async () => {
    const { a, stores, account, conv, trigger } = setup();
    const url = `/api/m/care/conversations/${conv.id}/draft`;
    const first = await a.send('POST', url, { clientRequestId: 'draft-req-0001' });
    expect(first.status).toBe(202);
    const dto = await json<CareDraftRequestDto>(first);
    expect(dto).toMatchObject({ conversationId: conv.id, triggerMessageId: trigger, duplicate: false });
    const job = stores.jobs.getJob(dto.jobId)!;
    expect(job).toMatchObject({ jobType: 'inbound_turn', status: 'pending', accountId: account.id, ownerEpoch: account.ownerEpoch });
    expect(job.payload).toMatchObject({ trigger: 'manual', messageId: trigger, conversationId: conv.id });

    const again = await json<CareDraftRequestDto>(await a.send('POST', url, { clientRequestId: 'draft-req-0001' }));
    expect(again).toMatchObject({ jobId: dto.jobId, duplicate: true });
    const other = await json<CareDraftRequestDto>(await a.send('POST', url, { clientRequestId: 'draft-req-0002' }));
    expect(other.jobId).not.toBe(dto.jobId);
    expect(a.fx.a.prepare(`SELECT COUNT(*) AS n FROM care_agent_runs`).get()).toEqual({ n: 0 }); // no model turn in the request

    // the kill switch is for SENDING; a model turn is work and still runs
    setRuntimeSwitch(a.fx.a, 'dispatch', false, { actor: 't' });
    expect((await a.send('POST', url, { clientRequestId: 'draft-req-0003' })).status).toBe(202);
  });

  it('is refused by the dispatch gate (module off, closed path) and by bad targets', async () => {
    const { a, stores, account, conv } = setup();
    const url = `/api/m/care/conversations/${conv.id}/draft`;
    const deny = async (reason: string, status = 403) => {
      const res = await a.send('POST', url, { clientRequestId: `draft-${Math.random().toString(36).slice(2, 10)}` });
      expect(res.status).toBe(status);
      const body = await json<CareApiError>(res);
      expect(body.details?.reason).toBe(reason);
      expect(JSON.stringify(body)).not.toContain('Giá');
      return body;
    };
    setRuntimeSwitch(a.fx.a, 'module', false, { actor: 't' });
    expect((await deny('MODULE_DISABLED')).code).toBe('SYNC_DISABLED');
    setRuntimeSwitch(a.fx.a, 'module', true, { actor: 't' });
    setRuntimeSwitch(a.fx.a, 'path:api', false, { actor: 't' });
    await deny('PATH_DISABLED');
    setRuntimeSwitch(a.fx.a, 'path:api', true, { actor: 't' });
    expect(a.fx.a.prepare(`SELECT COUNT(*) AS n FROM care_jobs WHERE job_type = 'inbound_turn' AND dedupe_key LIKE 'manual-draft:%'`).get()).toEqual({ n: 0 });

    const other = stores.conversations.upsertConversation({ accountId: account.id, externalKey: 'peer:2', kind: 'direct', title: 'Other' });
    expect((await a.send('POST', url, { triggerMessageId: stores.messages.listMessages(other.id)[0]?.id ?? 'missing' })).status).toBe(404);
    expect((await a.send('POST', `/api/m/care/conversations/${other.id}/draft`, {})).status).toBe(400); // nothing to answer
    expect((await a.send('POST', '/api/m/care/conversations/nope/draft', {})).status).toBe(404);
    expect((await a.send('POST', url, { unknown: 1 })).status).toBe(400);
  });
});

describe('drafts: review, approve, discard', () => {
  function withDraft(over: Partial<Parameters<CareOutboxService['createDraft']>[0]> = {}) {
    const s = setup();
    const service = new CareOutboxService(s.a.fx.a, s.stores);
    const { intent } = service.createDraft({
      accountId: s.account.id,
      conversationId: s.conv.id,
      clientRequestId: `draft-${Math.random().toString(36).slice(2, 10)}`,
      actor: 'approved',
      content: { kind: 'chat', text: 'Dạ giá là 100k ạ' },
      contextRevision: s.conv.revision,
      ...over,
    });
    return { ...s, service, intent };
  }

  it('lists the draft with its exact revision, approves only that revision and asks the dispatch gate first', async () => {
    const { a, stores, intent } = withDraft();
    const list = await json<{ items: CareDraftDto[] }>(await a.get('/api/m/care/drafts'));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: intent.id, status: 'draft', payloadRevision: 1, text: 'Dạ giá là 100k ạ', channel: 'zalo', email: null });

    const stale = await a.send('POST', `/api/m/care/drafts/${intent.id}/approve`, { expectedRevision: 5 });
    expect(stale.status).toBe(409);
    expect(await json<CareApiError>(stale)).toMatchObject({ code: 'STALE_REVISION', currentRevision: 1 });
    expect(stores.outbox.getIntent(intent.id)!.status).toBe('draft');

    const staleContext = await a.send('POST', `/api/m/care/drafts/${intent.id}/approve`, { expectedRevision: 1, currentContextRevision: 999 });
    expect(staleContext.status).toBe(409);

    // kill switch: the draft is NOT enqueued
    setRuntimeSwitch(a.fx.a, 'dispatch', false, { actor: 't' });
    const killed = await a.send('POST', `/api/m/care/drafts/${intent.id}/approve`, { expectedRevision: 1 });
    expect(killed.status).toBe(403);
    expect(await json<CareApiError>(killed)).toMatchObject({ code: 'SEND_DISABLED', details: { reason: 'KILL_SWITCH' } });
    expect(stores.outbox.getIntent(intent.id)!.status).toBe('draft');
    setRuntimeSwitch(a.fx.a, 'dispatch', true, { actor: 't' });

    const ok = await json<CareDraftDto>(await a.send('POST', `/api/m/care/drafts/${intent.id}/approve`, { expectedRevision: 1 }));
    expect(ok).toMatchObject({ status: 'pending', approvedRevision: 1 });
    expect(stores.outbox.getIntent(intent.id)!.approvedBy).toBe('dashboard');
    // approving the same revision again is idempotent; a pending draft cannot be discarded
    expect((await a.send('POST', `/api/m/care/drafts/${intent.id}/approve`, { expectedRevision: 1 })).status).toBe(200);
    expect((await a.send('POST', `/api/m/care/drafts/${intent.id}/discard`, {})).status).toBe(409);
    expect((await a.send('POST', `/api/m/care/drafts/${intent.id}/approve`, { expectedRevision: 0 })).status).toBe(400);
  });

  it('discards a draft, filters by status and never shows the BCC envelope', async () => {
    const s = setup();
    const mail = createEligibleAccount(s.stores, { channel: 'email', connectorKind: 'gmail', nativeAccountId: 'shop@example.com' });
    const thread = s.stores.conversations.upsertConversation({ accountId: mail.id, externalKey: 'thread:1', kind: 'email_thread', title: 'Quote' });
    const service = new CareOutboxService(s.a.fx.a, s.stores);
    const { intent } = service.createDraft({
      accountId: mail.id,
      conversationId: thread.id,
      clientRequestId: 'draft-mail-0001',
      actor: 'approved',
      content: { kind: 'email', text: 'Body', to: ['buyer@example.com'], cc: ['boss@example.com'], bcc: ['secret-audit@example.com'], subject: 'Re: Quote' },
    });
    const text = await (await s.a.get(`/api/m/care/drafts/${intent.id}`)).text();
    expect(JSON.parse(text).email).toEqual({ to: ['buyer@example.com'], cc: ['boss@example.com'], subject: 'Re: Quote', hasBcc: true });
    expect(text).not.toContain('secret-audit');

    const discarded = await json<CareDraftDto>(await s.a.send('POST', `/api/m/care/drafts/${intent.id}/discard`, {}));
    expect(discarded.status).toBe('discarded');
    expect((await json<{ items: CareDraftDto[] }>(await s.a.get('/api/m/care/drafts'))).items).toHaveLength(0);
    expect((await json<{ items: CareDraftDto[] }>(await s.a.get('/api/m/care/drafts?status=discarded,draft'))).items).toHaveLength(1);
    expect((await s.a.get('/api/m/care/drafts?status=bogus')).status).toBe(400);
    expect((await s.a.get('/api/m/care/drafts/nope')).status).toBe(404);
    expect((await s.a.send('POST', '/api/m/care/drafts/nope/approve', { expectedRevision: 1 })).status).toBe(404);
  });

  it('hides drafts of a source whose read gate is closed', async () => {
    const closed = new Set<string>();
    const s = setup({ canReadSource: (id) => !closed.has(id) });
    const service = new CareOutboxService(s.a.fx.a, s.stores);
    const { intent } = service.createDraft({ accountId: s.account.id, conversationId: s.conv.id, clientRequestId: 'draft-gate-0001', actor: 'approved', content: { kind: 'chat', text: 'hidden text' } });
    closed.add(s.account.id);
    expect((await s.a.get(`/api/m/care/drafts/${intent.id}`)).status).toBe(404);
    expect((await s.a.send('POST', `/api/m/care/drafts/${intent.id}/approve`, { expectedRevision: 1 })).status).toBe(404);
    expect(await (await s.a.get('/api/m/care/drafts')).text()).not.toContain('hidden text');
  });
});

describe('GET /runs and /activity', () => {
  it('exposes skip reasons and delivery status without the decision payload, paginated, only for open sources', async () => {
    const closed = new Set<string>();
    const { a, stores, account, conv, trigger } = setup({ canReadSource: (id) => !closed.has(id) });
    const begin = (rev: number, over: Record<string, unknown> = {}) =>
      stores.agentRuns.beginRun({ accountId: account.id, conversationId: conv.id, triggerMessageId: trigger, contextRevision: rev, policyRevision: 'rule@1', agentId: 'agent-1', mode: 'draft', ...over });
    const r1 = begin(1).run;
    stores.agentRuns.completeRun(r1.id, { status: 'skipped', skipReason: 'quiet_hours', decision: { secretPrompt: 'PRIVATE-DECISION' } }, 10_000);
    const r2 = begin(2, { triggerKind: 'manual' }).run;
    stores.agentRuns.completeRun(r2.id, { status: 'drafted', draftRef: 'intent-9', modelCalled: true, latencyMs: 120 }, 20_000);

    const runs = await a.get('/api/m/care/runs');
    const text = await runs.text();
    expect(text).not.toContain('PRIVATE-DECISION');
    expect(text).not.toContain('decision');
    const items = JSON.parse(text).items as CareRunDto[];
    expect(items.map((r) => r.status).sort()).toEqual(['drafted', 'skipped']);
    expect(items.find((r) => r.status === 'skipped')).toMatchObject({ skipReason: 'quiet_hours', triggerKind: 'inbound', mode: 'draft' });
    expect(items.find((r) => r.status === 'drafted')).toMatchObject({ draftRef: 'intent-9', modelCalled: true, triggerKind: 'manual' });
    expect((await json<{ items: CareRunDto[] }>(await a.get('/api/m/care/runs?status=skipped'))).items).toHaveLength(1);
    expect((await a.get('/api/m/care/runs?status=bogus')).status).toBe(400);

    const service = new CareOutboxService(a.fx.a, stores);
    const { intent } = service.enqueue({ accountId: account.id, conversationId: conv.id, clientRequestId: 'reply-0000001', actor: 'manual', content: { kind: 'chat', text: 'sent text' } });

    const feed = await json<{ items: CareActivityItemDto[]; nextCursor: string | null }>(await a.get('/api/m/care/activity'));
    expect(feed.items.map((i) => i.kind).sort()).toEqual(['delivery', 'run', 'run']);
    expect(feed.items.find((i) => i.kind === 'delivery')).toMatchObject({ id: intent.id, status: 'pending', actor: 'manual' });
    expect(JSON.stringify(feed)).not.toContain('sent text');

    // walk the feed one item at a time: nothing skipped or repeated
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      const page: { items: CareActivityItemDto[]; nextCursor: string | null } = await json(await a.get(`/api/m/care/activity?limit=1${cursor ? `&cursor=${cursor}` : ''}`));
      seen.push(...page.items.map((x) => `${x.kind}:${x.id}`));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect(seen).toEqual(feed.items.map((x) => `${x.kind}:${x.id}`));

    closed.add(account.id);
    expect((await json<{ items: unknown[] }>(await a.get('/api/m/care/runs'))).items).toEqual([]);
    expect((await json<{ items: unknown[] }>(await a.get('/api/m/care/activity'))).items).toEqual([]);
    expect((await a.get(`/api/m/care/runs?account=${account.id}`)).status).toBe(404);
  });
});
