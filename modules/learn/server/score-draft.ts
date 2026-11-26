// Score a draft before posting against the verified lessons (da-kiem-chung, confirmed by the owner in the app).
// Posting time, format and length are checked by code. The opening type is the only thing code cannot read: one
// lean agent run classifies it, cached by the hash of the text (learn_hook_cache), and two identical requests in
// flight share one run. "Khớp x/y": y = lessons that can be checked on this draft, x = those it matches fully.
import crypto from 'node:crypto';
import type { ModuleContext } from '../../../src/modules/sdk.js';
import { untrusted } from '../../../src/modules/sdk.js';
import { cleanLine, firstJsonObject, type RunLean } from './lean.js';
import { FB_FORMAT_TO_DINH_DANG, checkRules, localClock, type PostFacts, type RuleCheck } from './lesson-rules.js';
import { DEFAULT_TZ, DINH_DANG_LABELS, MO_DAU_LABELS, VIDEO_FORMATS, wordCount } from './note-format.js';
import type { LessonView, Playbook } from './playbook.js';

export interface ScoreInput {
  text: string;
  /** marketing format (reel, video, photo, album, text, link) or a `dinh_dang` value */
  format?: string;
  /** unix seconds */
  scheduledAt?: number | null;
  hasVideo?: boolean;
  /** seconds, when the video length is known */
  videoLengthS?: number | null;
  /** timezone of the Page; default Asia/Ho_Chi_Minh */
  timezone?: string;
}

export interface ScoredLesson {
  path: string;
  title: string;
  checks: RuleCheck[];
  /** 'khop' every rule holds; 'chua-khop' one fails; 'chua-ro' some rule could not be checked */
  result: 'khop' | 'chua-khop' | 'chua-ro';
}

export interface ScoreResult {
  matched: number;
  checkable: number;
  lessons: ScoredLesson[];
  /** verified lessons without machine-checkable rules (shown, not counted) */
  unchecked: Array<{ path: string; title: string }>;
  hook: { moDau: string | null; label: string | null; source: 'cache' | 'agent' | 'none'; note: string | null };
  facts: PostFacts;
}

export interface ScoreDeps {
  db: ModuleContext['db'];
  playbook: Pick<Playbook, 'verified'>;
  agentId(): string;
  canUse(agentId: string): boolean;
  runLean: RunLean;
  log: Pick<ModuleContext['log'], 'warn'>;
  now?(): number;
}

export const MAX_TEXT = 20_000;
const MO_DAU = Object.keys(MO_DAU_LABELS);

export function textHash(text: string): string {
  return crypto.createHash('sha256').update(text.normalize('NFC').trim().replace(/\s+/g, ' ')).digest('hex');
}

export function factsOfDraft(input: ScoreInput): PostFacts {
  const f: PostFacts = {};
  const fmt = (input.format ?? '').trim();
  const dd = FB_FORMAT_TO_DINH_DANG[fmt] ?? (Object.hasOwn(DINH_DANG_LABELS, fmt) ? fmt : undefined);
  if (dd) f.dinhDang = dd;
  else if (input.hasVideo) f.dinhDang = 'video';
  if (typeof input.scheduledAt === 'number' && Number.isFinite(input.scheduledAt) && input.scheduledAt > 0) {
    const c = localClock(input.scheduledAt, input.timezone || DEFAULT_TZ);
    f.hour = c.hour;
    f.weekday = c.weekday;
  }
  if (f.dinhDang && VIDEO_FORMATS.has(f.dinhDang)) {
    if (typeof input.videoLengthS === 'number' && input.videoLengthS > 0) f.length = Math.round(input.videoLengthS);
  } else if (input.text.trim()) f.length = wordCount(input.text);
  return f;
}

export interface Scorer {
  score(input: ScoreInput): Promise<ScoreResult>;
  /** agent runs made so far (for tests and the status line) */
  runs(): number;
}

export function createScorer(deps: ScoreDeps): Scorer {
  const now = () => deps.now?.() ?? Math.floor(Date.now() / 1000);
  const inflight = new Map<string, Promise<{ moDau: string | null; source: 'cache' | 'agent' | 'none'; note: string | null }>>();
  let runs = 0;

  const cached = (hash: string) => (deps.db.prepare('SELECT mo_dau FROM learn_hook_cache WHERE hash = ?').get(hash) as { mo_dau: string } | undefined)?.mo_dau;

  async function classify(text: string): Promise<{ moDau: string | null; source: 'cache' | 'agent' | 'none'; note: string | null }> {
    const hash = textHash(text);
    const hit = cached(hash);
    if (hit !== undefined) return { moDau: MO_DAU.includes(hit) ? hit : null, source: 'cache', note: null };
    const agentId = deps.agentId().trim();
    if (!agentId) return { moDau: null, source: 'none', note: 'Chưa chọn agent nhận kiểu mở đầu (cài đặt "agent" của module Học).' };
    if (!deps.canUse(agentId)) return { moDau: null, source: 'none', note: `Agent "${agentId}" chưa có quyền đọc sổ bài học.` };
    let p = inflight.get(hash);
    if (!p) {
      p = (async () => {
        runs++;
        const r = await deps.runLean({
          agentId,
          title: 'Nhận kiểu mở đầu của bài nháp',
          prompt: `Bài nháp nằm trong ngữ cảnh module. Câu mở đầu của nó thuộc kiểu nào trong: ${MO_DAU.join(', ')}? Không kiểu nào thì "khac". Trả duy nhất JSON {"mo_dau":"…"}.`,
          moduleContext: untrusted('Bài nháp', 'bai-nhap', text.slice(0, 1500)),
          timeoutMs: 90_000,
        });
        if (!r.ok) return { moDau: null, source: 'none' as const, note: `Agent chưa trả lời được${r.error ? `: ${cleanLine(r.error, 120)}` : '.'}` };
        const j = firstJsonObject(r.output) as { mo_dau?: unknown } | undefined;
        const v = typeof j?.mo_dau === 'string' ? j.mo_dau.trim() : '';
        const moDau = MO_DAU.includes(v) ? v : 'khac';
        // only an answer is cached; a failed run is tried again next time
        deps.db.prepare('INSERT OR REPLACE INTO learn_hook_cache (hash, mo_dau, created_at) VALUES (?, ?, ?)').run(hash, moDau, now());
        return { moDau: moDau === 'khac' ? null : moDau, source: 'agent' as const, note: moDau === 'khac' ? 'Mở đầu không thuộc kiểu nào trong sổ.' : null };
      })().finally(() => inflight.delete(hash));
      inflight.set(hash, p);
    }
    return p;
  }

  return {
    runs: () => runs,
    async score(input) {
      const text = String(input.text ?? '').slice(0, MAX_TEXT);
      const lessons: LessonView[] = deps.playbook.verified().filter((l) => l.area === 'noi-dung' || l.area === null);
      const facts = factsOfDraft({ ...input, text });
      const needHook = lessons.some((l) => l.rules.moDau);
      let hook: ScoreResult['hook'] = { moDau: null, label: null, source: 'none', note: null };
      if (needHook && text.trim()) {
        try {
          const c = await classify(text);
          hook = { moDau: c.moDau, label: c.moDau ? (MO_DAU_LABELS[c.moDau] ?? c.moDau) : null, source: c.source, note: c.note };
          if (c.moDau) facts.moDau = c.moDau;
          else if (c.source !== 'none') facts.moDau = 'khac';
        } catch (e) {
          deps.log.warn({ err: (e as Error).message }, 'learn: không nhận được kiểu mở đầu');
          hook.note = 'Không nhận được kiểu mở đầu lần này.';
        }
      }
      const scored: ScoredLesson[] = [];
      const unchecked: ScoreResult['unchecked'] = [];
      for (const l of lessons) {
        const checks = checkRules(l.rules, facts);
        if (!checks.length) {
          unchecked.push({ path: l.path, title: l.title });
          continue;
        }
        const result = checks.some((c) => c.ok === false) ? 'chua-khop' : checks.every((c) => c.ok === true) ? 'khop' : 'chua-ro';
        scored.push({ path: l.path, title: l.title, checks, result });
      }
      return { matched: scored.filter((s) => s.result === 'khop').length, checkable: scored.length, lessons: scored, unchecked, hook, facts };
    },
  };
}
