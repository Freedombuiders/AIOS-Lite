// Frontmatter schema per note type (`loai`). Key names follow OPEN-AGENTICOS-PLAN.md §4.2.
// Objects are loose on purpose: keys the owner adds in Obsidian are kept, only the known keys are checked.
// A blank YAML value (`sdt:`) reads as null, so optional keys also accept null.
import { z } from 'zod';

const opt = <T extends z.ZodType>(t: T) => t.nullish();
const str = opt(z.string());
const num = opt(z.number());
/** `2026-11-28` or `2026-11-26T09:44:00+07:00`; YAML 1.2 keeps both as strings. */
const date = opt(z.string().regex(/^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/, 'cần ngày dạng YYYY-MM-DD hoặc ISO 8601'));
/** `[[slug]]` or `[[slug|nhãn]]` */
const wikiLink = z.string().regex(/^\[\[[^\]|]+(?:\|[^\]]*)?\]\]$/, 'cần liên kết dạng [[ten-ghi-chu]]');
const strList = opt(z.array(z.string()));

const MO_DAU = ['cau-hoi', 'con-so', 'ten-san-pham', 'cau-chuyen', 'chi-loi-sai'] as const;
const NEN_TANG = ['facebook', 'instagram', 'tiktok', 'youtube', 'zalo', 'threads', 'web'] as const;

const SO_DO = z.looseObject({
  moc: z.string().min(1),
  luc_do: date,
  reach: num,
  er: num,
  tb_xem: num,
});

export const NOTE_SCHEMAS = {
  'khach-hang': z.looseObject({
    loai: z.literal('khach-hang'),
    id: z.string().min(1),
    ten: z.string().min(1),
    sdt: opt(z.union([z.string(), z.number()])),
    zalo: opt(z.enum(['ban-be', 'chua-ket-ban'])),
    nguon: str,
    giai_doan: opt(z.enum(['moi', 'dang-tu-van', 'da-bao-gia', 'dat-coc', 'da-chot', 'mat'])),
    the: strList,
    gia_tri: num,
    da_mua: num,
    hang: opt(z.enum(['A', 'B', 'C'])),
    viec_tiep: str,
    han: date,
    cap_nhat: date,
  }),
  'bai-dang': z.looseObject({
    loai: z.literal('bai-dang'),
    /** fb_content.id is an INTEGER; KOL keys are strings */
    id: z.union([z.string().min(1), z.number().int()]),
    // lineage: which idea, formula (and its version) and Dream 100 video this post came from
    de_xuat: opt(z.union([z.string().min(1), z.number()])),
    cong_thuc: opt(wikiLink),
    cong_thuc_phien_ban: opt(z.union([z.number(), z.string().min(1)])),
    hoc_tu: opt(wikiLink),
    nen_tang: z.enum(NEN_TANG),
    dinh_dang: opt(z.enum(['video-ngan', 'anh', 'chu', 'album'])),
    tru_cot: str,
    mo_dau: opt(z.enum(MO_DAU)),
    do_dai: num,
    dang_luc: date,
    /** one snapshot per milestone (1h, 6h, 24h…), appended, never overwritten */
    so_do: opt(z.array(SO_DO)),
    /** latest values, kept for readers of the plan's first draft; so_do is the history */
    reach: num,
    er: num,
    tb_xem: num,
    so_voi_ky_vong: num,
    moc_da_do: strList,
  }),
  'cong-thuc': z.looseObject({
    loai: z.literal('cong-thuc'),
    mo_dau: opt(z.enum(MO_DAU)),
    cau_truc: str,
    do_dai_toi_da: num,
    cat_moi_phut: num,
    ky_vong: num,
    bang_chung: num,
    da_lam: num,
    ket_qua: num,
    trang_thai: z.enum(['chua-thu', 'co-ve-hop', 'hop', 'chua-hop']),
  }),
  'bai-hoc': z.looseObject({
    loai: z.literal('bai-hoc'),
    mang: z.enum(['noi-dung', 'cham-khach', 'quang-cao']),
    trang_thai: z.enum(['gia-thuyet', 'dang-thu', 'da-kiem-chung', 'bi-bac-bo']),
    bang_chung: opt(z.array(wikiLink)),
    dung_boi: strList,
  }),
  'kenh-dream': z.looseObject({
    loai: z.literal('kenh-dream'),
    nen_tang: z.enum(NEN_TANG),
    link: z.string().url(),
    hoc_gi: str,
    trung_vi_xem: num,
    lay_bang: str,
  }),
  'video-dream': z.looseObject({
    loai: z.literal('video-dream'),
    kenh: z.string().min(1),
    luot_xem: num,
    gap_trung_vi: num,
    mo_dau: opt(z.enum(MO_DAU)),
    do_dai: num,
    cat_moi_phut: num,
    cong_thuc: opt(wikiLink),
  }),
  // the plan does not list keys for these two yet: only `loai` is checked
  'tong-ket': z.looseObject({ loai: z.literal('tong-ket') }),
  'de-xuat': z.looseObject({ loai: z.literal('de-xuat') }),
} as const;

export type NoteType = keyof typeof NOTE_SCHEMAS;
export const NOTE_TYPES = Object.keys(NOTE_SCHEMAS) as NoteType[];

export function isNoteType(v: unknown): v is NoteType {
  return typeof v === 'string' && Object.hasOwn(NOTE_SCHEMAS, v);
}

/**
 * Problems with `data` for its `loai`, as readable lines (`ten: …`). Empty = fine.
 * A note without `loai`, or with a `loai` this app does not know (the owner's own type), is not checked.
 */
export function checkNote(data: Record<string, unknown>): string[] {
  const loai = data.loai;
  if (loai === undefined || loai === null) return [];
  if (!isNoteType(loai)) return [];
  const r = NOTE_SCHEMAS[loai].safeParse(data);
  if (r.success) return [];
  return r.error.issues.map((i) => `${i.path.join('.') || 'nội dung'}: ${i.message}`);
}
