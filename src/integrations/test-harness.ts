// Shared by integration tests: real services on an in-memory DB + a temp agents dir, and a fake Pancake over global fetch.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { createAuditService } from '../access/audit.js';
import { createAgentRegistry } from '../agents/registry.js';
import { createCipher } from '../core/crypto.js';
import { migrateCore, openDb } from '../core/db.js';
import { createEventBus } from '../core/events.js';
import { createLogger } from '../core/log.js';
import type { IntegrationGrantSetting } from '../core/types.js';
import { createAttentionService } from '../work/attention.js';
import { createCommentService } from '../work/comments.js';
import { createRunService } from '../work/runs.js';
import { createTaskService } from '../work/tasks.js';
import { createIntegrationService } from './service.js';

export interface FetchCall { method: string; path: string; body?: string }

/** Fake Pancake POS: shops, orders list/get, order update. Records every call. */
export function fakePancakeFetch(calls: FetchCall[] = []) {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const impl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    if (url.pathname.endsWith('/shops')) return json({ success: true, shops: [{ id: 1, name: 'Shop A', preferred_shop: true }] });
    if (method === 'PUT') return json({ success: true, data: { id: 5, status: 1 } });
    return json({ success: true, data: [], total_entries: 0 });
  });
  return { impl, calls };
}

export function makeHarness(grants: Record<string, IntegrationGrantSetting> = {}, opts: { secret?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-int-'));
  const agentsDir = path.join(root, 'agents');
  const yaml = `name: Agent A\nruntime: mock\n${Object.keys(grants).length ? `access:\n  integrations: ${JSON.stringify(grants)}\n` : ''}`;
  fs.mkdirSync(path.join(agentsDir, 'agent-a'), { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'agent-a', 'agent.yaml'), yaml);
  const agents = createAgentRegistry({ agentsDir, workspacesDir: path.join(root, 'ws') });

  const db = openDb(':memory:');
  migrateCore(db);
  const bus = createEventBus();
  const log = createLogger({ level: 'silent' });
  const tasks = createTaskService({ db, bus, agents });
  const runs = createRunService({ db, bus });
  const comments = createCommentService({ db, bus, tasks });
  const attention = createAttentionService({ db, bus, tasks, runs, agents });
  const audit = createAuditService({ db, bus });
  const events: unknown[] = [];
  bus.on('*', (e) => events.push(e));
  const service = createIntegrationService({
    db, cipher: createCipher(opts.secret ?? 'test-secret'), agents, bus, comments, attention, audit, log,
    connections: { secret: () => undefined }, dataDir: path.join(root, 'data'),
  });

  const fake = fakePancakeFetch();
  vi.stubGlobal('fetch', fake.impl);

  /** A task that already finished, so a comment can requeue it. */
  const finishedTask = (agentId = 'agent-a') => {
    const t = tasks.create({ prompt: 'làm việc', agentId });
    return tasks.update(t.id, { status: 'review' });
  };

  return {
    root, db, bus, agents, tasks, comments, attention, audit, service, events, fetchCalls: fake.calls, finishedTask,
    connectPancake: () => service.credentials.put('pancake', { pos_api_key: 'pk-secret-9876' }),
    cleanup: () => { vi.unstubAllGlobals(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}
