/**
 * Shared helpers for Care stores: account/conversation/customer existence + ownership checks
 * that every direct store entrypoint (not just the ingest pipeline) must enforce.
 */

import type Database from 'better-sqlite3';
import { CareError } from '../../../_lib/care-kit/errors.js';
import type { CareChannel } from '../../../_lib/care-kit/types.js';

export interface AccountGateRow {
  id: string;
  channel: CareChannel;
  ownerEpoch: number;
}

export function requireAccountRow(db: Database.Database, accountId: unknown, label = 'Account'): AccountGateRow {
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new CareError('INVALID_TARGET', `${label} id is required`, 400);
  }
  const row = db.prepare('SELECT id, channel, owner_epoch FROM care_accounts WHERE id = ?').get(accountId) as
    | { id: string; channel: CareChannel; owner_epoch: number }
    | undefined;
  if (!row) {
    throw new CareError('INVALID_TARGET', `${label} not found: ${accountId}`, 404);
  }
  return { id: row.id, channel: row.channel, ownerEpoch: Number(row.owner_epoch) };
}

export function requireConversationOfAccount(
  db: Database.Database,
  conversationId: string,
  accountId: string,
): { id: string; kind: string } {
  const row = db
    .prepare('SELECT id, account_id, kind FROM care_conversations WHERE id = ?')
    .get(conversationId) as { id: string; account_id: string; kind: string } | undefined;
  if (!row) {
    throw new CareError('INVALID_TARGET', `Conversation not found: ${conversationId}`, 404);
  }
  if (row.account_id !== accountId) {
    throw new CareError('INVALID_TARGET', 'Cross-account conversation mismatch', 400);
  }
  return { id: row.id, kind: row.kind };
}

export function requireCustomerExists(db: Database.Database, customerId: unknown): string {
  if (typeof customerId !== 'string' || customerId.length === 0) {
    throw new CareError('INVALID_TARGET', 'Customer id is required', 400);
  }
  const row = db.prepare('SELECT id FROM care_customers WHERE id = ?').get(customerId);
  if (!row) {
    throw new CareError('INVALID_TARGET', `Customer not found: ${customerId}`, 404);
  }
  return customerId;
}
