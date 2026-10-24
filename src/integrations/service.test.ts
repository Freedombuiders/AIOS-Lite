import { afterEach, describe, expect, it } from 'vitest';
import { createRunToken, tokenSecret, verifyRunToken } from './run-token.js';
import { parseGrantsBody } from './access.js';
import { parseArgs, tokenize } from './args.js';
import { makeHarness } from './test-harness.js';

let h: ReturnType<typeof makeHarness>;
afterEach(() => h?.cleanup());

const call = (command: string, args = '', taskId: number | null = 1, agentId = 'agent-a') =>
  h.service.runner.call({ agentId, taskId, integration: 'pancake', command, args });

describe('args', () => {
  it('tokenizes with quotes and parses flags', () => {
    expect(tokenize(`orders list --note "hai từ" 'x y' --full`)).toEqual(['orders', 'list', '--note', 'hai từ', 'x y', '--full']);
    expect(parseArgs(tokenize('orders get 12 --limit=5 --full'))).toEqual({ positionals: ['orders', 'get', '12'], flags: { limit: '5', full: true } });
    expect(() => tokenize('a "b')).toThrow();
  });
});

describe('grants body', () => {
  it('validates ids, grants and override names; drops off', () => {
    expect(parseGrantsBody({ pancake: 'read', botcake: 'off' })).toEqual({ grants: { pancake: 'read' } });
    expect(parseGrantsBody({ pancake: { grant: 'write', ask: ['orders set-status'] } })).toEqual({ grants: { pancake: { grant: 'write', ask: ['orders set-status'] } } });
    expect(parseGrantsBody({ nope: 'read' })).toHaveProperty('error');
    expect(parseGrantsBody({ pancake: 'admin' })).toHaveProperty('error');
    expect(parseGrantsBody({ pancake: { grant: 'write', ask: ['bogus'] } })).toHaveProperty('error');
  });
});

describe('run token', () => {
  it('round-trips and rejects tampering and expiry', () => {
    h = makeHarness();
    const secret = tokenSecret(h.db);
    expect(tokenSecret(h.db)).toBe(secret);
    const tok = createRunToken({ agentId: 'agent-a', taskId: 7 }, secret);
    expect(verifyRunToken(tok, secret)).toEqual({ agentId: 'agent-a', taskId: 7 });
    expect(verifyRunToken(tok + 'x', secret)).toBeNull();
    expect(verifyRunToken(tok, 'other')).toBeNull();
    expect(verifyRunToken(createRunToken({ agentId: 'agent-a', taskId: 7 }, secret, -1), secret)).toBeNull();
    expect(verifyRunToken('garbage', secret)).toBeNull();
  });
});

describe('credentials', () => {
  it('saves only after the test passes, masks secrets, never returns them', async () => {
    h = makeHarness({ pancake: 'read' });
    const res = await h.connectPancake();
    expect(res.ok).toBe(true);
    const s = h.service.credentials.get('pancake')!;
    expect(s.status).toBe('ok');
    const key = s.fields.find((f) => f.key === 'pos_api_key')!;
    expect(key.value).toBe('••••9876');
    expect(JSON.stringify(h.service.credentials.list())).not.toContain('pk-secret-9876');
    // stored encrypted
    const raw = (h.db.prepare('SELECT values_enc FROM integration_credentials WHERE integration_id = ?').get('pancake') as { values_enc: string }).values_enc;
    expect(raw).not.toContain('pk-secret-9876');
    // empty secret keeps the old one
    const again = await h.service.credentials.put('pancake', { pos_api_key: '' });
    expect(again.ok).toBe(true);
    expect(h.service.credentials.loadValues('pancake')?.pos_api_key).toBe('pk-secret-9876');
    expect(s.grantedTo).toEqual([{ agentId: 'agent-a', grant: 'read' }]);
    h.service.credentials.remove('pancake');
    expect(h.service.credentials.get('pancake')!.status).toBe('not_configured');
  });

  it('rejects when required fields are missing', async () => {
    h = makeHarness();
    const res = await h.service.credentials.put('botcake', {});
    expect(res).toMatchObject({ ok: false, status: 400 });
  });
});

describe('runner gate', () => {
  it('read grant runs orders list and logs the command name only', async () => {
    h = makeHarness({ pancake: 'read' });
    await h.connectPancake();
    const r = await call('orders list', '--limit 3');
    expect(r.ok).toBe(true);
    const rows = h.db.prepare('SELECT command, access, ok, task_id FROM integration_calls').all();
    expect(rows).toEqual([{ command: 'orders list', access: 'read', ok: 1, task_id: 1 }]);
  });

  it('write command is denied under a read grant; unconfigured and no-grant cases', async () => {
    h = makeHarness({ pancake: 'read' });
    expect(await call('orders list')).toMatchObject({ ok: false, code: 'not_configured' });
    await h.connectPancake();
    expect(await call('orders set-status', '5 1')).toMatchObject({ ok: false, code: 'denied' });
    expect(await call('nope')).toMatchObject({ ok: false, code: 'usage' });
    expect(await h.service.runner.call({ agentId: 'ghost', integration: 'pancake', command: 'orders list' })).toMatchObject({ ok: false, code: 'denied' });
    expect(await h.service.runner.call({ agentId: 'agent-a', integration: 'zzz', command: 'x' })).toMatchObject({ ok: false, code: 'usage' });
    expect(h.fetchCalls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('runRead: module code runs read commands without a grant, never writes', async () => {
    h = makeHarness();
    const read = (line: string) => h.service.runner.runRead({ integrationId: 'pancake', commandLine: line, actor: 'module:finance' });
    await expect(read('orders list')).rejects.toThrow();
    await h.connectPancake();
    await expect(read('orders list --limit 3')).resolves.toBeDefined();
    await expect(read('orders set-status 5 1')).rejects.toThrow(/lệnh ghi/);
    expect(h.fetchCalls.some((c) => c.method === 'PUT')).toBe(false);
    const rows = h.db.prepare("SELECT agent_id, command, ok FROM integration_calls WHERE command = 'orders list'").all();
    expect(rows).toEqual([{ agent_id: 'module:finance', command: 'orders list', ok: 1 }]);
  });

  it('tools() lists only allowed commands', async () => {
    h = makeHarness({ pancake: 'read' });
    const names = h.service.runner.tools('agent-a').map((t) => t.name);
    expect(names).toContain('pancake__orders_list');
    expect(names).toContain('pancake__products_low_stock');
    expect(names).not.toContain('pancake__orders_set_status');
    expect(names.every((n) => n.startsWith('pancake__'))).toBe(true);
    expect(h.service.runner.tools('ghost')).toEqual([]);
  });

  it('enforces the hourly budget', async () => {
    h = makeHarness({ pancake: 'read' });
    await h.connectPancake();
    const ins = h.db.prepare("INSERT INTO integration_calls (integration_id, agent_id, command, access, ok, created_at) VALUES ('pancake','agent-a','orders list','read',1,?)");
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 600; i++) ins.run(now);
    expect(await call('orders list')).toMatchObject({ ok: false, code: 'rate_limited' });
  });

  it('scrubs credential values from errors', async () => {
    h = makeHarness({ pancake: 'read' });
    await h.connectPancake();
    const failing = new Response('{"error":"bad pk-secret-9876"}', { status: 500 });
    (globalThis.fetch as unknown as { mockResolvedValueOnce(r: Response): void }).mockResolvedValueOnce(failing);
    const r = await call('orders list');
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('pk-secret-9876');
  });
});

describe('approvals', () => {
  it('ask grant: write files an approval, approve runs it once and requeues the task', async () => {
    h = makeHarness({ pancake: 'ask' });
    await h.connectPancake();
    const task = h.finishedTask();
    const r = await call('orders set-status', '5 1', task.id);
    expect(r).toMatchObject({ ok: false, code: 'approval_pending' });
    const id = (r as { approvalId: string }).approvalId;
    expect((r as { message: string }).message).toContain(`mã ${id}`);
    expect(h.fetchCalls.some((c) => c.method === 'PUT')).toBe(false);

    // identical request reuses the id
    const again = await call('orders set-status', '5 1', task.id);
    expect((again as { approvalId: string }).approvalId).toBe(id);
    expect(h.service.approvals.list('pending')).toHaveLength(1);

    const item = h.attention.list().find((i) => i.key === `integration:approval:${id}`);
    expect(item).toMatchObject({ kind: 'module', link: '/connections?tab=approvals', severity: 'warn', taskId: task.id });

    const done = await h.service.approvals.approve(id);
    expect(done.status).toBe('approved');
    expect(done.result).toBeDefined();
    expect(h.fetchCalls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(h.attention.list().some((i) => i.key === `integration:approval:${id}`)).toBe(false);
    const comments = h.comments.list(task.id);
    expect(comments.at(-1)!.body).toContain('đã chạy MỘT lần');
    expect(h.tasks.require(task.id)).toMatchObject({ status: 'queued', trigger: 'commented' });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'integration.write'").get()).toEqual({ n: 1 });
    await expect(h.service.approvals.approve(id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('reject comments and requeues without running', async () => {
    h = makeHarness({ pancake: 'ask' });
    await h.connectPancake();
    const task = h.finishedTask();
    const r = await call('orders set-status', '5 1', task.id);
    const rej = h.service.approvals.reject((r as { approvalId: string }).approvalId);
    expect(rej.status).toBe('rejected');
    expect(h.fetchCalls.some((c) => c.method === 'PUT')).toBe(false);
    expect(h.comments.list(task.id).at(-1)!.body).toContain('TỪ CHỐI');
    expect(h.tasks.require(task.id).status).toBe('queued');
  });

  it('destructive set-status (cancel) under write still asks; always=true adds a trust rule', async () => {
    h = makeHarness({ pancake: 'write' });
    await h.connectPancake();
    const task = h.finishedTask();
    expect(await call('orders set-status', '5 1', task.id)).toMatchObject({ ok: true }); // plain write runs
    const r = await call('orders set-status', '5 6', task.id);
    expect(r).toMatchObject({ ok: false, code: 'approval_pending' });
    const putsBefore = h.fetchCalls.filter((c) => c.method === 'PUT').length;
    await h.service.approvals.approve((r as { approvalId: string }).approvalId, { always: true });
    expect(h.fetchCalls.filter((c) => c.method === 'PUT').length).toBe(putsBefore + 1);
    // the identical call now runs without asking; a different one still asks
    expect(await call('orders set-status', '5 6', task.id)).toMatchObject({ ok: true });
    expect(await call('orders set-status', '7 6', task.id)).toMatchObject({ code: 'approval_pending' });
  });

  it('per-command ask override and allow override', async () => {
    h = makeHarness({ pancake: { grant: 'write', ask: ['orders set-status'] } });
    await h.connectPancake();
    expect(await call('orders set-status', '5 1')).toMatchObject({ code: 'approval_pending' });
    h.cleanup();
    h = makeHarness({ pancake: { grant: 'ask', allow: ['orders set-status'] } });
    await h.connectPancake();
    expect(await call('orders set-status', '5 1')).toMatchObject({ ok: true });
  });

  it('revoked grant: an old approval cannot run', async () => {
    h = makeHarness({ pancake: 'ask' });
    await h.connectPancake();
    const r = await call('orders set-status', '5 1');
    h.service.grants.set('agent-a', { pancake: 'read' });
    const done = await h.service.approvals.approve((r as { approvalId: string }).approvalId);
    expect(done.status).toBe('failed');
    expect(done.error).toBeTruthy();
    expect(h.fetchCalls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('survives a missing task (no comment, no crash)', async () => {
    h = makeHarness({ pancake: 'ask' });
    await h.connectPancake();
    const r = await h.service.runner.call({ agentId: 'agent-a', taskId: 9999, integration: 'pancake', command: 'orders set-status', args: '5 1' });
    const done = await h.service.approvals.approve((r as { approvalId: string }).approvalId);
    expect(done.status).toBe('approved');
  });
});

describe('agent grants', () => {
  it('set writes agent.yaml through the registry and reads back', () => {
    h = makeHarness();
    expect(h.service.grants.get('agent-a')).toEqual({});
    expect(h.service.grants.set('agent-a', { pancake: { grant: 'ask', allow: ['orders set-status'] } })).toEqual({ grants: { pancake: { grant: 'ask', allow: ['orders set-status'] } } });
    h.agents.reload();
    expect(h.agents.require('agent-a').access.integrations).toEqual({ pancake: { grant: 'ask', allow: ['orders set-status'] } });
    expect(h.service.grants.set('agent-a', { pancake: 'maybe' })).toHaveProperty('error');
    expect(h.service.grants.get('ghost')).toBeUndefined();
  });
});
