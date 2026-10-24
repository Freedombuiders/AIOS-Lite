import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  return { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'kol-spend-')) };
});
vi.mock('./config.js', async (orig) => ({ ...(await orig<typeof import('./config.js')>()), STORE_DIR: store.dir, GOOGLE_API_KEY: '' }));

import fs from 'fs';

import { _initTestDatabase } from './test-db.js';
import { _reset as resetKillSwitches } from './compat.js';
import { KolError, kolDb, nowSec, saveSettings } from './core.js';
import { createPersona, updatePersona } from './personas.js';
import { admission, inflightUsd, personaSpendSince, recordSpend, spendByDay, spendSummary } from './spend.js';

function expectKolError(fn: () => unknown, status: number, code?: string): KolError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(KolError);
    expect((err as KolError).status).toBe(status);
    if (code) expect((err as KolError).code).toBe(code);
    return err as KolError;
  }
  throw new Error('expected a KolError');
}

const spend = (personaId: string, usd: number, extra: Partial<Parameters<typeof recordSpend>[0]> = {}) =>
  recordSpend({ personaId, generationId: null, provider: 'gemini', model: 'gemini-3-pro-image', kind: 'image', costUsd: usd, costStatus: 'estimated', requestedBy: 'owner', ...extra });

function queueGeneration(personaId: string, estimate: number, status = 'queued', requestedBy = 'owner'): string {
  const id = `g-${Math.random().toString(36).slice(2)}`;
  kolDb().prepare(
    `INSERT INTO kol_generations (id, persona_id, kind, mode, status, provider, model, estimate_usd, requested_by, created_at)
     VALUES (?, ?, 'image', 'compose', ?, 'gemini', 'gemini-3-pro-image', ?, ?, ?)`,
  ).run(id, personaId, status, estimate, requestedBy, nowSec());
  return id;
}

let personaId: string;

beforeEach(() => {
  _initTestDatabase();
  personaId = createPersona({ name: 'Mia' }).id;
  saveSettings({ dailyCapUsd: 1, monthlyCapUsd: 5 });
});

afterEach(() => {
  delete process.env.KOL_GENERATE_ENABLED;
  resetKillSwitches();
});

afterAll(() => fs.rmSync(store.dir, { recursive: true, force: true }));

describe('admission', () => {
  it('lets a request through under every cap', () => {
    expect(() => admission(personaId, 0.5)).not.toThrow();
  });

  it('refuses with 409 when the kill switch is off', () => {
    process.env.KOL_GENERATE_ENABLED = 'false';
    resetKillSwitches();
    const e = expectKolError(() => admission(personaId, 0.01), 409, 'kill_switch');
    expect(e.message).toContain('Cho phép tạo ảnh/video');
  });

  it('refuses with 409 when the studio is switched off', () => {
    saveSettings({ enabled: false });
    expectKolError(() => admission(personaId, 0.01), 409, 'disabled');
  });

  it('refuses with 402 over the daily cap, counting recorded spend', () => {
    spend(personaId, 0.8);
    const e = expectKolError(() => admission(personaId, 0.3), 402, 'daily_cap');
    expect(e.message).toContain('hạn mức ngày');
    expect(() => admission(personaId, 0.1)).not.toThrow();
  });

  it('counts queued and running jobs that have not recorded spend yet', () => {
    queueGeneration(personaId, 0.7);
    queueGeneration(personaId, 0.2, 'running');
    queueGeneration(personaId, 5, 'failed');
    expect(inflightUsd()).toBeCloseTo(0.9, 6);
    expectKolError(() => admission(personaId, 0.2), 402, 'daily_cap');
  });

  it('does not double count a running job that already recorded part of its cost', () => {
    const g = queueGeneration(personaId, 0.5, 'running');
    spend(personaId, 0.3, { generationId: g });
    expect(inflightUsd()).toBeCloseTo(0.2, 6);
  });

  it('refuses with 402 over the monthly cap', () => {
    saveSettings({ dailyCapUsd: 100, monthlyCapUsd: 1 });
    kolDb().prepare(`INSERT INTO kol_spend (persona_id, provider, model, kind, cost_usd, created_at) VALUES (?, 'gemini', 'm', 'image', 0.9, ?)`)
      .run(personaId, nowSec() - 60);
    expectKolError(() => admission(personaId, 0.2), 402, 'monthly_cap');
  });

  it("refuses with 402 over the persona's monthly cap", () => {
    saveSettings({ dailyCapUsd: 100, monthlyCapUsd: 100 });
    updatePersona(personaId, { monthlyCapUsd: 0.5 });
    spend(personaId, 0.4);
    const e = expectKolError(() => admission(personaId, 0.2), 402, 'persona_cap');
    expect(e.message).toContain('Mia');
    const other = createPersona({ name: 'Lan' }).id;
    expect(() => admission(other, 0.2)).not.toThrow();
  });

});

describe('ledger', () => {
  it('records every row in kol_spend', () => {
    spend(personaId, 0.134, { costStatus: 'reported', provider: 'fal', model: 'fal-ai/nano-banana-pro/edit' });
    const k = kolDb().prepare('SELECT * FROM kol_spend').get() as Record<string, unknown>;
    expect(k).toMatchObject({ persona_id: personaId, cost_usd: 0.134, cost_status: 'reported', kind: 'image' });
  });

  it('summarises today and this month', () => {
    spend(personaId, 0.25);
    spend(personaId, 0.5);
    expect(spendSummary()).toEqual({ todayUsd: 0.75, monthUsd: 0.75, dailyCapUsd: 1, monthlyCapUsd: 5 });
  });

  it("reports a persona's spend since a time, by requester, including unfinished jobs", () => {
    spend(personaId, 0.3, { requestedBy: 'autopilot' });
    spend(personaId, 0.2, { requestedBy: 'owner' });
    queueGeneration(personaId, 0.1, 'queued', 'autopilot');
    const since = nowSec() - 3600;
    expect(personaSpendSince(personaId, since)).toBeCloseTo(0.6, 6);
    expect(personaSpendSince(personaId, since, 'autopilot')).toBeCloseTo(0.4, 6);
    expect(personaSpendSince(personaId, nowSec() + 10)).toBe(0);
  });

  it('lists spend per local day with zero days filled, oldest first', () => {
    spend(personaId, 0.4);
    const days = spendByDay(personaId, 7);
    expect(days).toHaveLength(7);
    expect(days[6].usd).toBeCloseTo(0.4, 6);
    expect(days.slice(0, 6).every((d) => d.usd === 0)).toBe(true);
    expect(days[0].day < days[6].day).toBe(true);
  });
});
