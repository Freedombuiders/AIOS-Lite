/**
 * Identity QA: after every image, a vision model compares the new picture with
 * the persona's anchors and returns 0–100. score ≥ threshold → pass,
 * ≥ threshold − 15 → warn, else fail; autoRejectDrift rejects fails. A judge
 * failure gives verdict 'skipped' with a note and never fails the job. The judge
 * call is cheap and its cost is recorded.
 */

import { kolDb, loadSettings } from './core.js';
import { getAssetFile, getAssetRow, setAssetConsistency } from './assets.js';
import { judgeCostUsd } from './pricing.js';
import { chatgptJudgeConfigured, judgeIdentityChatgpt } from './providers/chatgpt.js';
import { judgeConfigured, judgeIdentity, type JudgeRequest, type JudgeResult } from './providers/gemini.js';
import { providerErrorVi } from './providers/types.js';
import { judgeAnchors } from './refs.js';
import { recordSpend } from './spend.js';
import type { ConsistencyDto, ConsistencyVerdict } from './types.js';

export const WARN_BAND = 15;

/** Verdict for a score against the persona's threshold. */
export function verdictFor(score: number, threshold: number, samePerson = true): Exclude<ConsistencyVerdict, 'skipped'> {
  let v: Exclude<ConsistencyVerdict, 'skipped'> = score >= threshold ? 'pass' : score >= threshold - WARN_BAND ? 'warn' : 'fail';
  // The judge saying "not the same person" never lets an image pass.
  if (!samePerson && v === 'pass') v = 'warn';
  return v;
}

export type JudgeFn = (req: JudgeRequest) => Promise<JudgeResult>;

let judgeOverride: { fn: JudgeFn; configured: boolean } | null = null;

/** @internal tests only. */
export function _setJudgeForTests(fn: JudgeFn | null, configured = true): void {
  judgeOverride = fn ? { fn, configured } : null;
}

export type JudgeProvider = 'gemini' | 'chatgpt';

/**
 * The judge settings.judgeModel resolves to: 'chatgpt' → Codex on the ChatGPT plan; a Gemini id →
 * Gemini; 'auto' → Gemini 2.5 Flash when GOOGLE_API_KEY exists (fast, ~$0.001), else ChatGPT when
 * Codex is signed in (free on the plan, ~7 s). Null when neither is available.
 */
export function resolveJudge(judgeModel: string): { provider: JudgeProvider; model: string } | null {
  const m = (judgeModel || 'auto').trim();
  if (m === 'chatgpt') return chatgptJudgeConfigured() ? { provider: 'chatgpt', model: 'chatgpt' } : null;
  if (m !== 'auto') return judgeConfigured() ? { provider: 'gemini', model: m } : null;
  if (judgeConfigured()) return { provider: 'gemini', model: 'gemini-2.5-flash' };
  if (chatgptJudgeConfigured()) return { provider: 'chatgpt', model: 'chatgpt' };
  return null;
}

/** The judge in force: the test seam when set (a Gemini judge), else the resolved setting. */
function currentJudge(setting: string): { provider: JudgeProvider; model: string } | null {
  if (judgeOverride) {
    const m = setting === 'auto' ? 'gemini-2.5-flash' : setting;
    return { provider: m === 'chatgpt' ? 'chatgpt' : 'gemini', model: m };
  }
  return resolveJudge(setting);
}

/** The resolved judge model id ('chatgpt' or a Gemini id) for estimates, or the raw setting when none resolves. */
export function activeJudgeModel(): string {
  const setting = loadSettings().judgeModel;
  return currentJudge(setting)?.model ?? setting;
}

export function judgeIsConfigured(): boolean {
  if (judgeOverride) return judgeOverride.configured;
  try { return resolveJudge(loadSettings().judgeModel) !== null; } catch { return judgeConfigured(); }
}

function notesFor(verdict: ConsistencyVerdict, score: number, issues: string[], missingSignature = ''): string {
  const head = verdict === 'fail' ? `Lệch mặt rõ (${score}/100).`
    : missingSignature ? `Khớp mặt (${score}/100) nhưng thiếu phong cách nhận diện: ${missingSignature}.`
      : verdict === 'pass' ? `Khớp danh tính (${score}/100).` : `Hơi lệch mặt (${score}/100).`;
  return issues.length ? `${head} ${issues.join('; ')}` : head;
}

/**
 * True when the judge declined to compare (some models refuse anything that looks like face
 * matching) instead of judging: a zero score with "can't verify"-style text. Such an answer must
 * never count as drift — it would reject a good image.
 */
export function isJudgeRefusal(r: Pick<JudgeResult, 'score' | 'samePerson' | 'issues'>): boolean {
  if (r.samePerson || r.score > 5) return false;
  return r.issues.some((i) => /\b(can['’]?t|cannot|unable|not able|won['’]?t|refuse|not permitted|identify real)\b/i.test(i));
}

/** A clearly missing signature look (glasses, earrings…) caps the verdict at 'warn'. */
export function withSignature(verdict: Exclude<ConsistencyVerdict, 'skipped'>, signaturePresent: boolean | null | undefined): Exclude<ConsistencyVerdict, 'skipped'> {
  return signaturePresent === false && verdict === 'pass' ? 'warn' : verdict;
}

/** A judge verdict, or why there is none (Vietnamese). */
type Judged = { ok: true; score: number; verdict: Exclude<ConsistencyVerdict, 'skipped'>; notes: string; autoReject: boolean; realism: number | null } | { ok: false; notes: string };

/**
 * Compares one image file with a persona's anchors. Never throws. The judge's cost goes to the
 * ledger under `spendId` (the persona, or the library account for catalog photos).
 */
async function judgeAgainstAnchors(personaId: string, candidate: { path: string; mime: string }, opts: {
  excludeAssetId?: string; spendId: string; generationId: string | null; requestedBy: string;
}): Promise<Judged> {
  try {
    const persona = kolDb().prepare('SELECT name, appearance_json, identity_source, consistency_threshold, auto_reject_drift FROM kol_personas WHERE id = ?')
      .get(personaId) as { name: string; appearance_json: string; identity_source: string; consistency_threshold: number; auto_reject_drift: number } | undefined;
    if (!persona) return { ok: false, notes: 'Không tìm thấy KOL.' };
    const anchors = judgeAnchors(personaId, 3, opts.excludeAssetId);
    if (anchors.length === 0) return { ok: false, notes: 'Chưa có ảnh gốc (anchor) để so sánh.' };
    if (!judgeIsConfigured()) return { ok: false, notes: 'Chưa có model chấm độ giống: thêm GOOGLE_API_KEY hoặc đăng nhập Codex bằng ChatGPT (`codex login`).' };

    const settings = loadSettings();
    const resolved = currentJudge(settings.judgeModel) ?? { provider: 'gemini' as const, model: settings.judgeModel };
    let marks = '';
    let signature = '';
    try {
      const a = JSON.parse(persona.appearance_json) as { marks?: string; signatureLook?: string };
      marks = String(a.marks ?? '');
      signature = String(a.signatureLook ?? '');
    } catch { /* none */ }
    const judge = judgeOverride?.fn ?? (resolved.provider === 'chatgpt' ? judgeIdentityChatgpt : judgeIdentity);
    let result: JudgeResult;
    try {
      result = await judge({
        model: resolved.model, personaName: persona.name, marks, signature, realPerson: persona.identity_source === 'licensed', anchors, candidate,
      });
    } catch (err) {
      return { ok: false, notes: `Không chấm được độ giống: ${providerErrorVi(err)}` };
    }
    try {
      recordSpend({
        personaId: opts.spendId, generationId: opts.generationId, provider: resolved.provider, model: resolved.model,
        kind: 'judge', costUsd: judgeCostUsd(resolved.model, result.inputTokens, result.outputTokens), costStatus: 'estimated',
        requestedBy: opts.requestedBy,
      });
    } catch { /* the ledger must not hide the verdict */ }
    if (isJudgeRefusal(result)) {
      return { ok: false, notes: `Model chấm (${resolved.provider === 'chatgpt' ? `ChatGPT ${settings.codexModel}` : resolved.model}) từ chối so khuôn mặt. Chọn model chấm khác ở KOL Studio › Cài đặt rồi bấm “Kiểm tra lại khuôn mặt”.` };
    }
    const verdict = withSignature(verdictFor(result.score, persona.consistency_threshold, result.samePerson), result.signaturePresent);
    const notes = notesFor(verdict, result.score, result.issues, result.signaturePresent === false ? signature.trim() : '');
    return { ok: true, score: result.score, verdict, notes, autoReject: verdict === 'fail' && persona.auto_reject_drift === 1, realism: result.realism ?? null };
  } catch (err) {
    return { ok: false, notes: `Không chấm được độ giống: ${(err as Error).message ?? 'lỗi không xác định'}`.slice(0, 300) };
  }
}

/**
 * Judges one image asset against its persona's anchors and stores the verdict.
 * Never throws: problems become verdict 'skipped' with a Vietnamese note.
 */
export async function checkAssetConsistency(assetId: string, opts: { generationId?: string | null; requestedBy?: string } = {}): Promise<ConsistencyDto> {
  const skipped = (notes: string): ConsistencyDto => {
    try { setAssetConsistency(assetId, { score: null, verdict: 'skipped', notes }); } catch { /* asset gone */ }
    return { score: null, verdict: 'skipped', notes };
  };
  try {
    const row = getAssetRow(assetId);
    if (!row) return { score: null, verdict: 'skipped', notes: 'Không tìm thấy ảnh.' };
    if (row.kind !== 'image') return skipped('Chỉ chấm độ giống cho ảnh.');
    const file = getAssetFile(assetId);
    if (!file) return skipped('Tệp ảnh không còn trên máy.');
    const r = await judgeAgainstAnchors(row.persona_id, { path: file.abs, mime: file.mime }, {
      excludeAssetId: assetId, spendId: row.persona_id, generationId: opts.generationId ?? row.generation_id, requestedBy: opts.requestedBy ?? 'owner',
    });
    if (!r.ok) return skipped(r.notes);
    setAssetConsistency(assetId, { score: r.score, verdict: r.verdict, notes: r.notes, reject: r.autoReject });
    return { score: r.score, verdict: r.verdict, notes: r.notes };
  } catch (err) {
    return skipped(`Không chấm được độ giống: ${(err as Error).message ?? 'lỗi không xác định'}`.slice(0, 300));
  }
}

/**
 * Judges an image file that is not a gallery asset (a KOL's catalog photo) against the persona's
 * anchors. Never throws: no verdict gives { score: null, verdict: 'skipped' }.
 */
export async function judgeImageFile(personaId: string, file: { path: string; mime: string }, opts: { spendId: string; requestedBy: string }): Promise<ConsistencyDto> {
  const r = await judgeAgainstAnchors(personaId, file, { spendId: opts.spendId, generationId: null, requestedBy: opts.requestedBy });
  return r.ok ? { score: r.score, verdict: r.verdict, notes: r.notes, realism: r.realism } : { score: null, verdict: 'skipped', notes: r.notes };
}

// ── Background queue ─────────────────────────────────────────────────
// Imports can bring dozens of images at once; judging them one after another keeps a ChatGPT
// (Codex) judge to a single turn at a time and a Gemini judge well under its rate limits.

let chain: Promise<unknown> = Promise.resolve();
let waiting = 0;

/** Queues a consistency check and returns at once. Never throws. */
export function queueConsistencyCheck(assetId: string, opts: { requestedBy?: string } = {}): void {
  waiting++;
  chain = chain
    .then(() => checkAssetConsistency(assetId, opts))
    .catch(() => undefined)
    .finally(() => { waiting--; });
}

/** Checks still waiting in the background queue. */
export function queuedConsistencyChecks(): number {
  return waiting;
}

