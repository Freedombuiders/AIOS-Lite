// Pure mapping from a marketing content row (contentFeed.get) to a `bai-dang` note: path, frontmatter written at
// creation, the `so_do` list (one entry per milestone, merged, never overwriting other milestones), and the text of
// the managed block that shows the milestones as a table. No I/O here.
import type { ContentSnapshot, ContentWithLineage } from '../../_lib/content-feed.js';

export const NOTE_DIR = 'noi-dung/bai';
export const BLOCK_NAME = 'so-do';
export const SOURCE = 'facebook';
export const DEFAULT_TZ = 'Asia/Ho_Chi_Minh';

/** Fixed milestones in time order; 'latest' is the rolling daily snapshot and is never compared. */
export const MILESTONES = ['1h', '6h', '24h', '3d', '7d', '28d'] as const;
export const MILESTONE_ORDER: readonly string[] = [...MILESTONES, 'latest'];
export const MILESTONE_LABELS: Record<string, string> = {
  '1h': '1 giờ', '6h': '6 giờ', '24h': '24 giờ', '3d': '3 ngày', '7d': '7 ngày', '28d': '28 ngày', latest: 'Mới nhất',
};

/** Facebook format → `dinh_dang` of the note schema. */
export const FORMAT_TO_DINH_DANG: Record<string, string> = {
  reel: 'video-ngan', video: 'video', photo: 'anh', album: 'album', text: 'chu', link: 'lien-ket',
};
export const DINH_DANG_LABELS: Record<string, string> = {
  'video-ngan': 'Video ngắn', video: 'Video', anh: 'Ảnh', album: 'Album', chu: 'Chữ', 'lien-ket': 'Liên kết',
};
export const VIDEO_FORMATS = new Set(['video-ngan', 'video']);

/** `mo_dau` values of the schema, and the marketing hook types (analyst.ts HOOK_TYPES) that mean the same. */
export const MO_DAU_LABELS: Record<string, string> = {
  'cau-hoi': 'Câu hỏi', 'con-so': 'Con số', 'ten-san-pham': 'Tên sản phẩm', 'cau-chuyen': 'Câu chuyện', 'chi-loi-sai': 'Chỉ lỗi sai',
};
const HOOK_SLUG_TO_MO_DAU: Record<string, string> = {
  'cau-hoi': 'cau-hoi', 'con-so': 'con-so', 'ten-san-pham': 'ten-san-pham', 'cau-chuyen': 'cau-chuyen', 'ke-chuyen': 'cau-chuyen',
  'chi-loi-sai': 'chi-loi-sai',
};

/** Lowercase ASCII slug: Vietnamese marks removed, đ → d, anything else → '-'. */
export function slugify(text: string, maxLen = 60): string {
  const s = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const dash = cut.lastIndexOf('-');
  return (dash > maxLen / 2 ? cut.slice(0, dash) : cut).replace(/-+$/g, '');
}

/** Marketing's free-text hook type mapped onto the schema's `mo_dau`, or undefined when it has no equivalent. */
export function moDauOf(hookType: string): string | undefined {
  return HOOK_SLUG_TO_MO_DAU[slugify(hookType)];
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
}

/** What the note calls the post: the title, else the first line of the caption, shortened. */
export function titleOf(c: Pick<ContentWithLineage, 'title' | 'caption' | 'id'>): string {
  const t = c.title.trim() || firstLine(c.caption);
  if (!t) return `Bài #${c.id}`;
  return t.length > 90 ? `${t.slice(0, 87).trimEnd()}…` : t;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Parts of a unix time in a timezone. */
function parts(sec: number, tz: string): Record<string, string> {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23', timeZoneName: 'longOffset',
    });
  } catch {
    return parts(sec, DEFAULT_TZ);
  }
  return Object.fromEntries(fmt.formatToParts(new Date(sec * 1000)).map((p) => [p.type, p.value]));
}

/** `2026-11-24` in the timezone. */
export function localDate(sec: number, tz: string): string {
  const p = parts(sec, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** `2026-11-24T19:00:00+07:00` in the timezone. */
export function localIso(sec: number, tz: string): string {
  const p = parts(sec, tz);
  const off = (p.timeZoneName ?? 'GMT').replace(/^GMT/, '') || '+00:00';
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off === 'Z' ? 'Z' : off}`;
}

/** `noi-dung/bai/<date>-<slug>.md`; `withId` adds the content id when another post already took the name. */
export function notePath(c: ContentWithLineage, tz: string, withId = false): string {
  const date = localDate(c.publishedAt ?? c.createdAt, tz);
  const slug = slugify(titleOf(c), 50) || 'bai';
  return `${NOTE_DIR}/${date}-${slug}${withId ? `-${c.id}` : ''}.md`;
}

/** Video length in whole seconds from the snapshots, when Facebook returned one. */
export function videoLengthOf(snapshots: readonly ContentSnapshot[]): number | undefined {
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const v = snapshots[i]!.videoLengthS;
    if (v !== null && Number.isFinite(v) && v > 0) return Math.round(v);
  }
  return undefined;
}

const wiki = (slug: string | null | undefined) => (slug ? `[[${slug}]]` : undefined);

/** Frontmatter of a new note. Keys without a value are left out, never written as 0 or ''. */
export function initialData(c: ContentWithLineage, tz: string): Record<string, unknown> {
  const dinhDang = FORMAT_TO_DINH_DANG[c.format];
  const lineage = c.lineage;
  const snapshots = mergeSoDo([], c.snapshots, tz);
  const data: Record<string, unknown> = {
    loai: 'bai-dang',
    id: c.id,
    nen_tang: 'facebook',
    tieu_de: titleOf(c),
    dinh_dang: dinhDang,
    tru_cot: c.pillar.trim() || undefined,
    mo_dau: moDauOf(c.hookType),
    kieu_hook: c.hookType.trim() || undefined,
    do_dai: dinhDang && VIDEO_FORMATS.has(dinhDang) ? videoLengthOf(c.snapshots) : undefined,
    so_chu: c.caption.trim() ? wordCount(c.caption) : undefined,
    dang_luc: c.publishedAt !== null ? localIso(c.publishedAt, tz) : undefined,
    ma_bai: c.fbPostId ?? undefined,
    link: c.permalink || undefined,
    de_xuat: lineage?.ideaId ?? undefined,
    cong_thuc: wiki(lineage?.formulaSlug),
    cong_thuc_phien_ban: lineage?.formulaVersion ?? undefined,
    hoc_tu: wiki(lineage?.sourceVideoSlug),
    ky_vong: lineage?.expectedRatio ?? undefined,
    so_do: snapshots,
    moc_da_do: measuredMilestones(snapshots),
  };
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
}

export type SoDoEntry = Record<string, unknown> & { moc: string };

const round = (n: number, dp: number) => Math.round((n + Number.EPSILON) * 10 ** dp) / 10 ** dp;

/** One `so_do` entry: only the values Facebook returned (null stays absent, never 0). */
export function soDoEntry(s: ContentSnapshot, tz: string): SoDoEntry {
  const e: SoDoEntry = { moc: s.milestone, luc_do: localIso(s.capturedAt, tz) };
  const put = (key: string, v: number | null | undefined, dp = 0) => {
    if (v !== null && v !== undefined && Number.isFinite(v)) e[key] = dp ? round(v, dp) : Math.round(v);
  };
  put('reach', s.reach);
  put('er', s.er, 2);
  put('tb_xem', s.avgWatchS, 1);
  put('hien_thi', s.impressions);
  put('cam_xuc', s.reactions);
  put('binh_luan', s.comments);
  put('chia_se', s.shares);
  put('click', s.clicks);
  put('xem_3s', s.videoViews3s);
  put('theo_doi', s.follows);
  put('luu', s.saves);
  return e;
}

/** Keys of a `so_do` entry that the machine writes. */
const MACHINE_KEYS = new Set(['moc', 'luc_do', 'reach', 'er', 'tb_xem', 'hien_thi', 'cam_xuc', 'binh_luan', 'chia_se', 'click', 'xem_3s', 'theo_doi', 'luu']);

const orderOf = (moc: string) => {
  const i = MILESTONE_ORDER.indexOf(moc);
  return i === -1 ? MILESTONE_ORDER.length : i;
};

/**
 * The note's `so_do` with one entry per milestone marketing measured replaced by marketing's numbers. Entries
 * of other milestones (including ones the owner typed) are kept as they are. Sorted by milestone order.
 */
export function mergeSoDo(existing: unknown, snapshots: readonly ContentSnapshot[], tz: string): SoDoEntry[] {
  const byMoc = new Map<string, SoDoEntry>();
  const kept: SoDoEntry[] = [];
  if (Array.isArray(existing)) {
    for (const e of existing) {
      if (e && typeof e === 'object' && typeof (e as { moc?: unknown }).moc === 'string') byMoc.set((e as SoDoEntry).moc, e as SoDoEntry);
      else kept.push(e as SoDoEntry); // not an entry we understand: leave it for the owner
    }
  }
  for (const s of snapshots) {
    // machine keys come from marketing (a value that became unknown disappears); keys the owner added stay
    const owner = Object.entries(byMoc.get(s.milestone) ?? {}).filter(([k]) => !MACHINE_KEYS.has(k));
    byMoc.set(s.milestone, { ...soDoEntry(s, tz), ...Object.fromEntries(owner) });
  }
  const list = [...byMoc.values()].sort((a, b) => orderOf(a.moc) - orderOf(b.moc));
  return [...list, ...kept];
}

/** Fixed milestones that have an entry, in order ('latest' is not a milestone). */
export function measuredMilestones(soDo: readonly SoDoEntry[]): string[] {
  return MILESTONES.filter((m) => soDo.some((e) => e?.moc === m));
}

const fmtInt = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('vi-VN') : '—');
const fmtPct = (v: unknown) => (typeof v === 'number' ? `${v.toLocaleString('vi-VN', { maximumFractionDigits: 2 })}%` : '—');
const fmtSec = (v: unknown) => (typeof v === 'number' ? `${v.toLocaleString('vi-VN', { maximumFractionDigits: 1 })} giây` : '—');
const fmtWhen = (v: unknown) => (typeof v === 'string' ? v.replace('T', ' ').slice(0, 16) : '—');

/** Text of the managed block: a short table of the milestones. */
export function blockMarkdown(soDo: readonly SoDoEntry[]): string {
  const rows = soDo.filter((e) => e && typeof e.moc === 'string');
  if (!rows.length) return '_Chưa có số đo. Máy tự đo ở các mốc 1 giờ, 6 giờ, 24 giờ, 3 ngày, 7 ngày và 28 ngày._\n';
  const lines = [
    '| Mốc | Lúc đo | Reach | ER | Xem TB | Bình luận | Chia sẻ |',
    '|---|---|---:|---:|---:|---:|---:|',
    ...rows.map((e) => `| ${MILESTONE_LABELS[e.moc] ?? e.moc} | ${fmtWhen(e.luc_do)} | ${fmtInt(e.reach)} | ${fmtPct(e.er)} | ${fmtSec(e.tb_xem)} | ${fmtInt(e.binh_luan)} | ${fmtInt(e.chia_se)} |`),
  ];
  return `${lines.join('\n')}\n\n_Máy ghi từ số liệu Facebook; ô "—" là Facebook không trả số đó._\n`;
}

/** Body of a new note: the person's part (title, caption, a place for notes), then the managed block. */
export function initialBody(c: ContentWithLineage, soDo: readonly SoDoEntry[]): string {
  const caption = c.caption.trim();
  const out = [`# ${titleOf(c)}`, ''];
  if (caption) out.push(caption, '');
  out.push('## Ghi chú', '', '', '## Số đo theo mốc', '', `<!-- aios:begin ${BLOCK_NAME} -->`, blockMarkdown(soDo).replace(/\n$/, ''), `<!-- aios:end ${BLOCK_NAME} -->`, '');
  return out.join('\n');
}
