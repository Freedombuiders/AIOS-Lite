// What the customer screens read (read-only). Built from care's customer view and the exporter's index row, so the
// screens work from the database even when no notes folder is set.
import type { CareCustomerHistoryEntry, CareCustomerView } from '../../care/server/customers-service.js';
import { logWhat, NEED_LABEL, STAGE_SLUG } from './note.js';

export interface NoteIndexRow {
  folder_id: string;
  rel_path: string;
  exported_at: number;
}

export type NoteState = 'da-xuat' | 'cho-xuat' | 'chua-xuat';

export interface CustomerRowDto {
  id: string;
  ten: string;
  sdt: string | null;
  email: string | null;
  congTy: string | null;
  /** care's stage key (new, consulting, quoted, deposit, won, lost) */
  giaiDoan: CareCustomerView['stage'];
  /** the same stage as written in the note's `giai_doan` */
  giaiDoanGhiChu: string;
  /** tags as the person typed them (the note holds slugs) */
  the: string[];
  /** earliest open follow-up */
  viecTiep: { id: string; title: string; dueAtMs: number } | null;
  soViec: number;
  revision: number;
  capNhatMs: number;
  folderId: string | null;
  notePath: string | null;
  exportedAt: number | null;
  /** da-xuat: the note was written after the customer's last change; cho-xuat: a change is not exported yet */
  trangThai: NoteState;
}

export function customerRow(v: CareCustomerView, row: NoteIndexRow | undefined, folderId: string | null): CustomerRowDto {
  const inFolder = !!row && !!folderId && row.folder_id === folderId;
  const next = v.openTasks[0];
  return {
    id: v.id,
    ten: v.displayName,
    sdt: v.phone,
    email: v.email,
    congTy: v.company,
    giaiDoan: v.stage,
    giaiDoanGhiChu: STAGE_SLUG[v.stage],
    the: v.tags,
    viecTiep: next ? { id: next.id, title: next.title, dueAtMs: next.dueAtMs } : null,
    soViec: v.openTasks.length,
    revision: v.revision,
    capNhatMs: v.lastChangeAtMs,
    folderId: inFolder ? row!.folder_id : null,
    notePath: inFolder ? row!.rel_path : null,
    exportedAt: inFolder ? row!.exported_at : null,
    trangThai: !inFolder ? 'chua-xuat' : row!.exported_at >= v.lastChangeAtMs ? 'da-xuat' : 'cho-xuat',
  };
}

export interface CustomerDetailDto extends CustomerRowDto {
  nhuCau: Array<{ field: string; label: string; value: string }>;
  ghiChuChamSoc: string | null;
  viecMo: Array<{ id: string; title: string; dueAtMs: number }>;
  nhatKy: Array<{ atMs: number; text: string }>;
}

export function customerDetail(v: CareCustomerView, history: CareCustomerHistoryEntry[], row: NoteIndexRow | undefined, folderId: string | null): CustomerDetailDto {
  return {
    ...customerRow(v, row, folderId),
    nhuCau: v.need.map((n) => ({ field: n.field, label: NEED_LABEL[n.field], value: n.value })),
    ghiChuChamSoc: v.careNote,
    viecMo: v.openTasks,
    nhatKy: history.slice(0, 20).map((e) => ({ atMs: e.atMs, text: logWhat(e) })),
  };
}
