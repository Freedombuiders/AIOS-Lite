// Pure helpers for `bai-hoc` notes: states, the optional machine-checkable rules of a lesson (`ap_dung`), and how a
// draft or a published post is checked against them. No I/O.
//
// A lesson note may carry, besides its text:
//   ap_dung:
//     dinh_dang: [video-ngan]   # the post is one of these formats
//     gio_dang: "19-21"          # posted from 19:00 to before 21:00, local time of the Page
//     thu: [3, 5]                # thứ Ba, thứ Năm (2 = thứ Hai … 7 = thứ Bảy, 8 or "cn" = Chủ nhật)
//     do_dai_toi_da: 45          # seconds for a video, words otherwise
//     do_dai_toi_thieu: 10
//     mo_dau: cau-hoi            # opening type; the only rule code cannot check (one lean run, see score-draft.ts)
// A lesson without `ap_dung` is still a lesson; it just cannot be checked by code.
import { DEFAULT_TZ, DINH_DANG_LABELS, MO_DAU_LABELS, VIDEO_FORMATS, slugify } from './note-format.js';

export const LESSON_DIR = 'bai-hoc';
export const LESSON_STATES = ['gia-thuyet', 'dang-thu', 'da-kiem-chung', 'bi-bac-bo'] as const;
export type LessonState = (typeof LESSON_STATES)[number];
export const STATE_LABELS: Record<LessonState, string> = {
  'gia-thuyet': 'Giả thuyết', 'dang-thu': 'Đang thử', 'da-kiem-chung': 'Đã kiểm chứng', 'bi-bac-bo': 'Bị bác bỏ',
};
export const AREAS = ['noi-dung', 'cham-khach', 'quang-cao'] as const;
export type Area = (typeof AREAS)[number];
export const AREA_LABELS: Record<Area, string> = { 'noi-dung': 'Nội dung', 'cham-khach': 'Chăm khách', 'quang-cao': 'Quảng cáo' };

export const isLessonState = (v: unknown): v is LessonState => typeof v === 'string' && (LESSON_STATES as readonly string[]).includes(v);
export const isArea = (v: unknown): v is Area => typeof v === 'string' && (AREAS as readonly string[]).includes(v);

/** Facebook format of marketing → `dinh_dang` (same as note-format FORMAT_TO_DINH_DANG). */
export const FB_FORMAT_TO_DINH_DANG: Record<string, string> = {
  reel: 'video-ngan', video: 'video', photo: 'anh', album: 'album', text: 'chu', link: 'lien-ket',
};

export interface LessonRules {
  dinhDang?: string[];
  /** [from, to) in hours, local time */
  gio?: { from: number; to: number };
  /** JS weekdays (0 = Sunday) */
  thu?: number[];
  doDaiToiDa?: number;
  doDaiToiThieu?: number;
  moDau?: string;
}

const VN_DAY: Record<number, string> = { 0: 'Chủ nhật', 1: 'thứ Hai', 2: 'thứ Ba', 3: 'thứ Tư', 4: 'thứ Năm', 5: 'thứ Sáu', 6: 'thứ Bảy' };

function dayOf(v: unknown): number | undefined {
  if (typeof v === 'string' && /^(cn|chu-nhat|chủ nhật)$/i.test(v.trim())) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n)) return undefined;
  if (n === 8 || n === 1) return 0;
  if (n >= 2 && n <= 7) return n - 1;
  return undefined;
}

const posNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

/** The rules of a lesson note; unknown or malformed values are ignored, never guessed. */
export function rulesOf(data: Record<string, unknown>): LessonRules {
  const a = data.ap_dung;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return {};
  const r = a as Record<string, unknown>;
  const out: LessonRules = {};
  const formats = (Array.isArray(r.dinh_dang) ? r.dinh_dang : typeof r.dinh_dang === 'string' ? [r.dinh_dang] : [])
    .filter((x): x is string => typeof x === 'string' && Object.hasOwn(DINH_DANG_LABELS, x));
  if (formats.length) out.dinhDang = formats;
  if (typeof r.gio_dang === 'string' || typeof r.gio_dang === 'number') {
    const m = String(r.gio_dang).trim().match(/^(\d{1,2})(?:h|:00)?\s*(?:-|–|đến)\s*(\d{1,2})(?:h|:00)?$/);
    if (m) {
      const from = Number(m[1]);
      const to = Number(m[2]);
      if (from >= 0 && from < 24 && to > from && to <= 24) out.gio = { from, to };
    }
  }
  const days = (Array.isArray(r.thu) ? r.thu : r.thu !== undefined ? [r.thu] : []).map(dayOf).filter((x): x is number => x !== undefined);
  if (days.length) out.thu = [...new Set(days)].sort();
  const max = posNum(r.do_dai_toi_da);
  const min = posNum(r.do_dai_toi_thieu);
  if (max !== undefined) out.doDaiToiDa = max;
  if (min !== undefined) out.doDaiToiThieu = min;
  if (typeof r.mo_dau === 'string' && Object.hasOwn(MO_DAU_LABELS, r.mo_dau)) out.moDau = r.mo_dau;
  return out;
}

export const hasRules = (r: LessonRules) => Object.keys(r).length > 0;

/** What is known about a draft or a post. `undefined` = unknown (the rule is then "không kiểm được"). */
export interface PostFacts {
  dinhDang?: string;
  /** local hour 0–23 and JS weekday at posting time */
  hour?: number;
  weekday?: number;
  /** seconds for a video, words otherwise */
  length?: number;
  moDau?: string;
}

export type RuleKey = 'dinh_dang' | 'gio_dang' | 'thu' | 'do_dai' | 'mo_dau';
export interface RuleCheck {
  rule: RuleKey;
  /** null = cannot be checked (fact unknown) */
  ok: boolean | null;
  text: string;
}

const lengthUnit = (f: PostFacts) => (f.dinhDang && VIDEO_FORMATS.has(f.dinhDang) ? 'giây' : 'chữ');

export function checkRules(r: LessonRules, f: PostFacts): RuleCheck[] {
  const out: RuleCheck[] = [];
  if (r.dinhDang) {
    const want = r.dinhDang.map((d) => DINH_DANG_LABELS[d]?.toLowerCase() ?? d).join(' hoặc ');
    out.push(f.dinhDang === undefined
      ? { rule: 'dinh_dang', ok: null, text: `Cần ${want}; chưa rõ định dạng` }
      : { rule: 'dinh_dang', ok: r.dinhDang.includes(f.dinhDang), text: r.dinhDang.includes(f.dinhDang) ? `Đúng định dạng (${want})` : `Bài này là ${DINH_DANG_LABELS[f.dinhDang]?.toLowerCase() ?? f.dinhDang}, bài học nói ${want}` });
  }
  if (r.gio) {
    const want = `${r.gio.from}–${r.gio.to} giờ`;
    out.push(f.hour === undefined
      ? { rule: 'gio_dang', ok: null, text: `Cần đăng trong khung ${want}; chưa hẹn giờ` }
      : f.hour >= r.gio.from && f.hour < r.gio.to
        ? { rule: 'gio_dang', ok: true, text: `Đúng giờ đăng (${want})` }
        : { rule: 'gio_dang', ok: false, text: `Hẹn ${f.hour} giờ, bài học nói ${want}` });
  }
  if (r.thu) {
    const want = r.thu.map((d) => VN_DAY[d]).join(', ');
    out.push(f.weekday === undefined
      ? { rule: 'thu', ok: null, text: `Cần đăng vào ${want}; chưa hẹn ngày` }
      : r.thu.includes(f.weekday)
        ? { rule: 'thu', ok: true, text: `Đúng ngày đăng (${want})` }
        : { rule: 'thu', ok: false, text: `Hẹn ${VN_DAY[f.weekday]}, bài học nói ${want}` });
  }
  if (r.doDaiToiDa !== undefined || r.doDaiToiThieu !== undefined) {
    const unit = lengthUnit(f);
    const want = r.doDaiToiThieu !== undefined && r.doDaiToiDa !== undefined
      ? `${r.doDaiToiThieu}–${r.doDaiToiDa} ${unit}`
      : r.doDaiToiDa !== undefined ? `tối đa ${r.doDaiToiDa} ${unit}` : `ít nhất ${r.doDaiToiThieu} ${unit}`;
    if (f.length === undefined) out.push({ rule: 'do_dai', ok: null, text: `Cần dài ${want}; chưa biết độ dài` });
    else {
      const ok = (r.doDaiToiDa === undefined || f.length <= r.doDaiToiDa) && (r.doDaiToiThieu === undefined || f.length >= r.doDaiToiThieu);
      out.push({ rule: 'do_dai', ok, text: ok ? `Đúng độ dài (${want})` : `Dài ${f.length} ${unit}, bài học nói ${want}` });
    }
  }
  if (r.moDau) {
    const want = MO_DAU_LABELS[r.moDau]?.toLowerCase() ?? r.moDau;
    out.push(f.moDau === undefined
      ? { rule: 'mo_dau', ok: null, text: `Cần mở đầu bằng ${want}; chưa xác định được` }
      : f.moDau === r.moDau
        ? { rule: 'mo_dau', ok: true, text: `Mở đầu bằng ${want}` }
        : { rule: 'mo_dau', ok: false, text: `Mở đầu kiểu ${MO_DAU_LABELS[f.moDau]?.toLowerCase() ?? (f.moDau === 'khac' ? 'khác' : f.moDau)}, bài học nói ${want}` });
  }
  return out;
}

/** A post follows a lesson when every rule could be checked and all hold. */
export function follows(r: LessonRules, f: PostFacts): boolean {
  const checks = checkRules(r, f);
  return checks.length > 0 && checks.every((c) => c.ok === true);
}

/** Local hour and weekday of a unix time in a timezone. */
export function localClock(sec: number, tz = DEFAULT_TZ): { hour: number; weekday: number } {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: DEFAULT_TZ, hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
  }
  const p = Object.fromEntries(fmt.formatToParts(new Date(sec * 1000)).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour) % 24, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(String(p.weekday)) };
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Facts of a published `bai-dang` note. The hour and weekday are read from `dang_luc`, already in the Page's time. */
export function factsOfPost(data: Record<string, unknown>): PostFacts {
  const f: PostFacts = {};
  const dd = str(data.dinh_dang);
  if (dd) f.dinhDang = dd;
  const m = str(data.dang_luc).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2})/);
  if (m) {
    f.hour = Number(m[4]);
    f.weekday = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  }
  const len = dd && VIDEO_FORMATS.has(dd) ? num(data.do_dai) : num(data.so_chu);
  if (len !== undefined) f.length = len;
  const mo = str(data.mo_dau) || slugify(str(data.kieu_hook));
  if (mo && Object.hasOwn(MO_DAU_LABELS, mo)) f.moDau = mo;
  else if (mo === 'ke-chuyen') f.moDau = 'cau-chuyen';
  return f;
}

/** "Ít mẫu", "thăm dò" for 3–4 posts. Never "đã chứng minh": a handful of posts proves nothing. */
export function sampleLabel(n: number): string {
  if (n <= 0) return 'chưa có bài';
  if (n < 3) return 'ít mẫu';
  if (n <= 4) return 'thăm dò';
  return `${n} bài`;
}

/** `[[slug]]` / `[[path/slug|nhãn]]` → `slug` / `path/slug` (no `.md`); undefined when not a wiki link. */
export function linkTarget(link: unknown): string | undefined {
  if (typeof link !== 'string') return undefined;
  const m = link.trim().match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/);
  if (!m) return undefined;
  return m[1]!.trim().replace(/\.md$/i, '');
}

/** Title of a lesson: `tieu_de`, else the first heading, else the file name. */
export function lessonTitle(relPath: string, data: Record<string, unknown>, body: string): string {
  const t = str(data.tieu_de);
  if (t) return t;
  const h = body.split(/\r?\n/).find((l) => /^#\s+\S/.test(l));
  if (h) return h.replace(/^#\s+/, '').trim();
  return relPath.split('/').pop()!.replace(/\.md$/, '');
}

/** One-paragraph summary of a lesson: `tom_tat`, else the first paragraph of the body that is not a heading. */
export function lessonSummary(data: Record<string, unknown>, body: string, max = 220): string {
  let s = str(data.tom_tat);
  if (!s) {
    const paras = body.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter((p) => p && !p.startsWith('#'));
    s = (paras[0] ?? '').replace(/\s+/g, ' ');
  }
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
