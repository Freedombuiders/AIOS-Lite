import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from '../../../src/core/db.js';
import type { ModuleContext } from '../../../src/modules/sdk.js';
import manifest from '../module.json' with { type: 'json' };
import type { McpConnector, McpSession } from './mcp.js';

const SQL = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '001_init.sql'), 'utf8');

/** In-memory DB with the finance tables, plus the optional ads/runs tables other modules own. */
export function testDb(opts: { ads?: boolean } = {}): DB {
  const db = openDb(':memory:');
  db.exec(SQL);
  db.exec(`CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, cost_usd REAL)`);
  if (opts.ads) {
    db.exec(`CREATE TABLE fb_ad_accounts (id TEXT PRIMARY KEY, name TEXT, currency TEXT, timezone TEXT, synced_at INTEGER);
      CREATE TABLE fb_ads_daily (account_id TEXT, level TEXT, object_id TEXT, name TEXT, day TEXT, spend REAL, results INTEGER DEFAULT 0, captured_at INTEGER);`);
  }
  return db;
}

export function fakeCtx(db: DB, settings: Record<string, unknown> = {}) {
  const emitted: string[] = [];
  const audit: Array<{ action: string; actor?: string }> = [];
  const ctx = {
    id: 'finance', db, dataDir: '/tmp/finance-test',
    settings: { get: (k: string, fallback?: unknown) => settings[k] ?? fallback, set: (k: string, v: unknown) => { settings[k] = v; }, all: () => settings },
    events: { emit: (e: string) => { emitted.push(e); }, on: () => () => {} },
    audit: { log: (action: string, _t?: unknown, _d?: unknown, actor?: string) => { audit.push({ action, actor }); } },
    schedule: { every: (_n: string, _w: unknown, _f: unknown) => () => {} },
    log: { warn: () => {}, info: () => {}, error: () => {} },
  } as unknown as ModuleContext;
  return { ctx, emitted, audit, settings };
}

/** A connector whose session answers from `handlers`; records every tool called. */
export function fakeConnector(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: string[] = [];
  const connect: McpConnector = async () => {
    const session: McpSession = {
      async callTool(name, args) {
        calls.push(name);
        const h = handlers[name];
        if (!h) return { isError: true, content: [{ type: 'text', text: `không có ${name}` }] };
        return { content: [{ type: 'text', text: JSON.stringify(h(args)) }] };
      },
    };
    return { session, close: async () => {} };
  };
  return { connect, calls };
}

export const summaryOf = (period: 'today' | 'week' | 'month', from: string, to: string, revenue: number, paid: number) =>
  ({ period, from_date: from, to_date: to, revenue, paid_orders: paid, registrations: paid * 2, company_share: revenue * 0.6 });
