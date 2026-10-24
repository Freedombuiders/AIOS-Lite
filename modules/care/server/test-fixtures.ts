/**
 * Shared fixtures for Care tests. Isolated SQLite databases and injected keys only: no .env,
 * no live DB, no provider. Not imported by production code.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CareIngestPipeline } from './application/ingest.js';
import type { CareAccountRecord, CareChannel, NormalizedMessage } from '../../_lib/care-kit/types.js';
import { createCareStores, createTestCareDatabase, type CareStores } from './persistence/index.js';
import { createCareSchema } from './persistence/schema.js';

export const TEST_KEY = Buffer.alloc(32, 71);

const NAMESPACE: Record<CareChannel, string> = {
  zalo: 'zalo_chat',
  telegram: 'telegram_common_box',
  email: 'gmail_mailbox',
};

/** Active, core-owned account with every gate on (what an eligible live account looks like). */
export function createEligibleAccount(
  stores: CareStores,
  over: Partial<Parameters<CareStores['accounts']['createAccount']>[0]> = {},
): CareAccountRecord {
  return stores.accounts.createAccount({
    channel: 'zalo',
    connectorKind: 'fake',
    nativeAccountId: `native-${Math.random().toString(36).slice(2)}`,
    label: 'fixture',
    desiredState: 'active',
    writeOwner: 'core',
    aiEnabled: true,
    syncEnabled: true,
    sendEnabled: true,
    ...over,
  });
}

export interface MemoryFixture {
  stores: CareStores;
  rawDbForTestIsolationOnly: Database.Database;
  raw: Database.Database;
  close: () => void;
  account: CareAccountRecord;
  ingest: CareIngestPipeline;
}

/** In-memory fixture with an eligible account and an ingest pipeline (no assignment yet). */
export function memoryFixture(accountOver: Partial<Parameters<CareStores['accounts']['createAccount']>[0]> = {}): MemoryFixture {
  const db = createTestCareDatabase(':memory:', TEST_KEY);
  const account = createEligibleAccount(db.stores, accountOver);
  const ingest = new CareIngestPipeline(db.rawDbForTestIsolationOnly, db.stores);
  return { ...db, raw: db.rawDbForTestIsolationOnly, account, ingest };
}

export function assignAuto(stores: CareStores, account: CareAccountRecord): void {
  stores.assignments.upsertAssignment({
    scope: 'account',
    accountId: account.id,
    mode: 'auto',
    agentId: 'agent-main',
  });
}

let seq = 0;
export function chatMessage(
  account: Pick<CareAccountRecord, 'id' | 'channel'>,
  over: Partial<NormalizedMessage> = {},
): NormalizedMessage {
  seq += 1;
  return {
    accountId: account.id,
    externalConversationKey: 'peer:1',
    nativeMessageNamespace: NAMESPACE[account.channel],
    nativeMessageId: `m-${seq}`,
    nativeVersion: '1',
    direction: 'in',
    senderRole: 'customer',
    senderIdentityKey: 'customer:1',
    origin: 'live',
    sentAtMs: 1_000 + seq,
    text: 'fixture text',
    metadata: { type: 'chat' },
    ...over,
  };
}

export function emailMessage(account: Pick<CareAccountRecord, 'id'>, over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  seq += 1;
  return {
    accountId: account.id,
    externalConversationKey: 'thread:1',
    nativeMessageNamespace: 'gmail_mailbox',
    nativeMessageId: `g-${seq}`,
    nativeVersion: null,
    direction: 'in',
    senderRole: 'customer',
    senderIdentityKey: 'buyer@example.com',
    origin: 'live',
    sentAtMs: 5_000 + seq,
    text: 'email body',
    metadata: { type: 'email', subject: 'Hello', from: 'buyer@example.com', to: ['shop@example.com'] },
    ...over,
  };
}

export interface TwoHandleFixture {
  a: Database.Database;
  b: Database.Database;
  storesA: CareStores;
  storesB: CareStores;
  ingestA: CareIngestPipeline;
  ingestB: CareIngestPipeline;
  close: () => void;
}

/** Temp-file database with two independent handles (WAL), each with its own stores. */
export function twoHandleFixture(): TwoHandleFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-two-handles-'));
  const file = path.join(dir, 'care.db');
  const a = new Database(file);
  a.pragma('journal_mode = WAL');
  a.pragma('busy_timeout = 5000');
  createCareSchema(a);
  const b = new Database(file);
  b.pragma('busy_timeout = 5000');
  const storesA = createCareStores(a, TEST_KEY);
  const storesB = createCareStores(b, TEST_KEY);
  return {
    a,
    b,
    storesA,
    storesB,
    ingestA: new CareIngestPipeline(a, storesA),
    ingestB: new CareIngestPipeline(b, storesB),
    close() {
      try {
        b.close();
        a.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** Every text cell of every care_* table, joined: used for plaintext-marker sweeps. */
export function dumpCareTables(db: Database.Database): string {
  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'care_%'`).all() as Array<{ name: string }>
  ).map((t) => t.name);
  const out: string[] = [];
  for (const table of tables) {
    for (const row of db.prepare(`SELECT * FROM ${table}`).all()) out.push(JSON.stringify(row));
  }
  return out.join('\n');
}
