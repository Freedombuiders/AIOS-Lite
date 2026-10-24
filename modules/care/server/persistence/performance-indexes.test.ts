/**
 * Additive performance indexes found by the CC-23 query-plan review (see PERFORMANCE_INDEXES in schema.ts and
 * docs/plans/customer-care/evidence/cc-23-regression-benchmarks.md).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createCareStores } from './index.js';
import { createCareSchema, PERFORMANCE_INDEXES } from './schema.js';
import { TEST_KEY } from '../test-fixtures.js';

describe('performance indexes (additive, idempotent)', () => {
  it('exist after boot, survive repeated boots and are present on a database that predates them', () => {
    const db = new Database(':memory:');
    try {
      createCareSchema(db);
      const names = () => new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>).map((r) => r.name));
      const wanted = PERFORMANCE_INDEXES.map((ddl) => /INDEX IF NOT EXISTS (\w+)/.exec(ddl)![1]);
      expect(wanted.length).toBeGreaterThanOrEqual(7);
      for (const n of wanted) expect(names().has(n), n).toBe(true);

      // An older database that never had them: drop, reboot, they come back; data is untouched.
      createCareStores(db, TEST_KEY).customers.createCustomer({ displayName: 'Keep me' });
      for (const n of wanted) db.exec(`DROP INDEX ${n}`);
      createCareSchema(db);
      createCareSchema(db);
      for (const n of wanted) expect(names().has(n), n).toBe(true);
      expect((db.prepare('SELECT COUNT(*) AS n FROM care_customers').get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('are used by the hot queries they were added for', () => {
    const db = new Database(':memory:');
    try {
      createCareSchema(db);
      const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
      expect(plan('SELECT id FROM care_customers ORDER BY updated_at DESC, id DESC LIMIT 50')).toMatch(/idx_care_customers_recent/);
      expect(plan(`SELECT id FROM care_tasks WHERE customer_id = 'c' ORDER BY due_at, id`)).toMatch(/idx_care_tasks_customer/);
      expect(plan('SELECT DISTINCT status FROM care_conversations')).toMatch(/idx_care_conversations_status_recent/);
      // The inbox status filter must not regress to "use the status index, then sort" (what a status-only index caused).
      const inbox = plan(`SELECT id FROM care_conversations c WHERE c.status = 'active' ORDER BY c.last_message_at DESC, c.id DESC LIMIT 50`);
      expect(inbox).toMatch(/idx_care_conversations_status_recent/);
      expect(inbox).not.toMatch(/TEMP B-TREE/);
      expect(plan('SELECT account_id, job_type, status, COUNT(*) FROM care_jobs GROUP BY account_id, job_type, status')).toMatch(/idx_care_jobs_health/);
      expect(plan(`SELECT COALESCE(MAX(source_version), 0) FROM care_source_journal WHERE source_kind = 'zalo' AND source_table = 't' AND source_id = '1'`)).toMatch(/COVERING INDEX idx_care_source_journal_row_ver/);
    } finally {
      db.close();
    }
  });
});
