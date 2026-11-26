// The lesson book: `bai-hoc` notes in bai-hoc/ of the brain folder, their state machine and the machine pass that
// moves or proposes moves from the evidence.
//
//   gia-thuyet ──(≥ 3 live evidence, machine)──► dang-thu ──(owner approves)──► da-kiem-chung
//        │                                          │                              │
//        └──(owner drops)──► bi-bac-bo ◄──(owner confirms the machine's proposal)──┘ (owner)
//   da-kiem-chung ──(5 latest posts that follow it all below the channel median, machine)──► dang-thu
//
// Every change of state goes through transition(ref, to, principal). Who asks is a notes Principal handed out by
// the caller's path, never a string from a payload: HTTP routes pass the owner, the machine passes module:learn,
// actions pass the calling agent. Agents never change a state (they can only propose a new gia-thuyet, see
// propose()). Only the owner moves a lesson to da-kiem-chung.
//
// Evidence = `bang_chung` wiki links to `bai-dang` notes that exist, of the lesson's platform. A dead link counts
// for nothing. Comparisons use one platform and one milestone (setting `moc`, default 24h); a judged post is never
// part of the median it is judged against. 3–4 posts are "thăm dò", never proof.
import type { ModuleContext } from '../../../src/modules/sdk.js';
import type { NoteRef, Principal } from '../../../src/shared/notes.js';
import { principalName } from '../../../src/shared/notes.js';
import {
  AREA_LABELS, LESSON_DIR, STATE_LABELS, checkRules, factsOfPost, follows, hasRules, isArea, isLessonState, lessonSummary,
  lessonTitle, linkTarget, rulesOf, sampleLabel, type Area, type LessonRules, type LessonState,
} from './lesson-rules.js';
import { NOTE_DIR, slugify } from './note-format.js';
import { DEFAULT_DAYS, DEFAULT_MOC, erAt, inWindow, isMilestone, median, type NoteInput } from './stats.js';

type Notes = ModuleContext['brain']['notes'];
type NotesLike = Pick<Notes, 'read' | 'list' | 'create' | 'patch'>;
type Db = ModuleContext['db'];

export const MIN_EVIDENCE = 3;
export const RECENT_FOLLOWS = 5;
export const DEFAULT_TRIAL_POSTS = 4;
export const MACHINE: Principal = { kind: 'module', id: 'learn' };

export class LessonError extends Error {
  constructor(readonly code: 'forbidden' | 'bad_request' | 'not_found' | 'conflict', message: string) {
    super(message);
    this.name = 'LessonError';
  }
}

export interface EvidenceView {
  link: string;
  /** the bai-dang note it points to, null when dead (or another platform, or not a post) */
  path: string | null;
  title: string | null;
  live: boolean;
  er: number | null;
}

export interface TrialView {
  /** posts that follow the lesson (linked in bai_thu, or matching its rules) */
  posts: number;
  /** of those, measured at the milestone */
  measured: number;
  threshold: number;
  medianEr: number | null;
  channelMedian: number | null;
  channelN: number;
  moc: string;
  label: string;
  /** dang-thu: 'dat' / 'khong-dat' once `measured ≥ threshold`; da-kiem-chung: 'giam' when the 5 latest are all below */
  verdict: 'chua-du' | 'dat' | 'khong-dat' | 'on-dinh' | 'giam';
  recent: Array<{ path: string; title: string; er: number | null; below: boolean | null }>;
}

export interface LessonView {
  path: string;
  title: string;
  summary: string;
  state: LessonState;
  stateLabel: string;
  area: Area | null;
  areaLabel: string;
  platform: string;
  usedBy: string[];
  evidence: EvidenceView[];
  liveEvidence: number;
  rules: LessonRules;
  ruleText: string[];
  trial: TrialView | null;
  /** da-kiem-chung set by the owner through the app (else agents do not get it and drafts are not scored on it) */
  ownerVerified: boolean;
  proposedBy: string | null;
  changedAt: string | null;
}

export interface ProposalView {
  id: number;
  kind: 'new' | 'transition';
  path: string;
  title: string;
  from: LessonState | null;
  to: LessonState | null;
  reason: string;
  proposedBy: string;
  createdAt: number;
  lesson: LessonView | null;
}

export interface PlaybookDeps {
  db: Db;
  notes: NotesLike;
  folder(): string;
  trialPosts(): number;
  moc(): string;
  attention: Pick<ModuleContext['attention'], 'raise' | 'resolve'>;
  audit: Pick<ModuleContext['audit'], 'log'>;
  log: Pick<ModuleContext['log'], 'info' | 'warn' | 'error'>;
  /** unix seconds */
  now?(): number;
}

export interface NewLessonInput {
  title: string;
  area: Area;
  text: string;
  evidence?: string[];
  rules?: unknown;
  platform?: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const isConflict = (e: unknown) => (e as { code?: unknown })?.code === 'conflict';

function localIsoNow(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function publishedSec(data: Record<string, unknown>): number | null {
  const t = Date.parse(str(data.dang_luc));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/** Normalise an evidence reference (`[[x]]`, `noi-dung/bai/x.md`, `x`) to a wiki link, or undefined. */
export function toWikiLink(ref: unknown): string | undefined {
  if (typeof ref !== 'string') return undefined;
  const t = linkTarget(ref);
  if (t) return `[[${t}]]`;
  const s = ref.trim().replace(/\.md$/i, '');
  if (!s || /[[\]|\n]/.test(s) || s.split('/').includes('..')) return undefined;
  return `[[${s.split('/').pop()}]]`;
}

/** Rules back to the frontmatter shape (only the keys that parsed). */
function rulesToData(r: LessonRules): Record<string, unknown> | undefined {
  if (!hasRules(r)) return undefined;
  const vnDay = (d: number) => (d === 0 ? 'cn' : d + 1);
  const out: Record<string, unknown> = {};
  if (r.dinhDang) out.dinh_dang = r.dinhDang;
  if (r.gio) out.gio_dang = `${r.gio.from}-${r.gio.to}`;
  if (r.thu) out.thu = r.thu.map(vnDay);
  if (r.doDaiToiDa !== undefined) out.do_dai_toi_da = r.doDaiToiDa;
  if (r.doDaiToiThieu !== undefined) out.do_dai_toi_thieu = r.doDaiToiThieu;
  if (r.moDau) out.mo_dau = r.moDau;
  return out;
}

export function ruleTexts(r: LessonRules): string[] {
  // what each rule asks, from a check against an empty draft (every rule then explains what it wants)
  return checkRules(r, {}).map((c) => c.text.replace(/;.*$/, ''));
}

interface Loaded {
  folder: string;
  posts: NoteInput[];
  byTarget: Map<string, NoteInput>;
  lessons: Array<{ relPath: string; data: Record<string, unknown>; body: string; hash: string }>;
}

export interface Playbook {
  list(): LessonView[];
  get(relPath: string): LessonView | null;
  transition(ref: NoteRef, to: LessonState, principal: Principal, opts?: { reason?: string }): { from: LessonState; to: LessonState; path: string; changed: boolean };
  /** the owner writes a hypothesis from the app */
  create(input: NewLessonInput, principal: Principal): LessonView;
  /** an agent proposes a hypothesis (ModuleAction learn.propose); always gia-thuyet, waits in Chờ duyệt */
  propose(agentId: string, payload: unknown): { path: string; proposalId: number };
  /** the machine pass: moves and proposals from the evidence */
  evaluate(): { moved: Array<{ path: string; from: LessonState; to: LessonState }>; proposed: number };
  proposals(): ProposalView[];
  accept(id: number, principal: Principal): ProposalView;
  dismiss(id: number, principal: Principal): ProposalView;
  /** da-kiem-chung lessons the owner verified in the app, for agentContext and score-draft */
  verified(): LessonView[];
  /** state changes between two unix times (the weekly review, the loop page) */
  changes(fromSec: number, toSec: number): Array<{ path: string; title: string; from: LessonState | null; to: LessonState; actor: string; reason: string; at: number }>;
  counts(): Record<LessonState, number>;
}

export function createPlaybook(deps: PlaybookDeps): Playbook {
  const { db, log } = deps;
  const now = () => deps.now?.() ?? Math.floor(Date.now() / 1000);
  const folderOrThrow = () => {
    const f = deps.folder().trim();
    if (!f) throw new LessonError('bad_request', 'Chưa chọn thư mục Second Brain cho module Học.');
    return f;
  };
  const moc = () => {
    const m = deps.moc();
    return isMilestone(m) ? m : DEFAULT_MOC;
  };
  const threshold = () => {
    const n = Number(deps.trialPosts());
    return Number.isInteger(n) && n >= 2 && n <= 50 ? n : DEFAULT_TRIAL_POSTS;
  };

  function load(folder: string): Loaded {
    let posts: NoteInput[] = [];
    let lessons: Loaded['lessons'] = [];
    try {
      posts = deps.notes.list(folder, NOTE_DIR, { loai: 'bai-dang' }).map((n) => ({ relPath: n.relPath, data: n.data }));
      lessons = deps.notes.list(folder, LESSON_DIR, { loai: 'bai-hoc' }).map((n) => ({ relPath: n.relPath, data: n.data, body: n.body, hash: n.hash }));
    } catch (e) {
      if ((e as { code?: unknown }).code !== 'bad_request') throw e;
    }
    const byTarget = new Map<string, NoteInput>();
    for (const p of posts) {
      const noExt = p.relPath.replace(/\.md$/, '');
      byTarget.set(noExt, p);
      const base = noExt.split('/').pop()!;
      if (!byTarget.has(base)) byTarget.set(base, p);
    }
    return { folder, posts, byTarget, lessons };
  }

  const platformOf = (data: Record<string, unknown>) => str(data.nen_tang) || 'facebook';

  /** live bai-dang notes behind a list of wiki links, of one platform, without duplicates */
  function resolve(L: Loaded, links: unknown, platform: string): { views: EvidenceView[]; live: NoteInput[] } {
    const views: EvidenceView[] = [];
    const live: NoteInput[] = [];
    const seen = new Set<string>();
    for (const raw of list(links)) {
      const target = linkTarget(raw);
      if (!target) continue;
      const note = L.byTarget.get(target);
      const ok = !!note && str(note.data.nen_tang) === platform;
      if (ok && seen.has(note!.relPath)) continue;
      if (ok) {
        seen.add(note!.relPath);
        live.push(note!);
      }
      views.push({ link: String(raw), path: ok ? note!.relPath : null, title: ok ? str(note!.data.tieu_de) || null : null, live: ok, er: ok ? erAt(note!.data, moc()) : null });
    }
    return { views, live };
  }

  /** posts that follow the lesson: linked in bai_thu, plus (with rules) posts matching them since `since` */
  function followers(L: Loaded, data: Record<string, unknown>, sinceSec: number | null): NoteInput[] {
    const platform = platformOf(data);
    const out = new Map<string, NoteInput>();
    for (const p of resolve(L, data.bai_thu, platform).live) out.set(p.relPath, p);
    const rules = rulesOf(data);
    if (hasRules(rules) && sinceSec !== null) {
      for (const p of L.posts) {
        if (str(p.data.nen_tang) !== platform) continue;
        const t = publishedSec(p.data);
        if (t === null || t < sinceSec) continue;
        if (follows(rules, factsOfPost(p.data))) out.set(p.relPath, p);
      }
    }
    return [...out.values()].sort((a, b) => (publishedSec(b.data) ?? 0) - (publishedSec(a.data) ?? 0));
  }

  function dateSec(v: unknown): number | null {
    const t = Date.parse(str(v));
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  }

  function trialOf(L: Loaded, data: Record<string, unknown>, state: LessonState): TrialView | null {
    if (state !== 'dang-thu' && state !== 'da-kiem-chung') return null;
    const m = moc();
    const platform = platformOf(data);
    const since = state === 'dang-thu' ? (dateSec(data.thu_tu) ?? dateSec(data.doi_trang_thai_luc)) : 0;
    const posts = followers(L, data, since);
    const judged = state === 'dang-thu' ? posts : posts.filter((p) => erAt(p.data, m) !== null).slice(0, RECENT_FOLLOWS);
    const judgedPaths = new Set(judged.map((p) => p.relPath));
    const peers = inWindow(L.posts, { days: DEFAULT_DAYS, platform, now: now() }).filter((p) => !judgedPaths.has(p.relPath));
    const channelVals = peers.map((p) => erAt(p.data, m)).filter((v): v is number => v !== null);
    const channelMedian = median(channelVals);
    const vals = judged.map((p) => erAt(p.data, m)).filter((v): v is number => v !== null);
    const med = median(vals);
    const n = threshold();
    let verdict: TrialView['verdict'] = 'chua-du';
    if (state === 'dang-thu') {
      if (vals.length >= n && med !== null && channelMedian !== null) verdict = med > channelMedian ? 'dat' : 'khong-dat';
    } else if (channelMedian !== null && vals.length >= RECENT_FOLLOWS) {
      verdict = vals.every((v) => v < channelMedian) ? 'giam' : 'on-dinh';
    }
    return {
      posts: posts.length,
      measured: vals.length,
      threshold: state === 'dang-thu' ? n : RECENT_FOLLOWS,
      medianEr: med === null ? null : round2(med),
      channelMedian: channelMedian === null ? null : round2(channelMedian),
      channelN: channelVals.length,
      moc: m,
      label: sampleLabel(vals.length),
      verdict,
      recent: judged.slice(0, 8).map((p) => {
        const er = erAt(p.data, m);
        return { path: p.relPath, title: str(p.data.tieu_de) || p.relPath, er, below: er === null || channelMedian === null ? null : er < channelMedian };
      }),
    };
  }

  function lastLog(folder: string, relPath: string): { to_state: string; actor: string } | undefined {
    return db.prepare('SELECT to_state, actor FROM learn_lesson_log WHERE folder_id = ? AND rel_path = ? ORDER BY id DESC LIMIT 1').get(folder, relPath) as
      | { to_state: string; actor: string }
      | undefined;
  }

  function view(L: Loaded, n: Loaded['lessons'][number]): LessonView | null {
    const state = n.data.trang_thai;
    if (!isLessonState(state)) return null;
    const platform = platformOf(n.data);
    const ev = resolve(L, n.data.bang_chung, platform);
    const rules = rulesOf(n.data);
    const area = isArea(n.data.mang) ? n.data.mang : null;
    const last = lastLog(L.folder, n.relPath);
    return {
      path: n.relPath,
      title: lessonTitle(n.relPath, n.data, n.body),
      summary: lessonSummary(n.data, n.body),
      state,
      stateLabel: STATE_LABELS[state],
      area,
      areaLabel: area ? AREA_LABELS[area] : 'Chưa rõ',
      platform,
      usedBy: list(n.data.dung_boi).filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()),
      evidence: ev.views,
      liveEvidence: ev.live.length,
      rules,
      ruleText: ruleTexts(rules),
      trial: trialOf(L, n.data, state),
      ownerVerified: state === 'da-kiem-chung' && last?.to_state === 'da-kiem-chung' && last.actor === 'owner',
      proposedBy: str(n.data.de_xuat_boi) || null,
      changedAt: str(n.data.doi_trang_thai_luc) || null,
    };
  }

  function logChange(folder: string, relPath: string, title: string, from: LessonState | null, to: LessonState, actor: string, reason: string) {
    db.prepare('INSERT INTO learn_lesson_log (folder_id, rel_path, title, from_state, to_state, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(folder, relPath, title, from, to, actor, reason, now());
  }

  const attnKey = (relPath: string) => `lesson:${relPath}`;

  /** The allowed edges and who may take them. Agents may take none. */
  function check(from: LessonState, to: LessonState, p: Principal, liveEvidence: number): void {
    if (p.kind === 'agent') throw new LessonError('forbidden', 'Agent không đổi được trạng thái bài học. Agent chỉ đề xuất bài học mới (learn.propose).');
    if (p.kind === 'module' && p.id !== 'learn') throw new LessonError('forbidden', `Module ${p.id} không đổi được trạng thái bài học.`);
    const owner = p.kind === 'owner';
    if (to === 'da-kiem-chung' && !owner) throw new LessonError('forbidden', 'Chỉ chủ chuyển được bài học sang Đã kiểm chứng.');
    const edge = `${from}>${to}`;
    switch (edge) {
      case 'gia-thuyet>dang-thu':
        if (liveEvidence < MIN_EVIDENCE) throw new LessonError('bad_request', `Cần ít nhất ${MIN_EVIDENCE} bằng chứng còn tồn tại (đang có ${liveEvidence}).`);
        return;
      case 'da-kiem-chung>dang-thu':
        return; // machine (5 latest below the median) or owner
      case 'dang-thu>da-kiem-chung':
      case 'gia-thuyet>bi-bac-bo':
      case 'dang-thu>bi-bac-bo':
      case 'da-kiem-chung>bi-bac-bo':
      case 'bi-bac-bo>gia-thuyet':
        if (!owner) throw new LessonError('forbidden', 'Chỉ chủ làm được bước này; máy chỉ đề xuất.');
        return;
      default:
        throw new LessonError('bad_request', `Không chuyển được từ "${STATE_LABELS[from]}" sang "${STATE_LABELS[to]}".`);
    }
  }

  function resolveOpen(folder: string, relPath: string, status: 'accepted' | 'superseded', exceptId?: number) {
    db.prepare(`UPDATE learn_proposals SET status = ?, resolved_at = ? WHERE folder_id = ? AND rel_path = ? AND status = 'open' AND id IS NOT ?`)
      .run(status, now(), folder, relPath, exceptId ?? null);
  }

  function transition(ref: NoteRef, to: LessonState, principal: Principal, opts: { reason?: string } = {}) {
    if (!isLessonState(to)) throw new LessonError('bad_request', `Trạng thái "${String(to)}" không hợp lệ.`);
    // refuse agents before reading anything: no state change is reachable from an agent
    if (principal.kind === 'agent') check('gia-thuyet', to, principal, 0);
    if (!ref.relPath.startsWith(`${LESSON_DIR}/`) || !ref.relPath.endsWith('.md') || ref.relPath.split('/').includes('..')) {
      throw new LessonError('bad_request', `Bài học phải nằm trong ${LESSON_DIR}/.`);
    }
    const actor = principalName(principal);
    for (let attempt = 0; ; attempt++) {
      const note = deps.notes.read({ folderId: ref.folderId, relPath: ref.relPath });
      if (!note || note.data.loai !== 'bai-hoc') throw new LessonError('not_found', 'Không tìm thấy bài học này.');
      const from = note.data.trang_thai;
      if (!isLessonState(from)) throw new LessonError('bad_request', 'Ghi chú chưa có trang_thai hợp lệ.');
      const title = lessonTitle(note.relPath, note.data, note.body);
      if (from === to) {
        // the owner confirming a da-kiem-chung written by hand (Obsidian): recorded so agents may use it
        if (to === 'da-kiem-chung' && principal.kind === 'owner' && lastLog(ref.folderId, ref.relPath)?.actor !== 'owner') {
          logChange(ref.folderId, ref.relPath, title, from, to, actor, opts.reason ?? 'Chủ xác nhận');
          deps.audit.log('lesson.transition', ref.relPath, { from, to, reason: 'confirm' }, actor);
          return { from, to, path: ref.relPath, changed: true };
        }
        return { from, to, path: ref.relPath, changed: false };
      }
      const L = load(ref.folderId);
      const live = resolve(L, note.data.bang_chung, platformOf(note.data)).live.length;
      check(from, to, principal, live);
      const at = localIsoNow(now());
      const patch: Record<string, unknown> = { trang_thai: to, doi_trang_thai_luc: at };
      if (to === 'dang-thu') patch.thu_tu = at;
      if (to === 'da-kiem-chung') patch.kiem_chung_luc = at;
      try {
        deps.notes.patch(ref, patch, { message: `Học: bài học "${title}" ${STATE_LABELS[from]} → ${STATE_LABELS[to]}`, expectHash: note.hash });
      } catch (e) {
        if (isConflict(e) && attempt === 0) continue;
        throw e;
      }
      const reason = opts.reason ?? '';
      logChange(ref.folderId, ref.relPath, title, from, to, actor, reason);
      deps.audit.log('lesson.transition', ref.relPath, { from, to, reason }, actor);
      resolveOpen(ref.folderId, ref.relPath, 'superseded');
      if (principal.kind === 'owner') deps.attention.resolve(attnKey(ref.relPath));
      return { from, to, path: ref.relPath, changed: true };
    }
  }

  function uniquePath(folder: string, title: string): string {
    const slug = slugify(title, 60) || 'bai-hoc';
    for (let i = 1; i < 100; i++) {
      const p = `${LESSON_DIR}/${slug}${i === 1 ? '' : `-${i}`}.md`;
      if (!deps.notes.read({ folderId: folder, relPath: p })) return p;
    }
    return `${LESSON_DIR}/${slug}-${now()}.md`;
  }

  function writeLesson(folder: string, input: NewLessonInput, extra: Record<string, unknown>, message: string): string {
    const title = input.title.trim().replace(/\s+/g, ' ').slice(0, 160);
    if (!title) throw new LessonError('bad_request', 'Bài học cần một câu nói rõ điều học được.');
    if (!isArea(input.area)) throw new LessonError('bad_request', 'Mảng phải là noi-dung, cham-khach hoặc quang-cao.');
    const evidence = [...new Set(list(input.evidence).map(toWikiLink).filter((x): x is string => !!x))].slice(0, 20);
    const rules = rulesToData(input.rules && typeof input.rules === 'object' ? rulesOf({ ap_dung: input.rules }) : {});
    const platform = str(input.platform) || 'facebook';
    const data: Record<string, unknown> = {
      loai: 'bai-hoc',
      tieu_de: title,
      mang: input.area,
      trang_thai: 'gia-thuyet',
      nen_tang: platform,
      bang_chung: evidence,
      dung_boi: [],
      ...(rules ? { ap_dung: rules } : {}),
      doi_trang_thai_luc: localIsoNow(now()),
      ...extra,
    };
    const text = input.text.trim().slice(0, 4000);
    const body = `# ${title}\n\n${text ? `${text}\n\n` : ''}## Bằng chứng\n\nThêm liên kết tới ghi chú bài đăng vào \`bang_chung\`. Đủ ${MIN_EVIDENCE} bài còn tồn tại thì máy chuyển sang Đang thử.\n`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const relPath = uniquePath(folder, title);
      try {
        deps.notes.create({ folderId: folder, relPath }, data, body, { message });
        return relPath;
      } catch (e) {
        if (!isConflict(e)) throw e;
      }
    }
    throw new LessonError('conflict', 'Không đặt được tên ghi chú cho bài học.');
  }

  function proposalRow(id: number) {
    return db.prepare('SELECT * FROM learn_proposals WHERE id = ?').get(id) as
      | { id: number; folder_id: string; rel_path: string; kind: 'new' | 'transition'; to_state: string | null; reason: string; basis: number; proposed_by: string; status: string; created_at: number }
      | undefined;
  }

  function proposalView(L: Loaded | null, r: NonNullable<ReturnType<typeof proposalRow>>): ProposalView {
    const n = L?.lessons.find((x) => x.relPath === r.rel_path);
    const lesson = L && n ? view(L, n) : null;
    return {
      id: r.id,
      kind: r.kind,
      path: r.rel_path,
      title: lesson?.title ?? r.rel_path.split('/').pop()!.replace(/\.md$/, ''),
      from: lesson?.state ?? null,
      to: isLessonState(r.to_state) ? r.to_state : null,
      reason: r.reason,
      proposedBy: r.proposed_by,
      createdAt: r.created_at,
      lesson,
    };
  }

  /** open a machine proposal unless one is open, or one for the same move was dismissed on as many posts */
  function proposeMove(folder: string, relPath: string, title: string, to: LessonState, reason: string, basis: number): boolean {
    const dismissed = db.prepare(`SELECT MAX(basis) AS b FROM learn_proposals WHERE folder_id = ? AND rel_path = ? AND kind = 'transition' AND to_state = ? AND status = 'dismissed'`)
      .get(folder, relPath, to) as { b: number | null };
    if (dismissed.b !== null && basis <= dismissed.b) return false;
    const r = db.prepare(
      `INSERT INTO learn_proposals (folder_id, rel_path, kind, to_state, reason, basis, proposed_by, created_at) VALUES (?, ?, 'transition', ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).run(folder, relPath, to, reason, basis, principalName(MACHINE), now());
    if (!r.changes) return false;
    deps.attention.raise({
      key: attnKey(relPath),
      title: to === 'da-kiem-chung' ? `Bài học chờ bạn duyệt: ${title}` : `Máy đề xuất bác bỏ bài học: ${title}`,
      detail: reason,
      link: '/m/learn/pending',
    });
    return true;
  }

  function listLessons(): LessonView[] {
    const f = deps.folder().trim();
    if (!f) return [];
    const L = load(f);
    return L.lessons.map((n) => view(L, n)).filter((x): x is LessonView => !!x);
  }

  function getLesson(relPath: string): LessonView | null {
    const f = deps.folder().trim();
    if (!f) return null;
    const L = load(f);
    const n = L.lessons.find((x) => x.relPath === relPath);
    return n ? view(L, n) : null;
  }

  return {
    list: listLessons,
    get: getLesson,

    transition,

    create(input, principal) {
      if (principal.kind !== 'owner') throw new LessonError('forbidden', 'Chỉ chủ viết bài học trực tiếp; agent dùng learn.propose.');
      const folder = folderOrThrow();
      const relPath = writeLesson(folder, input, {}, 'Học: chủ thêm giả thuyết');
      logChange(folder, relPath, input.title.trim(), null, 'gia-thuyet', principalName(principal), 'Chủ thêm');
      return getLesson(relPath)!;
    },

    propose(agentId, payload) {
      const folder = folderOrThrow();
      const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
      // whatever the payload says about state or who uses it is ignored: a proposal is always a gia-thuyet nobody uses yet
      const input: NewLessonInput = {
        title: str(p.tieu_de ?? p.title),
        area: (str(p.mang ?? p.area) || 'noi-dung') as Area,
        text: str(p.noi_dung ?? p.text),
        evidence: list(p.bang_chung ?? p.evidence) as string[],
        rules: p.ap_dung ?? p.rules,
        platform: str(p.nen_tang) || undefined,
      };
      const open = (db.prepare(`SELECT COUNT(*) AS n FROM learn_proposals WHERE folder_id = ? AND kind = 'new' AND status = 'open' AND proposed_by = ?`).get(folder, `agent:${agentId}`) as { n: number }).n;
      if (open >= 20) throw new LessonError('conflict', 'Đã có 20 đề xuất của agent này đang chờ chủ xem. Chờ chủ duyệt bớt rồi đề xuất tiếp.');
      const relPath = writeLesson(folder, input, { de_xuat_boi: agentId }, `Học: agent ${agentId} đề xuất bài học`);
      logChange(folder, relPath, input.title, null, 'gia-thuyet', `agent:${agentId}`, 'Agent đề xuất');
      const r = db.prepare(`INSERT INTO learn_proposals (folder_id, rel_path, kind, reason, proposed_by, created_at) VALUES (?, ?, 'new', ?, ?, ?)`)
        .run(folder, relPath, input.text.slice(0, 500), `agent:${agentId}`, now());
      deps.attention.raise({ key: attnKey(relPath), title: `Bot đề xuất bài học mới: ${input.title}`, detail: 'Giả thuyết, chưa dùng ở đâu. Xem ở Chờ duyệt.', link: '/m/learn/pending' });
      return { path: relPath, proposalId: Number(r.lastInsertRowid) };
    },

    evaluate() {
      const out = { moved: [] as Array<{ path: string; from: LessonState; to: LessonState }>, proposed: 0 };
      const f = deps.folder().trim();
      if (!f) return out;
      const L = load(f);
      for (const n of L.lessons) {
        const v = view(L, n);
        if (!v) continue;
        try {
          if (v.state === 'gia-thuyet' && v.liveEvidence >= MIN_EVIDENCE) {
            const reason = `Đủ ${v.liveEvidence} bằng chứng còn tồn tại`;
            const r = transition({ folderId: f, relPath: v.path }, 'dang-thu', MACHINE, { reason });
            if (r.changed) {
              out.moved.push({ path: v.path, from: r.from, to: r.to });
              deps.attention.raise({ key: attnKey(v.path), title: `Bài học chuyển sang Đang thử: ${v.title}`, detail: `${reason}. Bot sẽ làm theo để thử.`, link: '/m/learn/playbook' });
            }
          } else if (v.state === 'dang-thu' && v.trial && (v.trial.verdict === 'dat' || v.trial.verdict === 'khong-dat')) {
            const t = v.trial;
            const nums = `ER trung vị ${t.medianEr}% trên ${t.measured} bài thử (${t.label}), trung vị kênh ${t.channelMedian}% trên ${t.channelN} bài, mốc ${t.moc}`;
            const to: LessonState = t.verdict === 'dat' ? 'da-kiem-chung' : 'bi-bac-bo';
            if (proposeMove(f, v.path, v.title, to, nums, t.measured)) out.proposed++;
          } else if (v.state === 'da-kiem-chung' && v.trial?.verdict === 'giam') {
            const t = v.trial;
            const reason = `${RECENT_FOLLOWS} bài gần nhất làm theo đều dưới trung vị kênh (${t.channelMedian}%, mốc ${t.moc})`;
            const r = transition({ folderId: f, relPath: v.path }, 'dang-thu', MACHINE, { reason });
            if (r.changed) {
              out.moved.push({ path: v.path, from: r.from, to: r.to });
              deps.attention.raise({ key: attnKey(v.path), title: `Bài học quay về Đang thử: ${v.title}`, detail: reason, link: '/m/learn/playbook', severity: 'warn' });
            }
          }
        } catch (e) {
          log.warn({ lesson: v.path, err: (e as Error).message }, 'learn: không xét được bài học');
        }
      }
      return out;
    },

    proposals() {
      const f = deps.folder().trim();
      if (!f) return [];
      const rows = db.prepare(`SELECT * FROM learn_proposals WHERE folder_id = ? AND status = 'open' ORDER BY created_at DESC, id DESC`).all(f) as Array<NonNullable<ReturnType<typeof proposalRow>>>;
      const L = load(f);
      return rows.map((r) => proposalView(L, r));
    },

    accept(id, principal) {
      if (principal.kind !== 'owner') throw new LessonError('forbidden', 'Chỉ chủ duyệt được đề xuất.');
      const r = proposalRow(id);
      if (!r || r.status !== 'open') throw new LessonError('not_found', 'Đề xuất này không còn chờ duyệt.');
      if (r.kind === 'transition' && isLessonState(r.to_state)) {
        transition({ folderId: r.folder_id, relPath: r.rel_path }, r.to_state, principal, { reason: `Chủ duyệt đề xuất: ${r.reason}` });
      }
      db.prepare(`UPDATE learn_proposals SET status = 'accepted', resolved_at = ? WHERE id = ?`).run(now(), id);
      deps.attention.resolve(attnKey(r.rel_path));
      deps.audit.log('lesson.proposal.accept', r.rel_path, { id, kind: r.kind, to: r.to_state }, principalName(principal));
      return proposalView(r.folder_id === deps.folder().trim() ? load(r.folder_id) : null, { ...r, status: 'accepted' });
    },

    dismiss(id, principal) {
      if (principal.kind !== 'owner') throw new LessonError('forbidden', 'Chỉ chủ bỏ được đề xuất.');
      const r = proposalRow(id);
      if (!r || r.status !== 'open') throw new LessonError('not_found', 'Đề xuất này không còn chờ duyệt.');
      db.prepare(`UPDATE learn_proposals SET status = 'dismissed', resolved_at = ? WHERE id = ?`).run(now(), id);
      if (r.kind === 'new') {
        // dropping a proposed lesson keeps it, as bi-bac-bo, so no bot proposes it again
        try {
          transition({ folderId: r.folder_id, relPath: r.rel_path }, 'bi-bac-bo', principal, { reason: 'Chủ bỏ đề xuất' });
        } catch (e) {
          if (!(e instanceof LessonError) || e.code !== 'not_found') throw e;
        }
      }
      deps.attention.resolve(attnKey(r.rel_path));
      deps.audit.log('lesson.proposal.dismiss', r.rel_path, { id, kind: r.kind, to: r.to_state }, principalName(principal));
      return proposalView(null, { ...r, status: 'dismissed' });
    },

    verified() {
      return listLessons().filter((l) => l.state === 'da-kiem-chung' && l.ownerVerified);
    },

    changes(fromSec, toSec) {
      const f = deps.folder().trim();
      if (!f) return [];
      const rows = db.prepare('SELECT rel_path, title, from_state, to_state, actor, reason, at FROM learn_lesson_log WHERE folder_id = ? AND at >= ? AND at < ? ORDER BY at DESC, id DESC')
        .all(f, fromSec, toSec) as Array<{ rel_path: string; title: string; from_state: string | null; to_state: string; actor: string; reason: string; at: number }>;
      return rows.filter((r) => isLessonState(r.to_state)).map((r) => ({
        path: r.rel_path, title: r.title, from: isLessonState(r.from_state) ? r.from_state : null, to: r.to_state as LessonState, actor: r.actor, reason: r.reason, at: r.at,
      }));
    },

    counts() {
      const c: Record<LessonState, number> = { 'gia-thuyet': 0, 'dang-thu': 0, 'da-kiem-chung': 0, 'bi-bac-bo': 0 };
      for (const l of listLessons()) c[l.state]++;
      return c;
    },
  };
}

