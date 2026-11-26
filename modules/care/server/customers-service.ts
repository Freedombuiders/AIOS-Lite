/**
 * `ctx.modules.get('care').customers`: read-only customer data for other ENABLED modules (crm writes the customer
 * notes from it). Values come back DECRYPTED, so this object is only handed out through `provides`; it has no HTTP
 * route and no agent action. Nothing here writes.
 */
import type Database from 'better-sqlite3';
import type { CareStage } from '../../_lib/care-kit/types.js';
import { CareCustomerFeed, type CustomerChange } from './persistence/customer-feed.js';
import type { CareStores } from './persistence/index.js';
import type { CareCustomerRecord } from '../../_lib/care-kit/types.js';

/** The need fields the Customer 360 form edits, in its order (web/lib/care/customer/model.ts NEED_FIELDS). */
export const CARE_NEED_FIELDS = ['service', 'dates', 'people', 'budget', 'details'] as const;
export type CareNeedField = (typeof CARE_NEED_FIELDS)[number];

export interface CareCustomerView {
  id: string;
  displayName: string;
  phone: string | null;
  email: string | null;
  company: string | null;
  stage: CareStage;
  /** the free-text tag field split on commas / semicolons / new lines, trimmed, empties dropped */
  tags: string[];
  owner: string | null;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
  /** time of the newest entry of the change feed for this customer (falls back to updatedAtMs) */
  lastChangeAtMs: number;
  /** what the customer needs, merged over every profile: per field, the most recently updated profile that has it */
  need: Array<{ field: CareNeedField; value: string }>;
  /** care note of the most recently updated profile that has one */
  careNote: string | null;
  /** tasks not done yet, earliest due first */
  openTasks: Array<{ id: string; title: string; dueAtMs: number }>;
}

export interface CareCustomerHistoryEntry extends CustomerChange {
  /** current title of the task an entry is about (null when the task is gone or the entry is not about a task) */
  taskTitle: string | null;
}

export interface CareCustomersApi {
  get(id: string): CareCustomerView | null;
  /** every customer, keyset by id; pass `next` back as `after` until it is null. limit 1..500 (default 100) */
  list(opts?: { after?: string | null; limit?: number }): { items: CareCustomerView[]; next: string | null };
  /** the durable change feed: rows after `cursor` (0 = from the start), oldest first */
  changesSince(cursor: number, limit?: number): { changes: CustomerChange[]; cursor: number };
  /** current end of the feed */
  latestCursor(): number;
  /** newest first */
  history(customerId: string, limit?: number): CareCustomerHistoryEntry[];
}

const splitTags = (tags: string | null): string[] =>
  (tags ?? '')
    .split(/[,;\n]/)
    .map((t) => t.trim())
    .filter(Boolean);

const scalarText = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
};

export function createCustomersApi(db: Database.Database, stores: () => CareStores): CareCustomersApi {
  const feed = new CareCustomerFeed(db);

  function view(c: CareCustomerRecord): CareCustomerView {
    const s = stores();
    const profiles = s.profiles.getProfilesByCustomer(c.id); // newest first
    const need: CareCustomerView['need'] = [];
    for (const field of CARE_NEED_FIELDS) {
      for (const p of profiles) {
        const v = scalarText(p.need?.[field]);
        if (v) {
          need.push({ field, value: v });
          break;
        }
      }
    }
    const careNote = profiles.map((p) => p.note?.trim()).find((n) => !!n) ?? null;
    const openTasks = s.tasks
      .listTasksByCustomer(c.id) // due ASC, id ASC
      .filter((t) => !t.done)
      .map((t) => ({ id: t.id, title: t.title, dueAtMs: t.dueAtMs }));
    return {
      id: c.id,
      displayName: c.displayName,
      phone: c.phone,
      email: c.email,
      company: c.company,
      stage: c.stage,
      tags: splitTags(c.tags),
      owner: c.owner,
      revision: c.revision,
      createdAtMs: c.createdAtMs,
      updatedAtMs: c.updatedAtMs,
      lastChangeAtMs: feed.lastChangeAt(c.id) ?? c.updatedAtMs,
      need,
      careNote,
      openTasks,
    };
  }

  return {
    get(id) {
      const c = stores().customers.getCustomer(id);
      return c ? view(c) : null;
    },
    list(opts = {}) {
      const page = stores().customers.pageCustomers({ afterId: opts.after ?? null, limit: opts.limit });
      return { items: page.items.map(view), next: page.next };
    },
    changesSince: (cursor, limit) => feed.changesSince(cursor, limit),
    latestCursor: () => feed.latest(),
    history(customerId, limit) {
      const tasks = stores().tasks;
      return feed.history(customerId, limit).map((e) => ({
        ...e,
        taskTitle: e.entity === 'task' ? (tasks.getTask(e.entityId)?.title ?? null) : null,
      }));
    },
  };
}
