/** Test-only helpers for the CC-12 suites (synthetic data, temp-file SQLite, no provider). Not imported by production code. */
import type { CareAccountRecord, CareJobType } from '../../../_lib/care-kit/types.js';
import type { CareStores } from '../persistence/index.js';
import { createEligibleAccount, twoHandleFixture, type TwoHandleFixture } from '../test-fixtures.js';

export interface RuntimeFixture extends TwoHandleFixture {
  account: CareAccountRecord;
}

/** Two handles on one temp DB, one core-owned eligible account, module switch ON. */
export function runtimeFixture(over: Parameters<typeof createEligibleAccount>[1] = {}): RuntimeFixture {
  const f = twoHandleFixture();
  const account = createEligibleAccount(f.storesA, { nativeAccountId: 'acct-1', ...over });
  f.storesA.ownership.setSwitch('module', true, { actor: 'test', nowMs: 1 });
  return { ...f, account };
}

export function addAccount(stores: CareStores, over: Parameters<typeof createEligibleAccount>[1] = {}): CareAccountRecord {
  return createEligibleAccount(stores, { nativeAccountId: `acct-${Math.random().toString(36).slice(2)}`, ...over });
}

export function enqueue(
  stores: CareStores,
  account: Pick<CareAccountRecord, 'id'>,
  jobType: CareJobType = 'outbox_dispatch',
  extra: { dedupeKey?: string; payload?: Record<string, unknown>; ownerEpoch?: number; dueAtMs?: number } = {},
) {
  return stores.jobs.enqueueJob({ accountId: account.id, jobType, payload: { n: 1 }, dueAtMs: 0, ...extra });
}

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Moves an account owner/epoch through the audited store transition (draining then target). */
export function cycleOwner(stores: CareStores, accountId: string, from: 'core' | 'legacy', to: 'core' | 'legacy'): number {
  const acct = stores.accounts.getAccount(accountId)!;
  const a = stores.ownership.applyOwnerTransition({ accountId, expectedOwner: from, expectedEpoch: acct.ownerEpoch, toOwner: 'draining', kind: 'forward', actor: 'test', reason: 'fixture' });
  if (!a.ok) throw new Error('fixture transition failed');
  const b = stores.ownership.applyOwnerTransition({ accountId, expectedOwner: 'draining', expectedEpoch: a.epochAfter, toOwner: to, kind: 'forward', actor: 'test', reason: 'fixture' });
  if (!b.ok) throw new Error('fixture transition failed');
  return b.epochAfter;
}
