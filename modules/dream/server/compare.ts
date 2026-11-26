// "Bot Đối chiếu": not a free agent. Code in this file compares a post made from a formula with the channel, and
// recomputes the formula. One lean agent turn only writes at most two sentences about the differences, into a
// managed block of the formula note; every number comes from formula-stats.ts.
//
// Trigger: learn's durable note feed (provides.postNotes.events), read with dream's own cursor (dream_state), so a
// restart catches up. A bai-dang note with `cong_thuc` that got (or changed) its 24h or 7d numbers is compared:
//   ratio = its ER ÷ median ER of the channel's OTHER posts at the same milestone; so_voi_ky_vong = ratio ÷ ky_vong
// where ky_vong is the expectation fixed when the idea was suggested (marketing lineage expected_ratio → note).
// When a formula becomes `hop`, learn.playbook.proposeFromModule writes a gia-thuyet lesson pointing at its posts.
import type { ModuleContext } from '../../../src/modules/sdk.js';
import { untrusted } from '../../../src/modules/sdk.js';
import {
  COMPARE_MILESTONES,
  comparePost,
  formulaResult,
  isCompareMilestone,
  linkSlug,
  median,
  STATE_LABELS,
  type CompareMilestone,
  type Comparison,
  type FormulaResult,
  type FormulaState,
  type PostNote,
} from './formula-stats.js';
import { FORMULA_DIR, formulaOf, formulaVideos, noteSlug, type Formula } from './formulas.js';
import { firstJsonObject, LABEL_TEXT, pickAgent } from './label.js';

export const POST_DIR = 'noi-dung/bai';
export const REMARK_BLOCK = 'doi-chieu';
const PAGE = 100;
const MAX_REMARK = 400;

/** What dream reads from learn (provides of the learn module). */
export interface LearnNoteEvent {
  id: number;
  folderId: string;
  relPath: string;
  contentId: number;
  milestone: string;
  er: number | null;
  at: number;
}
export interface LearnProvides {
  postNotes?: { events?(cursor: number, limit?: number): { events: LearnNoteEvent[]; cursor: number } };
  playbook?: { proposeFromModule?(moduleId: string, payload: unknown): { path: string; proposalId: number } };
}

export type CompareCtx = Pick<ModuleContext, 'id' | 'db' | 'brain' | 'agents' | 'settings' | 'log' | 'modules' | 'audit'>;

const isConflict = (e: unknown) => (e as { code?: unknown })?.code === 'conflict';
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function getState(ctx: Pick<ModuleContext, 'db'>, key: string): string | null {
  return (ctx.db.prepare('SELECT value FROM dream_state WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}
function setState(ctx: Pick<ModuleContext, 'db'>, key: string, value: string): void {
  ctx.db
    .prepare('INSERT INTO dream_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, value, Date.now());
}

/** Strict: exactly {"nhan_xet": "<at most two sentences>"}; anything else is rejected (null). */
export function parseRemark(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).join(',') !== 'nhan_xet') return null;
  if (typeof v.nhan_xet !== 'string') return null;
  const text = v.nhan_xet.replace(/\s+/g, ' ').trim();
  if (!text || text.length > MAX_REMARK) return null;
  if (/[<>`]|\[\[|https?:/i.test(text)) return null;
  const sentences = text.split(/(?<=[.!?…])\s+/).filter(Boolean);
  if (sentences.length > 2) return null;
  return text;
}

const fmtNum = (n: number | null, dp = 2) => (n === null ? '—' : n.toLocaleString('vi-VN', { maximumFractionDigits: dp }));
const fmtPct = (n: number | null) => (n === null ? '—' : `${fmtNum(n)}%`);

function remarkPrompt(f: Formula, sources: { durationS: number | null; cutsPerMin: number | null }, posts: PostNote[], result: FormulaResult): string {
  const rows = posts.map((p) => {
    const c = (Array.isArray(p.data.doi_chieu) ? p.data.doi_chieu : []).at(-1) as Record<string, unknown> | undefined;
    return `- dinh_dang ${str(p.data.dinh_dang) || '?'}, do_dai ${num(p.data.do_dai) ?? '?'} giây, mo_dau ${str(p.data.mo_dau) || '?'}, ER ${num(c?.er) ?? '?'}%, gấp ${num(c?.ti_le) ?? '?'} lần trung vị kênh, so với kỳ vọng ${num(c?.so_voi_ky_vong) ?? '?'}`;
  });
  const data = [
    `Công thức: mở đầu ${f.moDau ?? '?'}, cấu trúc ${f.cauTruc ?? '?'}, dài tối đa ${f.maxLen ?? '?'} giây.`,
    `Video gốc (trung vị): dài ${sources.durationS ?? '?'} giây, khoảng ${sources.cutsPerMin ?? '?'} lần cắt mỗi phút.`,
    `Bài của mình (${result.da_lam} bài, kết quả so với kỳ vọng ${result.ket_qua ?? '?'}):`,
    ...rows,
  ].join('\n');
  return [
    'Bạn so bài của chủ kênh với các video gốc của một công thức nội dung. Chỉ trả về MỘT đối tượng JSON, không viết gì khác.',
    'Đúng một khoá: "nhan_xet": tối đa HAI câu tiếng Việt, tối đa 400 ký tự, nói chỗ khác nhau giữa bài của mình và video gốc (độ dài, kiểu mở đầu, nhịp cắt) dựa trên số đo dưới đây.',
    'Không bịa số. Số nào thiếu ("?") thì đừng nhắc. Không nói công thức "làm tăng" hiệu quả: vài bài chỉ là thăm dò. Không chèn link.',
    '',
    untrusted('Số đo', 'so-do-doi-chieu', data),
    '',
    'Ví dụ: {"nhan_xet":"Bài của mình dài hơn video gốc khoảng 10 giây. Hai bài mở đầu bằng con số có ER cao hơn bài mở đầu bằng câu hỏi."}',
  ].join('\n');
}

function remarkBlock(f: Formula, result: FormulaResult, posts: PostNote[], remark: string | null): string {
  const lines: string[] = [];
  if (!result.da_lam) {
    lines.push('_Chưa có bài nào đo xong ở mốc 24 giờ._');
  } else {
    const verdict = STATE_LABELS[result.trang_thai];
    lines.push(
      `**${verdict}**${result.tham_do ? ' (thăm dò)' : ''}: ${result.da_lam} bài, kết quả so với kỳ vọng ${fmtNum(result.ket_qua)} (1 là đúng kỳ vọng), gấp ${fmtNum(result.ti_le_trung_vi)} lần ER trung vị của kênh.`,
      '',
      '| Bài | Mốc | ER | Trung vị kênh | Gấp | Kỳ vọng | So với kỳ vọng |',
      '|---|---|---:|---:|---:|---:|---:|',
    );
    for (const p of posts) {
      const list = (Array.isArray(p.data.doi_chieu) ? p.data.doi_chieu : []) as Record<string, unknown>[];
      for (const c of list) {
        lines.push(`| [[${noteSlug(p.relPath)}]] | ${str(c.moc)} | ${fmtPct(num(c.er))} | ${fmtPct(num(c.trung_vi_kenh))} (${num(c.so_bai_nen) ?? 0} bài) | ${fmtNum(num(c.ti_le))} | ${fmtNum(num(c.ky_vong))} | ${fmtNum(num(c.so_voi_ky_vong))} |`);
      }
    }
    lines.push('', 'Máy tính mọi con số: so mỗi bài với các bài khác của kênh ở cùng mốc, không tính chính bài đó. Dưới 5 bài chỉ là thăm dò, chưa nói được công thức làm tăng hiệu quả.');
  }
  if (remark) lines.push('', `Bot nhận xét: ${remark}`);
  void f;
  return `${lines.join('\n')}\n`;
}

export interface CompareOutcome {
  path: string;
  milestone: CompareMilestone;
  comparison: Comparison;
  formula: string;
  result: FormulaResult;
  becameHop: boolean;
  lesson: string | null;
}

export interface Comparer {
  /** Read learn's feed from the stored cursor and compare what is new. One pass at a time. */
  run(): Promise<{ compared: number; skipped: number }>;
  /** Start-up catch-up: every post note of the folder with a formula and a 24h/7d ER not compared yet. */
  reconcile(folderId: string): Promise<number>;
  /** Compare one post note at one milestone (also what run() does per event). */
  compare(folderId: string, relPath: string, milestone: CompareMilestone): Promise<CompareOutcome | null>;
}

export function createComparer(ctx: CompareCtx, opts: { remarks?: boolean } = {}): Comparer {
  const notes = ctx.brain.notes;
  let running: Promise<{ compared: number; skipped: number }> | null = null;

  const learn = () => ctx.modules.get<LearnProvides>('learn');

  /** The formula note: in the post's folder, else in dream's own folder. */
  function findFormula(folderId: string, slug: string) {
    for (const f of [folderId, String(ctx.settings.get<string>('brain_folder', '') ?? '').trim()]) {
      if (!f) continue;
      try {
        const n = notes.read({ folderId: f, relPath: `${FORMULA_DIR}/${slug}.md` });
        if (n && n.data.loai === 'cong-thuc') return n;
      } catch {
        /* unknown folder */
      }
    }
    return undefined;
  }

  const allPosts = (folderId: string): PostNote[] => notes.list(folderId, POST_DIR, { loai: 'bai-dang' }).map((n) => ({ relPath: n.relPath, data: n.data }));

  /** doi_chieu entry for the milestone (replacing the old one), and so_voi_ky_vong of the latest milestone. */
  function writePost(folderId: string, relPath: string, c: Comparison): void {
    for (let attempt = 0; ; attempt++) {
      const note = notes.read({ folderId, relPath });
      if (!note) return;
      const list = (Array.isArray(note.data.doi_chieu) ? note.data.doi_chieu : []).filter(
        (x) => !(x && typeof x === 'object' && (x as { moc?: unknown }).moc === c.moc),
      ) as Record<string, unknown>[];
      list.push({ moc: c.moc, er: c.er, trung_vi_kenh: c.baselineEr, so_bai_nen: c.baselineN, ti_le: c.ratio, ky_vong: c.expectedRatio, so_voi_ky_vong: c.vsExpected });
      const order = (m: unknown) => COMPARE_MILESTONES.indexOf(m as CompareMilestone);
      list.sort((a, b) => order(a.moc) - order(b.moc));
      const latest = [...list].reverse().find((x) => num(x.so_voi_ky_vong) !== null);
      try {
        notes.patch({ folderId, relPath }, { doi_chieu: list, so_voi_ky_vong: latest ? num(latest.so_voi_ky_vong)! : undefined }, { message: `Dream 100: đối chiếu bài ${noteSlug(relPath)} ở mốc ${c.moc}`, expectHash: note.hash });
        return;
      } catch (e) {
        if (isConflict(e) && attempt < 2) continue;
        throw e;
      }
    }
  }

  async function remarkFor(f: Formula, formulaFolder: string, posts: PostNote[], result: FormulaResult): Promise<string | null> {
    if (opts.remarks === false) return null;
    const agentId = pickAgent(ctx);
    if (!agentId) return null;
    const videos = formulaVideos(ctx, formulaFolder, f.slug);
    const d = median(videos.map((v) => v.duration_s).filter((x): x is number => x !== null));
    const cpm = median(videos.map((v) => v.cuts_per_min).filter((x): x is number => x !== null));
    try {
      const r = await ctx.agents.runLean({
        agentId,
        title: `Dream 100: đối chiếu công thức ${f.slug}`,
        prompt: remarkPrompt(f, { durationS: d === null ? null : Math.round(d), cutsPerMin: cpm === null ? null : Math.round(cpm * 10) / 10 }, posts, result),
        timeoutMs: 120_000,
      });
      if (!r.ok) {
        ctx.log.warn({ slug: f.slug, err: r.error }, 'dream: agent không viết được nhận xét đối chiếu');
        return null;
      }
      const remark = parseRemark(firstJsonObject(r.output));
      if (!remark) ctx.log.warn({ slug: f.slug }, 'dream: nhận xét đối chiếu sai định dạng, bỏ');
      return remark;
    } catch (e) {
      ctx.log.warn({ slug: f.slug, err: (e as Error).message }, 'dream: agent không viết được nhận xét đối chiếu');
      return null;
    }
  }

  /** Recompute the formula from its posts and write it; returns the result and the state before. */
  async function recompute(folderId: string, slug: string): Promise<{ f: Formula; result: FormulaResult; before: FormulaState; formulaFolder: string; posts: PostNote[] } | null> {
    const fnote = findFormula(folderId, slug);
    if (!fnote) return null;
    const f = formulaOf(fnote.relPath, fnote.data);
    const posts = allPosts(folderId).filter((p) => linkSlug(p.data.cong_thuc) === slug);
    const result = formulaResult(posts);
    const counted = posts.filter((p) => result.posts.includes(p.relPath));
    const remarkKey = `remark:${fnote.folderId}:${slug}`;
    const remark = (await remarkFor(f, fnote.folderId, counted, result)) ?? getState(ctx, remarkKey);
    if (remark) setState(ctx, remarkKey, remark);
    for (let attempt = 0; ; attempt++) {
      const cur = notes.read({ folderId: fnote.folderId, relPath: fnote.relPath });
      if (!cur) return null;
      const ref = { folderId: fnote.folderId, relPath: fnote.relPath };
      try {
        const after = notes.patch(
          ref,
          { da_lam: result.da_lam, ket_qua: result.ket_qua ?? undefined, ti_le_trung_vi: result.ti_le_trung_vi ?? undefined, trang_thai: result.trang_thai },
          { message: `Dream 100: đối chiếu công thức ${slug}`, expectHash: cur.hash },
        );
        try {
          notes.setBlock(ref, REMARK_BLOCK, remarkBlock(f, result, counted, remark), { message: `Dream 100: đối chiếu công thức ${slug}`, expectHash: after.hash });
        } catch (e) {
          if (isConflict(e)) throw e;
          ctx.log.warn({ slug, err: (e as Error).message }, 'dream: không cập nhật được khối đối chiếu của công thức');
        }
        return { f, result, before: formulaOf(cur.relPath, cur.data).state, formulaFolder: fnote.folderId, posts: counted };
      } catch (e) {
        if (isConflict(e) && attempt < 2) continue;
        throw e;
      }
    }
  }

  /** A formula just became `hop`: a gia-thuyet lesson in learn's book, once per formula. */
  function proposeLesson(formulaFolder: string, f: Formula, posts: PostNote[], result: FormulaResult): string | null {
    const propose = learn()?.playbook?.proposeFromModule;
    if (!propose) return null;
    const ref = { folderId: formulaFolder, relPath: f.path };
    const cur = notes.read(ref);
    if (!cur || str(cur.data.bai_hoc)) return null;
    const rules: Record<string, unknown> = {};
    if (f.moDau) rules.mo_dau = f.moDau;
    if (f.maxLen) rules.do_dai_toi_da = f.maxLen;
    try {
      const r = propose(ctx.id, {
        tieu_de: `Làm video theo công thức "${f.name}"`,
        mang: 'noi-dung',
        noi_dung:
          `${result.da_lam} bài làm theo công thức này có kết quả so với kỳ vọng ${fmtNum(result.ket_qua)} và gấp ${fmtNum(result.ti_le_trung_vi)} lần ER trung vị của kênh ở cùng mốc. ` +
          `Mở đầu ${(LABEL_TEXT[f.moDau ?? ''] ?? f.moDau ?? '').toLowerCase()}, cấu trúc ${(LABEL_TEXT[f.cauTruc ?? ''] ?? f.cauTruc ?? '').toLowerCase()}. Mới là thăm dò: cần thêm bài thử trước khi kết luận.`,
        bang_chung: posts.map((p) => `[[${noteSlug(p.relPath)}]]`),
        ...(Object.keys(rules).length ? { ap_dung: rules } : {}),
      });
      notes.patch(ref, { bai_hoc: `[[${noteSlug(r.path)}]]` }, { message: `Dream 100: công thức ${f.slug} thành giả thuyết`, expectHash: cur.hash });
      ctx.audit.log('dream.formula.lesson', f.path, { lesson: r.path }, `module:${ctx.id}`);
      return r.path;
    } catch (e) {
      ctx.log.warn({ slug: f.slug, err: (e as Error).message }, 'dream: không đề xuất được bài học từ công thức');
      return null;
    }
  }

  async function compare(folderId: string, relPath: string, milestone: CompareMilestone): Promise<CompareOutcome | null> {
    const note = notes.read({ folderId, relPath });
    if (!note || note.data.loai !== 'bai-dang') return null;
    const slug = linkSlug(note.data.cong_thuc);
    if (!slug) return null;
    const fnote = findFormula(folderId, slug);
    if (!fnote) return null;
    const expected = num(note.data.ky_vong) ?? formulaOf(fnote.relPath, fnote.data).kyVong;
    const posts = allPosts(folderId);
    const self = posts.find((p) => p.relPath === note.relPath) ?? { relPath: note.relPath, data: note.data };
    const c = comparePost(self, posts, milestone, expected);
    if (!c) return null;
    const prev = ctx.db.prepare('SELECT er, baseline_er, ratio, vs_expected FROM dream_comparisons WHERE folder_id = ? AND rel_path = ? AND milestone = ?').get(folderId, note.relPath, milestone) as
      | { er: number | null; baseline_er: number | null; ratio: number | null; vs_expected: number | null }
      | undefined;
    const same = prev && prev.er === c.er && prev.baseline_er === c.baselineEr && prev.vs_expected === c.vsExpected
      && (Array.isArray(note.data.doi_chieu) && (note.data.doi_chieu as Array<{ moc?: unknown }>).some((x) => x?.moc === milestone));
    if (same) return null;
    writePost(folderId, note.relPath, c);
    ctx.db
      .prepare(
        `INSERT INTO dream_comparisons (folder_id, rel_path, milestone, formula_slug, er, baseline_er, baseline_n, ratio, vs_expected, compared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(folder_id, rel_path, milestone) DO UPDATE SET formula_slug = excluded.formula_slug, er = excluded.er, baseline_er = excluded.baseline_er,
           baseline_n = excluded.baseline_n, ratio = excluded.ratio, vs_expected = excluded.vs_expected, compared_at = excluded.compared_at`,
      )
      .run(folderId, note.relPath, milestone, slug, c.er, c.baselineEr, c.baselineN, c.ratio, c.vsExpected, Date.now());
    const r = await recompute(folderId, slug);
    if (!r) return null;
    const becameHop = r.before !== 'hop' && r.result.trang_thai === 'hop';
    const lesson = becameHop ? proposeLesson(r.formulaFolder, r.f, r.posts, r.result) : null;
    ctx.log.info({ post: note.relPath, milestone, formula: slug, vsExpected: c.vsExpected, state: r.result.trang_thai }, 'dream: đã đối chiếu bài với công thức');
    return { path: note.relPath, milestone, comparison: c, formula: slug, result: r.result, becameHop, lesson };
  }

  async function runOnce(): Promise<{ compared: number; skipped: number }> {
    const out = { compared: 0, skipped: 0 };
    const events = learn()?.postNotes?.events;
    if (!events) return out;
    let at = Number(getState(ctx, 'note_cursor') ?? 0) || 0;
    for (;;) {
      const page = events(at, PAGE);
      for (const e of page.events) {
        if (!isCompareMilestone(e.milestone)) {
          out.skipped++;
          continue;
        }
        try {
          if (await compare(e.folderId, e.relPath, e.milestone)) out.compared++;
          else out.skipped++;
        } catch (err) {
          out.skipped++;
          ctx.log.warn({ post: e.relPath, milestone: e.milestone, err: (err as Error).message }, 'dream: đối chiếu bài lỗi');
        }
      }
      if (page.cursor !== at) setState(ctx, 'note_cursor', String(page.cursor));
      at = page.cursor;
      if (page.events.length < PAGE) break;
    }
    return out;
  }

  return {
    run() {
      running ??= runOnce().finally(() => {
        running = null;
      });
      return running;
    },
    async reconcile(folderId) {
      let n = 0;
      let posts: PostNote[];
      try {
        posts = allPosts(folderId);
      } catch {
        return 0;
      }
      for (const p of posts) {
        if (!linkSlug(p.data.cong_thuc)) continue;
        for (const m of COMPARE_MILESTONES) {
          try {
            if (await compare(folderId, p.relPath, m)) n++;
          } catch (err) {
            ctx.log.warn({ post: p.relPath, milestone: m, err: (err as Error).message }, 'dream: đối chiếu bù lỗi');
          }
        }
      }
      return n;
    },
    compare,
  };
}
