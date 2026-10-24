import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  process.env.VIDEO_EDIT_FFMPEG = '/nonexistent/ffmpeg-for-tests';
  return { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'kol-consistency-')) };
});
vi.mock('./config.js', async (orig) => ({ ...(await orig<typeof import('./config.js')>()), STORE_DIR: store.dir, GOOGLE_API_KEY: '' }));

import fs from 'fs';
import path from 'path';

import { _initTestDatabase } from './test-db.js';
import { getAsset, insertAsset } from './assets.js';
import { _setJudgeForTests, checkAssetConsistency, verdictFor, type JudgeFn } from './consistency.js';
import { kolDb, resolveKolFile } from './core.js';
import { createPersona, updatePersona } from './personas.js';
import { ProviderError } from './providers/types.js';
import { addRefFromAsset, addRefFromUpload } from './refs.js';

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const tempPng = () => {
  const f = path.join(fs.mkdtempSync(path.join(store.dir, 'up-')), 'x.png');
  fs.writeFileSync(f, PNG_1x1);
  return f;
};

function imageAsset(personaId: string, id: string): void {
  const rel = `assets/${personaId}/2026-10/${id}.png`;
  fs.mkdirSync(path.dirname(resolveKolFile(rel)), { recursive: true });
  fs.writeFileSync(resolveKolFile(rel), PNG_1x1);
  insertAsset({ id, personaId, generationId: null, kind: 'image', file: rel, thumb: null, mime: 'image/png', width: 1, height: 1, durationSec: null, bytes: PNG_1x1.length, model: 'm', provider: 'gemini', costUsd: 0, prompt: '' });
}

const judge = (score: number, samePerson = true, issues: string[] = []): JudgeFn => vi.fn(async () => ({ score, samePerson, issues, inputTokens: 3000, outputTokens: 100 }));

beforeEach(() => {
  _initTestDatabase();
});

afterEach(() => _setJudgeForTests(null));

afterAll(() => fs.rmSync(store.dir, { recursive: true, force: true }));

describe('verdictFor', () => {
  it.each([
    [95, 80, 'pass'], [80, 80, 'pass'], [79, 80, 'warn'], [65, 80, 'warn'], [64, 80, 'fail'], [0, 80, 'fail'], [90, 95, 'warn'], [100, 100, 'pass'],
  ])('score %i with threshold %i → %s', (score, threshold, verdict) => {
    expect(verdictFor(score, threshold)).toBe(verdict);
  });

  it('never passes an image the judge calls a different person', () => {
    expect(verdictFor(92, 80, false)).toBe('warn');
    expect(verdictFor(40, 80, false)).toBe('fail');
  });
});

describe('checkAssetConsistency', () => {
  it('scores against the anchors, stores the verdict and records the judge cost', async () => {
    const p = createPersona({ name: 'Mia', appearance: { marks: 'mole under left eye' } as never });
    await addRefFromUpload(p.id, tempPng(), { kind: 'anchor' });
    imageAsset(p.id, 'img1');
    const fn = judge(91, true, []);
    _setJudgeForTests(fn);
    const c = await checkAssetConsistency('img1');
    expect(c).toMatchObject({ score: 91, verdict: 'pass' });
    expect(c.notes).toContain('Khớp danh tính');
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ personaName: 'Mia', marks: 'mole under left eye', model: 'gemini-2.5-flash' }));
    expect(getAsset('img1')?.consistency).toMatchObject({ score: 91, verdict: 'pass' });
    const spend = kolDb().prepare("SELECT * FROM kol_spend WHERE kind = 'judge'").get() as { cost_usd: number; provider: string };
    expect(spend.provider).toBe('gemini');
    expect(spend.cost_usd).toBeCloseTo((3000 * 0.3 + 100 * 2.5) / 1e6, 9);
  });

  it('warns and fails by threshold, and auto-rejects drift when the persona asks for it', async () => {
    const p = createPersona({ name: 'Mia' });
    await addRefFromUpload(p.id, tempPng(), { kind: 'anchor' });
    imageAsset(p.id, 'warn1');
    imageAsset(p.id, 'fail1');
    _setJudgeForTests(judge(70, true, ['mũi to hơn']));
    expect(await checkAssetConsistency('warn1')).toMatchObject({ verdict: 'warn' });
    expect(getAsset('warn1')?.consistency.notes).toContain('mũi to hơn');
    updatePersona(p.id, { autoRejectDrift: true });
    _setJudgeForTests(judge(40, false, ['khác người']));
    expect(await checkAssetConsistency('fail1')).toMatchObject({ verdict: 'fail', score: 40 });
    expect(getAsset('fail1')?.status).toBe('rejected');
    expect(getAsset('warn1')?.status).toBe('new');
  });

  it('skips without anchors, without a judge, or when the judge fails — never throws', async () => {
    const p = createPersona({ name: 'Mia' });
    imageAsset(p.id, 'a1');
    _setJudgeForTests(judge(99));
    expect(await checkAssetConsistency('a1')).toMatchObject({ verdict: 'skipped', score: null });
    expect(getAsset('a1')?.consistency.notes).toContain('Chưa có ảnh gốc');

    await addRefFromUpload(p.id, tempPng(), { kind: 'anchor' });
    _setJudgeForTests(judge(99), false);
    expect((await checkAssetConsistency('a1')).notes).toContain('GOOGLE_API_KEY');

    _setJudgeForTests(vi.fn(async () => { throw new ProviderError('rate', 'gemini: rate limited', 429); }));
    const c = await checkAssetConsistency('a1');
    expect(c.verdict).toBe('skipped');
    expect(c.notes).toContain('Không chấm được');
    expect(kolDb().prepare("SELECT COUNT(*) AS n FROM kol_spend WHERE kind = 'judge'").get()).toEqual({ n: 0 });
  });

  it('does not compare an image with a reference copied from itself', async () => {
    const p = createPersona({ name: 'Mia' });
    imageAsset(p.id, 'self');
    await addRefFromAsset(p.id, 'self', 'anchor');
    _setJudgeForTests(judge(100));
    expect((await checkAssetConsistency('self')).notes).toContain('Chưa có ảnh gốc');
  });
});

describe('signature look', () => {
  it('caps a pass at warn when the signature look is clearly missing', async () => {
    const { withSignature } = await import('./consistency.js');
    expect(withSignature('pass', false)).toBe('warn');
    expect(withSignature('pass', null)).toBe('pass');
    expect(withSignature('pass', true)).toBe('pass');
    expect(withSignature('fail', false)).toBe('fail');
  });

  it('asks the judge about the signature look only when the persona has one, and parses the answer', async () => {
    const { buildJudgePrompt, parseJudgeJson } = await import('./providers/gemini.js');
    expect(buildJudgePrompt('Mia', '', 2, 'round gold-rim glasses')).toContain('signature_present');
    expect(buildJudgePrompt('Mia', '', 2, '')).not.toContain('signature_present');
    expect(parseJudgeJson('{"score":95,"same_person":true,"issues":[],"signature_present":false}')?.signaturePresent).toBe(false);
    expect(parseJudgeJson('{"score":95,"same_person":true,"issues":[]}')?.signaturePresent).toBeNull();
  });
});

