// What the machine writes into a customer note (OPEN-AGENTICOS-PLAN.md §4.2, `loai: khach-hang`).
//
// Machine-owned: the frontmatter keys in MANAGED_KEYS and the two managed blocks. Everything else in the file
// (other frontmatter keys, every line of the body outside the two blocks) belongs to the person.
//
// Only fields care really holds are written. care_customers has no nguon, gia_tri, da_mua, hang or zalo status:
// those keys are never written (a person may add them by hand; the machine leaves them alone).
import crypto from 'node:crypto';
import type { CareCustomerHistoryEntry, CareCustomerView, CareNeedField } from '../../care/server/customers-service.js';
import { slugify } from './slug.js';

export const NOTE_DIR = 'khach-hang';
export const BLOCK_NEED = 'khach-can-gi';
export const BLOCK_LOG = 'nhat-ky';
export const LOG_MAX = 20;

/** Written by the exporter on every export; a value the person typed there is overwritten. */
export const MANAGED_KEYS = ['loai', 'id', 'ten', 'sdt', 'giai_doan', 'the', 'viec_tiep', 'han', 'cap_nhat'] as const;
export type ManagedKey = (typeof MANAGED_KEYS)[number];

export const STAGE_SLUG = { new: 'moi', consulting: 'dang-tu-van', quoted: 'da-bao-gia', deposit: 'dat-coc', won: 'da-chot', lost: 'mat' } as const;
const STAGE_LABEL: Record<string, string> = { new: 'Mới', consulting: 'Đang tư vấn', quoted: 'Đã báo giá', deposit: 'Đặt cọc', won: 'Đã chốt', lost: 'Mất' };
const NEED_LABEL: Record<CareNeedField, string> = { service: 'Dịch vụ', dates: 'Thời gian', people: 'Số người', budget: 'Ngân sách', details: 'Chi tiết' };
const FIELD_LABEL: Record<string, string> = { ten: 'tên', cong_ty: 'công ty', sdt: 'số điện thoại', email: 'email', the: 'thẻ', phu_trach: 'người phụ trách' };

/** Vietnam has no daylight saving: a fixed +07:00 keeps every export of the same data byte-identical. */
const VN_OFFSET_MS = 7 * 3600_000;
const pad = (n: number) => String(n).padStart(2, '0');
function vnParts(ms: number) {
  const d = new Date(ms + VN_OFFSET_MS);
  return { y: d.getUTCFullYear(), mo: pad(d.getUTCMonth() + 1), d: pad(d.getUTCDate()), h: pad(d.getUTCHours()), mi: pad(d.getUTCMinutes()), s: pad(d.getUTCSeconds()) };
}
export const vnDate = (ms: number) => {
  const p = vnParts(ms);
  return `${p.y}-${p.mo}-${p.d}`;
};
export const vnIso = (ms: number) => {
  const p = vnParts(ms);
  return `${p.y}-${p.mo}-${p.d}T${p.h}:${p.mi}:${p.s}+07:00`;
};
const vnShort = (ms: number) => {
  const p = vnParts(ms);
  return `${p.d}/${p.mo}/${p.y} ${p.h}:${p.mi}`;
};

/** one line, no markdown structure, bounded: free text from the database must not break the list */
const oneLine = (s: string, max = 120) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** The managed keys; `undefined` = the key must not be in the file (patch removes it). */
export function managedFrontmatter(v: CareCustomerView): Record<ManagedKey, unknown> {
  const next = v.openTasks[0];
  const tags = [...new Set(v.tags.map((t) => slugify(t)))];
  return {
    loai: 'khach-hang',
    id: v.id,
    ten: v.displayName,
    sdt: v.phone ?? undefined,
    giai_doan: STAGE_SLUG[v.stage],
    the: tags.length ? tags : undefined,
    viec_tiep: next ? oneLine(next.title, 200) : undefined,
    han: next ? vnDate(next.dueAtMs) : undefined,
    cap_nhat: vnIso(v.lastChangeAtMs),
  };
}

export function needBlock(v: CareCustomerView): string {
  const lines = ['## Khách cần gì', ''];
  if (!v.need.length && !v.careNote) lines.push('Chưa có thông tin.');
  for (const n of v.need) lines.push(`- ${NEED_LABEL[n.field]}: ${oneLine(n.value, 300)}`);
  if (v.careNote) lines.push(`- Ghi chú chăm sóc: ${oneLine(v.careNote, 300)}`);
  return lines.join('\n') + '\n';
}

/** A short line per change; never a message body. */
export function logLine(e: CareCustomerHistoryEntry): string {
  const d = e.detail ?? {};
  const title = e.taskTitle ? `: ${oneLine(e.taskTitle, 80)}` : '';
  let what: string;
  if (e.entity === 'customer') {
    if (e.op === 'insert') what = 'Tạo khách';
    else if (e.op === 'delete') what = 'Xoá khách';
    else {
      const parts: string[] = [];
      if (d.stage_to) parts.push(`Đổi giai đoạn: ${STAGE_LABEL[String(d.stage_from)] ?? d.stage_from} → ${STAGE_LABEL[String(d.stage_to)] ?? d.stage_to}`);
      const fields = String(d.fields ?? '')
        .split(',')
        .filter(Boolean)
        .map((f) => FIELD_LABEL[f] ?? f);
      if (fields.length) parts.push(`Cập nhật ${fields.join(', ')}`);
      what = parts.join('; ') || 'Cập nhật thông tin';
    }
  } else if (e.entity === 'profile') {
    if (d.moved_to) what = 'Hồ sơ chuyển sang khách khác';
    else if (d.moved_from) what = 'Nhận hồ sơ từ khách khác';
    else what = e.op === 'delete' ? 'Xoá hồ sơ nhu cầu' : 'Cập nhật nhu cầu';
  } else if (e.op === 'insert') what = `Thêm việc${title}`;
  else if (e.op === 'delete') what = 'Bỏ một việc';
  else if (d.moved_to) what = `Việc chuyển sang khách khác${title}`;
  else if (d.done_to === 1 && d.done_from === 0) what = `Xong việc${title}`;
  else if (d.done_to === 0 && d.done_from === 1) what = `Mở lại việc${title}`;
  else if (d.due_to !== d.due_from && typeof d.due_to === 'number') what = `Đổi hạn việc${title} → ${vnDate(d.due_to)}`;
  else what = `Sửa việc${title}`;
  return `- ${vnShort(e.atMs)} · ${what}`;
}

export function logBlock(history: CareCustomerHistoryEntry[]): string {
  const lines = ['## Nhật ký', ''];
  const entries = history.slice(0, LOG_MAX);
  if (!entries.length) lines.push('Chưa có thay đổi nào.');
  for (const e of entries) lines.push(logLine(e));
  return lines.join('\n') + '\n';
}

export interface RenderedNote {
  frontmatter: Record<ManagedKey, unknown>;
  need: string;
  log: string;
  /** sha256 of the machine-owned content */
  contentHash: string;
}

export function renderNote(v: CareCustomerView, history: CareCustomerHistoryEntry[]): RenderedNote {
  const frontmatter = managedFrontmatter(v);
  const need = needBlock(v);
  const log = logBlock(history);
  const contentHash = crypto
    .createHash('sha256')
    .update(JSON.stringify([MANAGED_KEYS.map((k) => frontmatter[k] ?? null), need, log]))
    .digest('hex');
  return { frontmatter, need, log, contentHash };
}

/** Body of a brand-new note: a title; the two blocks are appended by setBlock, the rest is the person's. */
export const newNoteBody = (v: CareCustomerView) => `# ${oneLine(v.displayName, 200)}\n`;
