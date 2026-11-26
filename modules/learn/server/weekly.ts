// Weekly review: every Monday 07:30 a `tong-ket` note for the week that just ended, in tong-ket/<năm>-tuan-<số>.md.
// Code computes every number; one lean agent run writes the words ("cái được, cái hỏng") and adds plan lines.
// learn_weekly remembers which weeks are written: module timers do not catch up after the machine was off, so
// start() calls catchUp() too, and a week is written exactly once (also when the cron and start() race).
// Approving the plan (owner only) turns the chosen lines into tasks with ctx.tasks.create.
import type { LeanRunResult, ModuleContext } from '../../../src/modules/sdk.js';
import { untrusted } from '../../../src/modules/sdk.js';
import type { Principal } from '../../../src/shared/notes.js';
import type { CreateTaskInput } from '../../../src/work/contracts.js';
import type { Task } from '../../../src/core/types.js';
import { cleanLine, firstJsonObject, type RunLean } from './lean.js';
import { STATE_LABELS } from './lesson-rules.js';
import { DEFAULT_TZ, DINH_DANG_LABELS, MILESTONE_LABELS, NOTE_DIR } from './note-format.js';
import { LessonError, type Playbook } from './playbook.js';
import { erAt, inWindow, median, type NoteInput } from './stats.js';
import {
  lastCompleteWeek, postsInWeek, previousWeek, weekPoint, weekRange, type DraftStats, type DraftStatsFn, type IsoWeek, type WeekRange,
} from './metrics.js';

type Notes = ModuleContext['brain']['notes'];
type NotesLike = Pick<Notes, 'read' | 'list' | 'create' | 'patch' | 'setBlock'>;

export const WEEKLY_DIR = 'tong-ket';
export const WEEKLY_CRON = '30 7 * * 1';
const PLAN_BLOCK = 'de-xuat';
const MAX_PLAN = 6;

export interface PlanLine {
  viec: string;
  ly_do: string;
  /** agent to give the task to; empty = the module's agent, else main */
  agent?: string;
}

export interface WeekNumbers {
  range: WeekRange;
  moc: string;
  posts: number;
  formats: Array<{ label: string; n: number }>;
  medianEr: number | null;
  measured: number;
  prevMedianEr: number | null;
  drafts: DraftStats | null;
  /** posts of the week against the 90-day median of the other posts, same milestone */
  above: Array<{ title: string; path: string; er: number; diffPct: number }>;
  below: Array<{ title: string; path: string; er: number; diffPct: number }>;
  channelMedian: number | null;
  changes: ReturnType<Playbook['changes']>;
}

export interface WeeklyDeps {
  db: ModuleContext['db'];
  notes: NotesLike;
  folder(): string;
  moc(): string;
  /** the agent that writes the words ('' = none) */
  agentId(): string;
  /** the agent exists and holds playbook.read */
  canUse(agentId: string): boolean;
  runLean: RunLean;
  tasks: { create(input: Omit<CreateTaskInput, 'source'>): Task };
  playbook: Playbook;
  drafts(): DraftStatsFn | undefined;
  log: Pick<ModuleContext['log'], 'info' | 'warn' | 'error'>;
  audit: Pick<ModuleContext['audit'], 'log'>;
  now?(): number;
  tz?: string;
}

export interface WeeklyRow {
  year: number;
  week: number;
  path: string;
  from: string;
  to: string;
  medianEr: number | null;
  posts: number | null;
  newLessons: number | null;
  approved: boolean;
}

export interface WeeklyNote {
  year: number;
  week: number;
  path: string;
  from: string;
  to: string;
  data: Record<string, unknown>;
  body: string;
  plan: PlanLine[];
  approved: boolean;
  tasks: Array<{ line: number; taskId: number }>;
}

export interface Weekly {
  /** write the last complete week if missing (start() and the Monday timer) */
  catchUp(): Promise<{ created: boolean; path: string } | null>;
  ensure(w: IsoWeek): Promise<{ created: boolean; path: string } | null>;
  numbers(w: IsoWeek): WeekNumbers;
  list(): WeeklyRow[];
  get(year: number, week: number): WeeklyNote | null;
  approve(year: number, week: number, lines: number[], principal: Principal): { tasks: Array<{ line: number; taskId: number }> };
}

const pad = (n: number) => String(n).padStart(2, '0');
export const weeklyPath = (w: IsoWeek) => `${WEEKLY_DIR}/${w.year}-tuan-${pad(w.week)}.md`;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const pctText = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${String(round2(v)).replace('.', ',')}%`);
const dm = (ymd: string) => `${Number(ymd.slice(8, 10))}/${Number(ymd.slice(5, 7))}`;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function weekTitle(r: WeekRange): string {
  return `Tuần ${r.week} · ${dm(r.from)} đến ${dm(r.to)}`;
}

function planBlock(plan: PlanLine[], checked: ReadonlySet<number> = new Set()): string {
  if (!plan.length) return '_Tuần này chưa có đề xuất._\n';
  return `${plan.map((p, i) => `- [${checked.has(i) ? 'x' : ' '}] ${p.viec}${p.ly_do ? ` — ${p.ly_do}` : ''}`).join('\n')}\n`;
}

export function createWeekly(deps: WeeklyDeps): Weekly {
  const { db, log } = deps;
  const tz = deps.tz ?? DEFAULT_TZ;
  const now = () => deps.now?.() ?? Math.floor(Date.now() / 1000);
  const inflight = new Map<string, Promise<{ created: boolean; path: string } | null>>();

  const rowOf = (w: IsoWeek) =>
    db.prepare('SELECT year, week, folder_id, rel_path FROM learn_weekly WHERE year = ? AND week = ?').get(w.year, w.week) as
      | { year: number; week: number; folder_id: string; rel_path: string }
      | undefined;
  const remember = (w: IsoWeek, folder: string, relPath: string) =>
    db.prepare('INSERT OR IGNORE INTO learn_weekly (year, week, folder_id, rel_path, created_at) VALUES (?, ?, ?, ?, ?)').run(w.year, w.week, folder, relPath, now());

  function posts(folder: string): NoteInput[] {
    try {
      return deps.notes.list(folder, NOTE_DIR, { loai: 'bai-dang' }).map((n) => ({ relPath: n.relPath, data: n.data }));
    } catch {
      return [];
    }
  }

  function numbers(w: IsoWeek): WeekNumbers {
    const range = weekRange(w, tz);
    const moc = deps.moc();
    const all = posts(deps.folder().trim());
    const drafts = deps.drafts();
    const point = weekPoint(all, range, moc, drafts);
    const prev = weekPoint(all, previousWeek(w, tz), moc, undefined);
    const mine = postsInWeek(all, range);
    const formats = new Map<string, number>();
    for (const p of mine) {
      const label = DINH_DANG_LABELS[str(p.data.dinh_dang)] ?? 'Chưa rõ';
      formats.set(label, (formats.get(label) ?? 0) + 1);
    }
    // each post against the 90 days before the week's end, without itself
    const peers = inWindow(all, { days: 90, now: range.endSec });
    const mineSet = new Set(mine.map((p) => p.relPath));
    const channelVals = peers.filter((p) => !mineSet.has(p.relPath)).map((p) => erAt(p.data, moc)).filter((v): v is number => v !== null);
    const channelMedian = median(channelVals);
    const scored = mine
      .map((p) => ({ title: str(p.data.tieu_de) || p.relPath, path: p.relPath, er: erAt(p.data, moc) }))
      .filter((p): p is { title: string; path: string; er: number } => p.er !== null)
      .map((p) => ({ ...p, diffPct: channelMedian ? Math.round((p.er / channelMedian - 1) * 100) : 0 }));
    return {
      range,
      moc,
      posts: point.posts,
      formats: [...formats].map(([label, n]) => ({ label, n })),
      medianEr: point.medianEr,
      measured: point.measured,
      prevMedianEr: prev.medianEr,
      drafts: point.drafts,
      above: channelMedian === null ? [] : scored.filter((p) => p.er > channelMedian).sort((a, b) => b.er - a.er).slice(0, 3),
      below: channelMedian === null ? [] : scored.filter((p) => p.er < channelMedian).sort((a, b) => a.er - b.er).slice(0, 3),
      channelMedian: channelMedian === null ? null : round2(channelMedian),
      changes: deps.playbook.changes(range.startSec, range.endSec),
    };
  }

  /** Plan lines the code can write: lessons on trial that need more posts. */
  function codePlan(): PlanLine[] {
    const out: PlanLine[] = [];
    for (const l of deps.playbook.list()) {
      if (l.state !== 'dang-thu' || !l.trial) continue;
      const missing = l.trial.threshold - l.trial.measured;
      if (missing <= 0) continue;
      const usedBy = l.usedBy[0];
      out.push({
        viec: `Làm ${missing} bài thử theo bài học "${l.title}"`,
        ly_do: `Đang thử: ${l.trial.measured}/${l.trial.threshold} bài đã đo ở mốc ${MILESTONE_LABELS[l.trial.moc] ?? l.trial.moc}.`,
        ...(usedBy ? { agent: usedBy } : {}),
      });
      if (out.length >= 3) break;
    }
    return out;
  }

  function factsText(n: WeekNumbers): string {
    const lines: string[] = [];
    lines.push(`Bài đã đăng: ${n.posts}${n.formats.length ? ` (${n.formats.map((f) => `${f.n} ${f.label.toLowerCase()}`).join(', ')})` : ''}`);
    lines.push(`ER trung vị ở mốc ${MILESTONE_LABELS[n.moc] ?? n.moc}: ${pctText(n.medianEr)} trên ${n.measured} bài đã đo · tuần trước ${pctText(n.prevMedianEr)}`);
    if (n.drafts) {
      const d = n.drafts;
      const decided = d.sentUnchanged + d.sentEdited + d.discarded + d.notDelivered;
      lines.push(`Nháp trả lời khách của bot: ${d.botDrafts}; gửi nguyên ${d.sentUnchanged}/${decided}${d.unchangedRate === null ? '' : ` (${Math.round(d.unchangedRate * 100)}%)`}, sửa rồi gửi ${d.sentEdited}, bỏ ${d.discarded}, còn chờ ${d.open}`);
    }
    return lines.join('\n');
  }

  async function writeWords(n: WeekNumbers): Promise<{ duoc: string[]; hong: string[]; plan: PlanLine[]; agent: string | null; note: string | null }> {
    const agentId = deps.agentId().trim();
    if (!agentId) return { duoc: [], hong: [], plan: [], agent: null, note: 'Chưa chọn agent viết phần lời (cài đặt "agent" của module Học).' };
    if (!deps.canUse(agentId)) return { duoc: [], hong: [], plan: [], agent: null, note: `Agent "${agentId}" chưa có quyền đọc sổ bài học của module Học.` };
    const data = {
      tuan: weekTitle(n.range),
      so_lieu: factsText(n),
      bai_cao_hon_trung_vi: n.above.map((p) => `${p.title}: ER ${pctText(p.er)} (${p.diffPct >= 0 ? '+' : ''}${p.diffPct}% so với trung vị ${pctText(n.channelMedian)})`),
      bai_thap_hon_trung_vi: n.below.map((p) => `${p.title}: ER ${pctText(p.er)} (${p.diffPct}% so với trung vị ${pctText(n.channelMedian)})`),
      bai_hoc_doi_trang_thai: n.changes.map((c) => `${c.title}: ${c.from ? STATE_LABELS[c.from] : 'mới'} → ${STATE_LABELS[c.to]}`),
    };
    let r: LeanRunResult;
    try {
      r = await deps.runLean({
        agentId,
        title: `Tổng kết ${weekTitle(n.range)}`,
        prompt: [
          'Viết phần lời cho bản tổng kết tuần bằng tiếng Việt, ngắn, cụ thể, chỉ dựa trên số liệu trong ngữ cảnh module.',
          'Không tự tính số mới, không nói một kiểu bài "làm tăng" hiệu quả: vài bài chỉ là thăm dò.',
          'Trả duy nhất JSON: {"duoc":["…"],"hong":["…"],"de_xuat":[{"viec":"…","ly_do":"…"}]} với tối đa 4 mục mỗi danh sách.',
        ].join('\n'),
        moduleContext: untrusted('Số liệu tuần', 'so-lieu-tuan', JSON.stringify(data, null, 1)),
        timeoutMs: 180_000,
      });
    } catch (e) {
      return { duoc: [], hong: [], plan: [], agent: agentId, note: `Agent chưa viết được: ${(e as Error).message}` };
    }
    if (!r.ok) return { duoc: [], hong: [], plan: [], agent: agentId, note: `Agent chưa viết được${r.error ? `: ${cleanLine(r.error, 160)}` : '.'}` };
    const j = firstJsonObject(r.output) as Record<string, unknown> | undefined;
    if (!j || typeof j !== 'object') return { duoc: [], hong: [], plan: [], agent: agentId, note: 'Agent trả lời không đúng dạng JSON.' };
    const lines = (v: unknown) => (Array.isArray(v) ? v.map((x) => cleanLine(x)).filter(Boolean).slice(0, 4) : []);
    const plan = (Array.isArray(j.de_xuat) ? j.de_xuat : [])
      .map((x) => (x && typeof x === 'object' ? { viec: cleanLine((x as Record<string, unknown>).viec, 160), ly_do: cleanLine((x as Record<string, unknown>).ly_do, 240) } : null))
      .filter((x): x is PlanLine => !!x && !!x.viec)
      .slice(0, 4);
    return { duoc: lines(j.duoc), hong: lines(j.hong), plan, agent: agentId, note: null };
  }

  function compose(n: WeekNumbers, words: Awaited<ReturnType<typeof writeWords>>, plan: PlanLine[]): { data: Record<string, unknown>; body: string } {
    const r = n.range;
    const data: Record<string, unknown> = {
      loai: 'tong-ket',
      nam: r.year,
      tuan: r.week,
      tu: r.from,
      den: r.to,
      moc: n.moc,
      so_lieu: Object.fromEntries(Object.entries({
        bai_dang: n.posts,
        bai_da_do: n.measured,
        er_trung_vi: n.medianEr ?? undefined,
        er_tuan_truoc: n.prevMedianEr ?? undefined,
        nhap_cua_bot: n.drafts?.botDrafts,
        nhap_gui_nguyen: n.drafts?.sentUnchanged,
        nhap_da_xu_ly: n.drafts ? n.drafts.sentUnchanged + n.drafts.sentEdited + n.drafts.discarded + n.drafts.notDelivered : undefined,
        bai_hoc_moi: n.changes.filter((c) => c.from === null).length,
      }).filter(([, v]) => v !== undefined)),
      de_xuat: plan,
      ...(words.agent ? { nguoi_viet: words.agent } : {}),
      da_duyet: false,
    };
    const list = (xs: string[], empty: string) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : `_${empty}_`);
    const learned = n.changes.map((c) => `- ${c.from ? `${STATE_LABELS[c.from]} → ` : ''}${STATE_LABELS[c.to]}: [[${c.path.replace(/\.md$/, '')}|${c.title}]]`);
    const body = [
      `# ${weekTitle(r)}`,
      '',
      '## Số liệu',
      '',
      ...factsText(n).split('\n').map((l) => `- ${l}`),
      ...(n.above.length ? ['', `Cao hơn trung vị kênh (${pctText(n.channelMedian)}): ${n.above.map((p) => `[[${p.path.replace(/\.md$/, '')}|${p.title}]] ${pctText(p.er)}`).join(', ')}`] : []),
      ...(n.below.length ? ['', `Thấp hơn trung vị kênh: ${n.below.map((p) => `[[${p.path.replace(/\.md$/, '')}|${p.title}]] ${pctText(p.er)}`).join(', ')}`] : []),
      '',
      '_Máy tính các con số từ ghi chú bài đăng và hộp thư; so cùng nền tảng, cùng mốc._',
      '',
      '## Cái được',
      '',
      list(words.duoc, words.note ?? 'Agent không nêu gì.'),
      '',
      '## Cái hỏng',
      '',
      list(words.hong, words.note ?? 'Agent không nêu gì.'),
      '',
      '## Học được',
      '',
      learned.length ? learned.join('\n') : '_Tuần này không có bài học nào đổi trạng thái._',
      '',
      '## Đề xuất tuần này',
      '',
      `<!-- aios:begin ${PLAN_BLOCK} -->`,
      planBlock(plan).replace(/\n$/, ''),
      `<!-- aios:end ${PLAN_BLOCK} -->`,
      '',
      'Duyệt ở màn Vòng học › Tổng kết tuần: mỗi dòng được chọn thành một việc ở trang Việc.',
      '',
    ].join('\n');
    return { data, body };
  }

  async function write(w: IsoWeek): Promise<{ created: boolean; path: string } | null> {
    const row = rowOf(w);
    if (row) return { created: false, path: row.rel_path };
    const folder = deps.folder().trim();
    if (!folder) return null;
    const relPath = weeklyPath(w);
    const ref = { folderId: folder, relPath };
    let there;
    try {
      there = deps.notes.read(ref);
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'learn: không đọc được thư mục tổng kết');
      return null;
    }
    if (there) {
      // written by a pass that stopped before remembering it
      remember(w, folder, relPath);
      return { created: false, path: relPath };
    }
    const n = numbers(w);
    const words = await writeWords(n);
    const plan = [...codePlan(), ...words.plan.map((p) => ({ ...p, ...(words.agent ? { agent: words.agent } : {}) }))].slice(0, MAX_PLAN);
    const { data, body } = compose(n, words, plan);
    try {
      deps.notes.create(ref, data, body, { message: `Học: tổng kết ${weekTitle(n.range)}` });
    } catch (e) {
      if ((e as { code?: unknown }).code !== 'conflict') throw e;
    }
    remember(w, folder, relPath);
    log.info({ year: w.year, week: w.week }, 'learn: đã viết tổng kết tuần');
    return { created: true, path: relPath };
  }

  function ensure(w: IsoWeek) {
    const key = `${w.year}-${w.week}`;
    let p = inflight.get(key);
    if (!p) {
      p = write(w).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  }

  function readWeek(year: number, week: number): { folder: string; relPath: string; note: { data: Record<string, unknown>; body: string; hash: string } } | null {
    const row = rowOf({ year, week });
    if (!row) return null;
    let note;
    try {
      note = deps.notes.read<Record<string, unknown>>({ folderId: row.folder_id, relPath: row.rel_path });
    } catch {
      return null;
    }
    return note ? { folder: row.folder_id, relPath: row.rel_path, note } : null;
  }

  const planOf = (data: Record<string, unknown>): PlanLine[] =>
    (Array.isArray(data.de_xuat) ? data.de_xuat : [])
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map((x) => ({ viec: str(x.viec), ly_do: str(x.ly_do), ...(str(x.agent) ? { agent: str(x.agent) } : {}) }))
      .filter((x) => x.viec);
  const tasksOf = (data: Record<string, unknown>) =>
    (Array.isArray(data.viec_da_tao) ? data.viec_da_tao : [])
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map((x) => ({ line: Number(x.dong), taskId: Number(x.viec) }))
      .filter((x) => Number.isInteger(x.line) && Number.isInteger(x.taskId));

  return {
    catchUp: () => ensure(lastCompleteWeek(now(), tz)),
    ensure,
    numbers,

    list() {
      const rows = db.prepare('SELECT year, week, folder_id, rel_path FROM learn_weekly ORDER BY year DESC, week DESC LIMIT 52').all() as Array<{ year: number; week: number; folder_id: string; rel_path: string }>;
      return rows.map((r) => {
        const range = weekRange(r, tz);
        let data: Record<string, unknown> = {};
        try {
          data = deps.notes.read({ folderId: r.folder_id, relPath: r.rel_path })?.data ?? {};
        } catch {
          /* folder gone: the row still lists the week */
        }
        const s = (data.so_lieu && typeof data.so_lieu === 'object' ? data.so_lieu : {}) as Record<string, unknown>;
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        return { year: r.year, week: r.week, path: r.rel_path, from: range.from, to: range.to, medianEr: num(s.er_trung_vi), posts: num(s.bai_dang), newLessons: num(s.bai_hoc_moi), approved: data.da_duyet === true };
      });
    },

    get(year, week) {
      const w = readWeek(year, week);
      if (!w) return null;
      const range = weekRange({ year, week }, tz);
      return { year, week, path: w.relPath, from: range.from, to: range.to, data: w.note.data, body: w.note.body, plan: planOf(w.note.data), approved: w.note.data.da_duyet === true, tasks: tasksOf(w.note.data) };
    },

    approve(year, week, lines, principal) {
      if (principal.kind !== 'owner') throw new LessonError('forbidden', 'Chỉ chủ duyệt được kế hoạch tuần.');
      const w = readWeek(year, week);
      if (!w) throw new LessonError('not_found', 'Chưa có tổng kết của tuần này.');
      if (w.note.data.da_duyet === true) throw new LessonError('conflict', 'Kế hoạch tuần này đã được duyệt.');
      const plan = planOf(w.note.data);
      const chosen = [...new Set(lines)].filter((i) => Number.isInteger(i) && i >= 0 && i < plan.length).sort((a, b) => a - b);
      if (!chosen.length) throw new LessonError('bad_request', 'Chọn ít nhất một việc để duyệt.');
      const ref = { folderId: w.folder, relPath: w.relPath };
      // claim first (expectHash): a second approval of the same version cannot create the tasks again
      const claimed = deps.notes.patch(ref, { da_duyet: true, duyet_luc: new Date(now() * 1000).toISOString() }, { message: `Học: duyệt kế hoạch tuần ${week}`, expectHash: w.note.hash });
      const fallbackAgent = deps.agentId().trim();
      const out: Array<{ line: number; taskId: number }> = [];
      for (const i of chosen) {
        const p = plan[i]!;
        const agentId = p.agent && deps.canUse(p.agent) ? p.agent : fallbackAgent && deps.canUse(fallbackAgent) ? fallbackAgent : undefined;
        const task = deps.tasks.create({
          title: p.viec.slice(0, 120),
          prompt: `${p.viec}\n\nLý do: ${p.ly_do || '(không ghi)'}\n\nViệc này từ kế hoạch tuần đã được chủ duyệt, ghi chú ${w.relPath}.`,
          ...(agentId ? { agentId } : {}),
          meta: { learnWeekly: { year, week, line: i } },
        });
        out.push({ line: i, taskId: task.id });
      }
      const after = deps.notes.patch(ref, { viec_da_tao: out.map((x) => ({ dong: x.line, viec: x.taskId })) }, { message: `Học: việc từ kế hoạch tuần ${week}`, expectHash: claimed.hash });
      try {
        deps.notes.setBlock(ref, PLAN_BLOCK, planBlock(plan, new Set(chosen)), { message: `Học: đánh dấu kế hoạch tuần ${week}`, expectHash: after.hash });
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'learn: không đánh dấu được danh sách đề xuất trong ghi chú');
      }
      deps.audit.log('weekly.approve', w.relPath, { year, week, lines: chosen, tasks: out.map((x) => x.taskId) }, 'owner');
      return { tasks: out };
    },
  };
}
