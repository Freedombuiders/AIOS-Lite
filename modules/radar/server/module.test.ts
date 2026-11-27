import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModuleContext } from '../../../src/modules/sdk.js';
import { runRadarAgent } from './agent-turn.js';
import { X_OFF_NOTE, collectVnChatter, collectX, defaultExecGrok, xReaderAvailable } from './collectors/x-grok.js';
import { bindTestContext } from './context.js';
import { saveReport } from './store.js';
import { summaryForAgent, latestSummary } from './summary.js';
import { _initTestDatabase, settingValues } from './test-db.js';
import { tick } from './worker.js';
import { getDb } from '../../../src/modules/compat/db.js';
import type { ReportPayload } from './types.js';
import createRadar from './index.js';

const payload = (date: string): ReportPayload => ({
  version: 1, layer: 'nganh', layerLabel: 'Ngành nghề', slotLabel: 'phiên 20h', date, dateLabel: '17/10/2026', weekday: 'Thứ Bảy',
  owner: '', generatedAt: new Date().toISOString(),
  sessions: [{
    key: 's1', label: 'Phiên 20h', scan: { when: '', sources: '', top: '' }, topics: [], communities: [], items: [],
    pains: [{ id: 'P001', rank: 1, title: 'Giá ChatGPT Plus cao', detail: '', professions: [], topics: [], itemIds: [], isNew: true, times: 1, firstSeen: date }],
    quotes: [], buySignals: [], tools: [], ideas: [], fears: [], professions: [], missingProfessions: [], competitors: [], otherAdvertisers: [],
    gap: null, trends: [], dataNotes: [],
  }],
} as unknown as ReportPayload);

function ctxWith(agents: Partial<ModuleContext['agents']>): ModuleContext {
  return {
    id: 'radar', db: getDb(), dataDir: '/tmp/radar-test',
    settings: { get: (k: string, f: unknown) => settingValues.get(k) ?? f, set: (k: string, v: unknown) => { settingValues.set(k, v); } },
    agents, log: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as ModuleContext;
}

beforeEach(() => _initTestDatabase());

describe('radar agent turns go through runLean', () => {
  it('runRadarAgent sends system + prompt to the analyst and maps the result', async () => {
    const runLean = vi.fn(async () => ({ ok: true, output: '{"a":1}', taskId: 5, runId: 7, usage: { costUsd: 0.03 } }));
    bindTestContext(ctxWith({ runLean }));
    const res = await runRadarAgent({ agentId: 'radar-analyst', usageKey: 'radar:vn:enrich', system: 'SYS', prompt: 'PROMPT' });
    expect(res).toMatchObject({ text: '{"a":1}', costUsd: 0.03 });
    expect(runLean).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'radar-analyst', prompt: 'SYS\n\nPROMPT' }));
  });

  it('a failed turn returns empty text and the error', async () => {
    bindTestContext(ctxWith({ runLean: vi.fn(async () => ({ ok: false, output: '', taskId: 1, runId: null, error: 'hết hạn mức' })) }));
    const res = await runRadarAgent({ agentId: 'radar-analyst', usageKey: 'k', system: 's', prompt: 'p' });
    expect(res.text).toBe('');
    expect(res.error).toContain('hết hạn mức');
  });

  it('GenBot only: the default X reader is switched off with a clear message and never calls an agent', async () => {
    const runLean = vi.fn(async () => ({ ok: true, output: '{"posts":[]}', taskId: 1, runId: 1 }));
    bindTestContext(ctxWith({ runLean, get: () => ({ id: 'radar-analyst' }) as never }));
    await expect(defaultExecGrok(['-p', 'tìm bài', '--json-schema', '{"type":"object"}'], { timeoutMs: 1000 })).rejects.toThrow(X_OFF_NOTE);
    expect(runLean).not.toHaveBeenCalled();
    expect(xReaderAvailable({ deps: {} } as never)).toBe(false);
    expect(await collectVnChatter({ layer: 'world', sinceIso: '2026-10-01T00:00:00Z', log: () => {}, deps: {} } as never, 7)).toBeNull();
  });

  it('collectX still maps posts from an injected reader', async () => {
    const posts = { posts: [{ author: 'abc', text: 'AI mới', url: 'https://x.com/abc/status/123', posted_at: '2026-10-17T10:00:00Z', likes: 3 }] };
    const execGrok = vi.fn(async () => JSON.stringify(posts));
    const r = await collectX({ layer: 'world', sinceIso: '2026-10-01T00:00:00Z', log: () => {}, deps: { execGrok } } as never, ['abc'], []);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ kind: 'x', via: 'grok' });
  });
});

describe('scheduled collection honours the module setting', () => {
  it('queues nothing while `enabled` is off', () => {
    const notify = vi.fn();
    expect(tick(notify, Math.floor(Date.parse('2026-10-17T13:30:00Z') / 1000))).toEqual([]);
    expect(settingValues.get('enabled')).toBeUndefined();
  });
});

describe('latest report for the widget and for agents', () => {
  it('is empty before any report and summarises the newest after', () => {
    expect(latestSummary()).toBeNull();
    expect(summaryForAgent()).toContain('chưa có báo cáo');
    saveReport(payload('2026-10-17'));
    const s = latestSummary()!;
    expect(s).toMatchObject({ date: '2026-10-17', layer: 'nganh', newPains: 1, link: '/m/radar/2026-10-17/nganh' });
    expect(s.headline).toContain('Giá ChatGPT Plus cao');
    expect(summaryForAgent()).toContain('[mới] Giá ChatGPT Plus cao');
  });

  it('the module hands the summary to agents through agentContext and provides', async () => {
    saveReport(payload('2026-10-17'));
    const ctx = ctxWith({});
    const def = createRadar;
    const text = await def.agentContext!({ agent: {} as never, task: {} as never, scopes: ['radar.read'] }, ctx);
    expect(text).toContain('Radar thị trường');
    expect((def.provides!(ctx).latest as () => { date: string })().date).toBe('2026-10-17');
    expect(def.integrations?.map((i) => i.id)).toEqual(['apify', 'rsshub']);
  });
});
