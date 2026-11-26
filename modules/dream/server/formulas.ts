// Formulas (cong-thuc/<slug>.md). A formula is a way of making a video that worked for other channels: an opening
// type (mo_dau), a structure (cau_truc) and a maximum length (do_dai_toi_da).
//
// - After a video-dream note is written, the video is matched to an existing formula with the same mo_dau and
//   cau_truc whose do_dai_toi_da it fits; the video note gets `cong_thuc` and the formula's evidence count grows.
// - Otherwise, when 3 unassigned videos analysed in the last 30 days share the labels, the owner is asked (attention
//   item + Công thức page) whether to turn them into a formula.
// - Only the owner creates a formula, through an owner-only route (/api/m/dream/* is in OWNER_ROUTES). There is no
//   ModuleAction for formulas, and the notes service refuses any agent write under cong-thuc/ (src/shared/notes.ts).
import path from 'node:path';
import type { ModuleContext } from '../../../src/modules/sdk.js';
import { getVideo, type VideoRow } from './analyze.js';
import { getChannel, slugify } from './channels.js';
import { DEFAULT_EXPECTATION, EXPLORATORY_BELOW, median, round2, STATE_LABELS, type FormulaState } from './formula-stats.js';
import { CAU_TRUC, LABEL_TEXT } from './label.js';

export const FORMULA_DIR = 'cong-thuc';
export const PROPOSAL_MIN_VIDEOS = 3;
export const PROPOSAL_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/** mo_dau values a formula may have (the cong-thuc schema in src/shared/note-schemas.ts). */
export const FORMULA_MO_DAU = ['cau-hoi', 'con-so', 'ten-san-pham', 'cau-chuyen', 'chi-loi-sai'] as const;
export const FORMULA_CAU_TRUC = CAU_TRUC.filter((x) => x !== 'thieu-du-lieu');

export type FormulaCtx = Pick<ModuleContext, 'db' | 'brain' | 'attention' | 'audit' | 'log'>;

export class FormulaError extends Error {
  constructor(
    readonly code: 'bad_request' | 'not_found' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'FormulaError';
  }
}

export interface Formula {
  slug: string;
  path: string;
  name: string;
  moDau: string | null;
  cauTruc: string | null;
  maxLen: number | null;
  cutsPerMin: number | null;
  pillar: string | null;
  kyVong: number;
  evidence: number;
  made: number;
  result: number | null;
  ratio: number | null;
  state: FormulaState;
  stateLabel: string;
  /** fewer than 5 posts: any verdict is exploratory */
  exploratory: boolean;
  version: number;
  /** lowered priority after three "Bỏ, không hợp" */
  rejections: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const STATES: FormulaState[] = ['chua-thu', 'co-ve-hop', 'hop', 'chua-hop'];

export const noteSlug = (relPath: string): string => path.posix.basename(relPath, '.md');

export function formulaOf(relPath: string, data: Record<string, unknown>): Formula {
  const state = (STATES as string[]).includes(str(data.trang_thai)) ? (str(data.trang_thai) as FormulaState) : 'chua-thu';
  const made = num(data.da_lam) ?? 0;
  return {
    slug: noteSlug(relPath),
    path: relPath,
    name: str(data.ten) || str(data.tieu_de) || noteSlug(relPath),
    moDau: str(data.mo_dau) || null,
    cauTruc: str(data.cau_truc) || null,
    maxLen: num(data.do_dai_toi_da),
    cutsPerMin: num(data.cat_moi_phut),
    pillar: str(data.tru_cot) || null,
    kyVong: num(data.ky_vong) ?? DEFAULT_EXPECTATION,
    evidence: num(data.bang_chung) ?? 0,
    made,
    result: num(data.ket_qua),
    ratio: num(data.ti_le_trung_vi),
    state,
    stateLabel: STATE_LABELS[state],
    exploratory: made < EXPLORATORY_BELOW,
    version: Math.max(1, Math.floor(num(data.phien_ban) ?? 1)),
    rejections: 0,
  };
}

/** Every formula note of the folder (cong-thuc/, loai cong-thuc), with its rejection count. */
export function readFormulas(ctx: Pick<ModuleContext, 'brain' | 'db'>, folderId: string): Formula[] {
  const rej = new Map(
    (ctx.db.prepare("SELECT formula_slug AS slug, COUNT(*) AS n FROM dream_ideas WHERE folder_id = ? AND status = 'rejected' GROUP BY formula_slug").all(folderId) as { slug: string; n: number }[]).map((r) => [r.slug, r.n]),
  );
  return ctx.brain.notes.list(folderId, FORMULA_DIR, { loai: 'cong-thuc' }).map((n) => ({ ...formulaOf(n.relPath, n.data), rejections: rej.get(noteSlug(n.relPath)) ?? 0 }));
}

/** The formula a labelled video belongs to: same mo_dau and cau_truc, and within do_dai_toi_da (tightest first). */
export function matchFormula(formulas: readonly Formula[], v: Pick<VideoRow, 'mo_dau' | 'cau_truc' | 'duration_s'>): Formula | undefined {
  if (!v.mo_dau || !v.cau_truc || v.mo_dau === 'thieu-du-lieu' || v.cau_truc === 'thieu-du-lieu') return undefined;
  const fits = formulas.filter((f) => {
    if (f.moDau !== v.mo_dau || f.cauTruc !== v.cau_truc) return false;
    if (f.maxLen === null) return true;
    return v.duration_s !== null && v.duration_s <= f.maxLen;
  });
  return fits.sort((a, b) => (a.maxLen ?? Infinity) - (b.maxLen ?? Infinity) || a.slug.localeCompare(b.slug))[0];
}

const videoSlug = (v: Pick<VideoRow, 'note_path'>): string | null => (v.note_path ? noteSlug(v.note_path) : null);

/** Videos of a formula, newest first. */
export function formulaVideos(ctx: Pick<ModuleContext, 'db'>, folderId: string, slug: string): VideoRow[] {
  return ctx.db.prepare("SELECT * FROM dream_videos WHERE folder_id = ? AND formula_slug = ? AND status = 'done' ORDER BY captured_at DESC, id").all(folderId, slug) as VideoRow[];
}

const fmtViews = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('vi-VN')} lượt xem`);

function evidenceBlock(ctx: Pick<ModuleContext, 'db'>, videos: readonly VideoRow[]): string {
  if (!videos.length) return '_Chưa có video nào._\n';
  const lines = videos.map((v) => {
    const ch = v.channel_id ? getChannel(ctx, v.channel_id) : undefined;
    const who = ch?.handle ?? v.uploader ?? 'không rõ kênh';
    const len = v.duration_s === null ? '' : ` · ${Math.round(v.duration_s)} giây`;
    const cuts = v.cuts_per_min === null ? '' : ` · khoảng ${v.cuts_per_min.toLocaleString('vi-VN')} lần cắt mỗi phút`;
    return `- [[${videoSlug(v)}]] · ${who} · ${fmtViews(v.views)}${len}${cuts}`;
  });
  return `${lines.join('\n')}\n`;
}

/**
 * Re-count a formula's evidence from the database and write it to the note (bang_chung, cat_moi_phut and the
 * evidence block). Idempotent: running it twice writes nothing the second time.
 */
export function refreshEvidence(ctx: FormulaCtx, folderId: string, slug: string): void {
  const ref = { folderId, relPath: `${FORMULA_DIR}/${slug}.md` };
  const note = ctx.brain.notes.read(ref);
  if (!note) return;
  const videos = formulaVideos(ctx, folderId, slug);
  const cpm = median(videos.map((v) => v.cuts_per_min).filter((x): x is number => x !== null));
  const after = ctx.brain.notes.patch(ref, { bang_chung: videos.length, cat_moi_phut: cpm === null ? undefined : round2(cpm) }, { message: `Dream 100: bằng chứng của công thức ${slug}`, expectHash: note.hash });
  try {
    ctx.brain.notes.setBlock(ref, 'bang-chung', evidenceBlock(ctx, videos), { message: `Dream 100: bằng chứng của công thức ${slug}`, expectHash: after.hash });
  } catch (e) {
    if ((e as { code?: string }).code === 'conflict') throw e;
    ctx.log.warn({ slug, err: (e as Error).message }, 'dream: không cập nhật được khối bằng chứng của công thức');
  }
}

/** Put a video under a formula: the row, then `cong_thuc` on its note. */
function assignVideo(ctx: FormulaCtx, v: VideoRow, slug: string): void {
  ctx.db.prepare('UPDATE dream_videos SET formula_slug = ? WHERE id = ?').run(slug, v.id);
  if (!v.note_path) return;
  const ref = { folderId: v.folder_id, relPath: v.note_path };
  const note = ctx.brain.notes.read(ref);
  if (note) ctx.brain.notes.patch(ref, { cong_thuc: `[[${slug}]]` }, { message: `Dream 100: video ${v.id} thuộc công thức ${slug}`, expectHash: note.hash });
}

const proposalKey = (id: number) => `formula-proposal:${id}`;

export interface ProposalRow {
  id: number;
  folder_id: string;
  mo_dau: string;
  cau_truc: string;
  video_ids: string;
  max_duration: number | null;
  status: 'open' | 'created' | 'dismissed';
  formula_slug: string | null;
  created_at: number;
  resolved_at: number | null;
}

/** Unassigned, analysed videos with these labels in the last 30 days, newest first. */
function unassignedWithLabels(ctx: Pick<ModuleContext, 'db'>, folderId: string, moDau: string, cauTruc: string, now: number): VideoRow[] {
  return ctx.db
    .prepare(
      `SELECT * FROM dream_videos WHERE folder_id = ? AND status = 'done' AND formula_slug IS NULL AND mo_dau = ? AND cau_truc = ?
         AND COALESCE(captured_at, created_at) >= ? ORDER BY COALESCE(captured_at, created_at) DESC, id LIMIT 20`,
    )
    .all(folderId, moDau, cauTruc, now - PROPOSAL_WINDOW_DAYS * DAY_MS) as VideoRow[];
}

/** Longest of the videos, rounded up to the next 5 seconds: the suggested do_dai_toi_da. */
export function suggestedMaxLen(durations: readonly (number | null)[]): number | null {
  const known = durations.filter((d): d is number => d !== null && d > 0);
  if (!known.length) return null;
  return Math.ceil(Math.max(...known) / 5) * 5;
}

/**
 * Called after a video-dream note is written. Matches the video to a formula, or raises (or refreshes) the proposal
 * to make one. Never throws: a failure here must not fail the analysis.
 */
export function afterVideo(ctx: FormulaCtx, videoId: string, now = Date.now()): { matched?: string; proposal?: number } {
  try {
    const v = getVideo(ctx, videoId);
    if (!v || v.status !== 'done' || v.formula_slug || !v.note_path) return {};
    if (!v.mo_dau || !v.cau_truc || v.mo_dau === 'thieu-du-lieu' || v.cau_truc === 'thieu-du-lieu') return {};
    const f = matchFormula(readFormulas(ctx, v.folder_id), v);
    if (f) {
      assignVideo(ctx, v, f.slug);
      refreshEvidence(ctx, v.folder_id, f.slug);
      return { matched: f.slug };
    }
    if (!(FORMULA_MO_DAU as readonly string[]).includes(v.mo_dau)) return {};
    const same = unassignedWithLabels(ctx, v.folder_id, v.mo_dau, v.cau_truc, now);
    if (same.length < PROPOSAL_MIN_VIDEOS) return {};
    const ids = JSON.stringify(same.map((x) => x.id));
    const maxDuration = suggestedMaxLen(same.map((x) => x.duration_s));
    const open = ctx.db.prepare("SELECT id FROM dream_formula_proposals WHERE folder_id = ? AND mo_dau = ? AND cau_truc = ? AND status = 'open'").get(v.folder_id, v.mo_dau, v.cau_truc) as { id: number } | undefined;
    let id: number;
    if (open) {
      ctx.db.prepare('UPDATE dream_formula_proposals SET video_ids = ?, max_duration = ? WHERE id = ?').run(ids, maxDuration, open.id);
      id = open.id;
    } else {
      id = Number(
        ctx.db
          .prepare("INSERT INTO dream_formula_proposals (folder_id, mo_dau, cau_truc, video_ids, max_duration, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)")
          .run(v.folder_id, v.mo_dau, v.cau_truc, ids, maxDuration, now).lastInsertRowid,
      );
    }
    ctx.attention.raise({
      key: proposalKey(id),
      title: `Rút thành công thức? ${same.length} video cùng kiểu "${LABEL_TEXT[v.mo_dau] ?? v.mo_dau}, ${(LABEL_TEXT[v.cau_truc] ?? v.cau_truc).toLowerCase()}"`,
      detail: `${same.length} video phân tích trong ${PROPOSAL_WINDOW_DAYS} ngày có cùng kiểu mở đầu và cấu trúc, chưa thuộc công thức nào. Đặt tên để tạo công thức, hoặc bỏ qua.`,
      link: '/m/dream/formulas',
    });
    return { proposal: id };
  } catch (e) {
    ctx.log.warn({ videoId, err: (e as Error).message }, 'dream: không ghép được video vào công thức');
    return {};
  }
}

export interface ProposalView {
  id: number;
  moDau: string;
  cauTruc: string;
  label: string;
  suggestedName: string;
  maxDuration: number | null;
  videos: Array<{ id: string; title: string | null; channel: string | null; views: number | null; durationS: number | null; notePath: string | null }>;
  createdAt: number;
}

export function listProposals(ctx: Pick<ModuleContext, 'db'>, folderId: string): ProposalView[] {
  const rows = ctx.db.prepare("SELECT * FROM dream_formula_proposals WHERE folder_id = ? AND status = 'open' ORDER BY created_at DESC, id DESC").all(folderId) as ProposalRow[];
  return rows.map((r) => {
    const ids = JSON.parse(r.video_ids) as string[];
    const videos = ids.map((id) => getVideo(ctx, id)).filter((v): v is VideoRow => !!v);
    const md = LABEL_TEXT[r.mo_dau] ?? r.mo_dau;
    const ct = LABEL_TEXT[r.cau_truc] ?? r.cau_truc;
    return {
      id: r.id,
      moDau: r.mo_dau,
      cauTruc: r.cau_truc,
      label: `${md}, ${ct.toLowerCase()}`,
      suggestedName: `${ct}${r.max_duration ? ` dưới ${r.max_duration} giây` : ''}, mở đầu ${md.toLowerCase()}`,
      maxDuration: r.max_duration,
      videos: videos.map((v) => ({ id: v.id, title: v.title, channel: (v.channel_id ? getChannel(ctx, v.channel_id)?.handle : null) ?? v.uploader, views: v.views, durationS: v.duration_s, notePath: v.note_path })),
      createdAt: r.created_at,
    };
  });
}

export function dismissProposal(ctx: FormulaCtx, folderId: string, id: number): void {
  const r = ctx.db.prepare('SELECT * FROM dream_formula_proposals WHERE id = ? AND folder_id = ?').get(id, folderId) as ProposalRow | undefined;
  if (!r) throw new FormulaError('not_found', 'Không tìm thấy đề xuất công thức.');
  if (r.status !== 'open') throw new FormulaError('conflict', 'Đề xuất này đã được xử lý.');
  ctx.db.prepare("UPDATE dream_formula_proposals SET status = 'dismissed', resolved_at = ? WHERE id = ?").run(Date.now(), id);
  ctx.attention.resolve(proposalKey(id));
}

export interface NewFormulaInput {
  name: string;
  slug?: string;
  moDau: string;
  cauTruc: string;
  maxLen?: number | null;
  pillar?: string | null;
  proposalId?: number | null;
}

function formulaBody(name: string, moDau: string, cauTruc: string, maxLen: number | null): string {
  const md = LABEL_TEXT[moDau] ?? moDau;
  const ct = LABEL_TEXT[cauTruc] ?? cauTruc;
  return [
    `# ${name}`,
    '',
    `Mở đầu: ${md.toLowerCase()}. Cấu trúc: ${ct.toLowerCase()}.${maxLen ? ` Dài tối đa ${maxLen} giây.` : ''}`,
    '',
    '## Cách làm',
    '',
    'Chủ ghi thêm ở đây: mỗi phần làm gì, quay cảnh nào. Chỉ học cấu trúc; lời, hình, nhạc là của mình.',
    '',
    '## Video làm bằng chứng',
    '',
    '<!-- aios:begin bang-chung -->',
    '_Chưa có video nào._',
    '<!-- aios:end bang-chung -->',
    '',
    '## Đối chiếu với bài của mình',
    '',
    '<!-- aios:begin doi-chieu -->',
    '_Chưa có bài nào làm theo công thức này._',
    '<!-- aios:end doi-chieu -->',
    '',
  ].join('\n');
}

/**
 * The owner creates a formula (owner-only route). ky_vong 1.5, trang_thai chua-thu, da_lam 0, phien_ban 1. The
 * proposal's videos and every other unassigned video that fits become its evidence.
 */
export function createFormula(ctx: FormulaCtx, folderId: string, input: NewFormulaInput, now = Date.now()): Formula {
  const name = str(input.name).replace(/\s+/g, ' ');
  if (name.length < 3 || name.length > 120) throw new FormulaError('bad_request', 'Tên công thức cần từ 3 đến 120 ký tự.');
  if (!(FORMULA_MO_DAU as readonly string[]).includes(input.moDau)) throw new FormulaError('bad_request', 'Kiểu mở đầu không hợp lệ.');
  if (!(FORMULA_CAU_TRUC as readonly string[]).includes(input.cauTruc)) throw new FormulaError('bad_request', 'Cấu trúc không hợp lệ.');
  let proposal: ProposalRow | undefined;
  if (input.proposalId != null) {
    proposal = ctx.db.prepare('SELECT * FROM dream_formula_proposals WHERE id = ? AND folder_id = ?').get(input.proposalId, folderId) as ProposalRow | undefined;
    if (!proposal) throw new FormulaError('not_found', 'Không tìm thấy đề xuất công thức.');
    if (proposal.status !== 'open') throw new FormulaError('conflict', 'Đề xuất này đã được xử lý.');
    if (proposal.mo_dau !== input.moDau || proposal.cau_truc !== input.cauTruc) throw new FormulaError('bad_request', 'Kiểu mở đầu và cấu trúc phải giống đề xuất.');
  }
  let maxLen = input.maxLen ?? proposal?.max_duration ?? null;
  if (maxLen !== null && (!Number.isFinite(maxLen) || maxLen <= 0 || maxLen > 3600)) throw new FormulaError('bad_request', 'Độ dài tối đa phải từ 1 đến 3.600 giây.');
  if (maxLen !== null) maxLen = Math.round(maxLen);
  const pillar = str(input.pillar).slice(0, 120) || null;
  const slug = slugify(str(input.slug) || name, 'cong-thuc');
  const relPath = `${FORMULA_DIR}/${slug}.md`;
  const ref = { folderId, relPath };
  if (ctx.brain.notes.read(ref)) throw new FormulaError('conflict', `Đã có công thức ${relPath}. Đặt tên khác.`);
  const data: Record<string, unknown> = {
    loai: 'cong-thuc',
    ten: name,
    mo_dau: input.moDau,
    cau_truc: input.cauTruc,
    ...(maxLen !== null ? { do_dai_toi_da: maxLen } : {}),
    ...(pillar ? { tru_cot: pillar } : {}),
    ky_vong: DEFAULT_EXPECTATION,
    bang_chung: 0,
    da_lam: 0,
    trang_thai: 'chua-thu',
    phien_ban: 1,
    tao_luc: new Date(now).toISOString(),
  };
  try {
    ctx.brain.notes.create(ref, data, formulaBody(name, input.moDau, input.cauTruc, maxLen), { message: `Dream 100: chủ tạo công thức ${slug}` });
  } catch (e) {
    if ((e as { code?: string }).code === 'conflict') throw new FormulaError('conflict', `Đã có công thức ${relPath}. Đặt tên khác.`);
    throw e;
  }
  const f = formulaOf(relPath, data);
  // evidence: the proposal's videos, then every other unassigned analysed video that fits
  const ids = new Set<string>(proposal ? (JSON.parse(proposal.video_ids) as string[]) : []);
  const candidates = ctx.db
    .prepare("SELECT * FROM dream_videos WHERE folder_id = ? AND status = 'done' AND formula_slug IS NULL AND mo_dau = ? AND cau_truc = ?")
    .all(folderId, input.moDau, input.cauTruc) as VideoRow[];
  for (const v of candidates) {
    if (ids.has(v.id) || matchFormula([f], v)) assignVideo(ctx, v, slug);
  }
  refreshEvidence(ctx, folderId, slug);
  if (proposal) {
    ctx.db.prepare("UPDATE dream_formula_proposals SET status = 'created', formula_slug = ?, resolved_at = ? WHERE id = ?").run(slug, now, proposal.id);
    ctx.attention.resolve(proposalKey(proposal.id));
  }
  ctx.audit.log('dream.formula.create', relPath, { name, moDau: input.moDau, cauTruc: input.cauTruc, maxLen, proposalId: proposal?.id ?? null }, 'owner');
  return readFormulas(ctx, folderId).find((x) => x.slug === slug) ?? f;
}
