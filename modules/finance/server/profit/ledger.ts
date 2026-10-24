import { randomUUID } from 'node:crypto';
import type { DB } from '../../../../src/core/db.js';
import { KEY_LEDGER, KEY_LEDGER_ADS, kvGet, kvSet } from '../kv.js';
import { dateSchema, documentSchema, emptyDocument, KINDS, type AdSpend, type ProfitDocument } from './model.js';

export const vnToday = (now = Date.now()): string => new Date(now + 7 * 3600_000).toISOString().slice(0, 10);

export class LedgerError extends Error {
  constructor(message: string, readonly status: 400 | 409 = 400) { super(message); }
}

export const readRevision = (db: DB): string => kvGet(db, KEY_LEDGER) ?? '';

export function readDocument(db: DB): ProfitDocument {
  const raw = kvGet(db, KEY_LEDGER);
  return raw ? documentSchema.parse(JSON.parse(raw)) : emptyDocument();
}

export const readArchivedAds = (db: DB): AdSpend[] => JSON.parse(kvGet(db, KEY_LEDGER_ADS) ?? '[]') as AdSpend[];

/** Save the whole ledger; `revision` must equal the stored one (optimistic concurrency across tabs). */
export function saveDocument(db: DB, input: unknown, revision: unknown): { revision: string; document: ProfitDocument } {
  const parsed = documentSchema.safeParse(input);
  if (!parsed.success) throw new LedgerError(parsed.error.issues.map((i) => i.message).join('; '));
  if (revision !== readRevision(db)) throw new LedgerError('Dữ liệu đã thay đổi ở phiên khác. Tải lại trước khi lưu.', 409);
  const next = JSON.stringify(parsed.data);
  kvSet(db, KEY_LEDGER, next);
  return { revision: next, document: parsed.data };
}

/** Meta ad accounts known to the `ads` module (empty when that module was never added). */
export function listAdAccounts(db: DB): Array<{ id: string; name: string; currency: string; syncedAt: number | null; timezone: string }> {
  try {
    return db.prepare('SELECT id, name, currency, synced_at AS syncedAt, timezone FROM fb_ad_accounts').all() as never;
  } catch {
    return [];
  }
}

interface AdsDailyRow { day: string; level: string; object_id: string; name: string; spend: number; captured_at: number }

/**
 * Archive daily ad spend by a stable key, so repeated imports never double count. The account residual keeps
 * spend that has no campaign detail. Reads the `ads` module's tables; a no-op when they do not exist.
 */
export function importAds(db: DB): AdSpend[] {
  const data = new Map(readArchivedAds(db).map((a) => [`${a.accountId}:${a.campaignId}:${a.day}`, a]));
  for (const account of listAdAccounts(db)) {
    let source: AdsDailyRow[] = [];
    try {
      source = db.prepare(`SELECT day, level, object_id, name, spend, captured_at FROM fb_ads_daily
        WHERE account_id = ? AND level IN ('account', 'campaign')`).all(account.id) as AdsDailyRow[];
    } catch { /* ads module absent */ }
    for (const day of new Set(source.map((r) => r.day))) {
      for (const [key, value] of data) if (value.accountId === account.id && value.day === day) data.delete(key);
      const campaigns = source.filter((r) => r.day === day && r.level === 'campaign');
      for (const r of campaigns) data.set(`${account.id}:${r.object_id}:${day}`, { accountId: account.id, campaignId: r.object_id, name: r.name, day, currency: account.currency, spend: r.spend, capturedAt: r.captured_at });
      const total = source.find((r) => r.day === day && r.level === 'account');
      const residual = Math.max(0, (total?.spend ?? 0) - campaigns.reduce((s, r) => s + r.spend, 0));
      if (residual > 0) data.set(`${account.id}:__unallocated:${day}`, { accountId: account.id, campaignId: '__unallocated', name: 'Chưa có chi tiết chiến dịch', day, currency: account.currency, spend: residual, capturedAt: total!.captured_at });
    }
  }
  const ads = [...data.values()];
  kvSet(db, KEY_LEDGER_ADS, JSON.stringify(ads));
  return ads;
}

const ENTRY_KINDS = Object.keys(KINDS) as Array<keyof typeof KINDS>;
const CASH_ONLY = new Set(['investment', 'financing', 'ad_payment']);

export interface NewEntry {
  kind: keyof typeof KINDS;
  amount: number;
  note: string;
  date?: string;
  productId?: string;
  /** cash actually moved; defaults to `amount` (or is required for cash-only kinds, which book 0) */
  cash?: number;
  cashDate?: string | null;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : undefined);

/** Validate an agent/API payload and append it to the ledger. Errors are Vietnamese. */
export function addEntry(db: DB, payload: unknown, now = Date.now()): { id: string; document: ProfitDocument } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const kind = p.kind as keyof typeof KINDS;
  if (!ENTRY_KINDS.includes(kind)) throw new LedgerError(`Loại khoản không hợp lệ. Chọn một trong: ${ENTRY_KINDS.join(', ')}.`);
  const amount = num(p.amount);
  if (amount === undefined || !Number.isFinite(amount)) throw new LedgerError('Số tiền phải là một số.');
  if (amount <= 0) throw new LedgerError('Số tiền phải lớn hơn 0.');
  if (amount > 1e13) throw new LedgerError('Số tiền quá lớn.');
  const note = typeof p.note === 'string' ? p.note.trim() : '';
  if (!note) throw new LedgerError('Cần ghi chú ngắn cho khoản thu chi.');
  if (note.length > 500) throw new LedgerError('Ghi chú tối đa 500 ký tự.');
  const date = p.date === undefined ? vnToday(now) : p.date;
  if (!dateSchema.safeParse(date).success) throw new LedgerError('Ngày không hợp lệ, dùng dạng YYYY-MM-DD.');
  const productId = typeof p.productId === 'string' ? p.productId : '';

  const doc = readDocument(db);
  if (productId && !doc.products.some((x) => x.id === productId)) throw new LedgerError('Sản phẩm không tồn tại trong sổ.');
  if ((date as string) < doc.startDate) {
    if (doc.entries.length === 0) doc.startDate = date as string;
    else throw new LedgerError(`Ngày ghi trước ngày bắt đầu sổ (${doc.startDate}).`);
  }

  const cashOnly = CASH_ONLY.has(kind);
  const cashGiven = num(p.cash);
  if (cashGiven !== undefined && (!Number.isFinite(cashGiven) || cashGiven < 0)) throw new LedgerError('Số tiền thực thu / chi không hợp lệ.');
  const cash = cashGiven ?? amount;
  const cashDate = p.cashDate === undefined || p.cashDate === null ? (cash > 0 ? date : null) : p.cashDate;
  if (cashDate !== null && !dateSchema.safeParse(cashDate).success) throw new LedgerError('Ngày thực thu / chi không hợp lệ.');
  if (cashDate !== null && (cashDate as string) < doc.startDate) throw new LedgerError('Ngày thực thu / chi trước ngày bắt đầu sổ.');

  const id = randomUUID();
  doc.entries.push({
    id, productId, kind, date: date as string, amount: cashOnly ? 0 : amount, cashDate: cashDate as string | null,
    cash: cashOnly && cashGiven === undefined ? amount : cash, note, customerType: 'na', customers: 0,
  });
  const parsed = documentSchema.safeParse(doc);
  if (!parsed.success) throw new LedgerError(parsed.error.issues.map((i) => i.message).join('; '));
  kvSet(db, KEY_LEDGER, JSON.stringify(parsed.data));
  return { id, document: parsed.data };
}
