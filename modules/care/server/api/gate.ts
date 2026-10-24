/**
 * Send-like routes ask the ONE dispatch gate (runtime/gates.ts) before they enqueue anything, exactly as the
 * worker, the CLI and the schedules do. A denial becomes a typed error with a stable `details.reason`
 * (the gate's own code); the gate's message text is never forwarded.
 */

import type Database from 'better-sqlite3';
import type { CareActorType } from '../../../_lib/care-kit/types.js';
import { evaluateDispatchGate, type DispatchDecision, type DispatchDenyCode } from '../runtime/gates.js';
import { ApiError, notFound } from './errors.js';

const MESSAGE: Record<DispatchDenyCode, string> = {
  ACCOUNT_NOT_FOUND: 'Not found.',
  KILL_SWITCH: 'Dispatch is switched off.',
  MODULE_DISABLED: 'The Customer Care module is switched off.',
  PATH_DISABLED: 'This dispatch path is switched off.',
  CHANNEL_DISABLED: 'This channel is switched off.',
  OWNER_LEGACY: 'The account is still owned by the legacy sender.',
  OWNER_CORE: 'The account is owned by Customer Care.',
  ACCOUNT_DRAINING: 'The account is changing owner; nothing can be sent right now.',
  EPOCH_REQUIRED: 'The account epoch is required.',
  STALE_EPOCH: 'The account owner changed. Reload and try again.',
  ACCOUNT_NOT_ACTIVE: 'The account is not active.',
  SEND_DISABLED: 'Sending is switched off for this account.',
  AUTO_SEND_DISABLED: 'Auto-send is switched off.',
  BACKLOG_HELD: 'This item is parked for review.',
  LOCK_LOST: 'The account lock is no longer valid.',
  INVALID_SOURCE: 'Invalid dispatch path.',
};

export function denialToError(decision: Extract<DispatchDecision, { allow: false }>, operation: 'send' | 'work'): ApiError {
  const details = { reason: decision.code };
  const message = MESSAGE[decision.code];
  switch (decision.code) {
    case 'ACCOUNT_NOT_FOUND':
      return notFound();
    case 'KILL_SWITCH':
    case 'MODULE_DISABLED':
    case 'PATH_DISABLED':
    case 'CHANNEL_DISABLED':
    case 'SEND_DISABLED':
    case 'AUTO_SEND_DISABLED':
      return new ApiError(operation === 'send' ? 'SEND_DISABLED' : 'SYNC_DISABLED', 403, message, { details });
    case 'ACCOUNT_DRAINING':
    case 'ACCOUNT_NOT_ACTIVE':
      return new ApiError('ACCOUNT_FROZEN', 409, message, { details });
    case 'EPOCH_REQUIRED':
    case 'STALE_EPOCH':
    case 'LOCK_LOST':
      return new ApiError('FENCING_REJECTED', 409, message, { details });
    case 'INVALID_SOURCE':
      return new ApiError('INTERNAL_ERROR', 500);
    default:
      return new ApiError('CONFIGURATION_CONFLICT', 409, message, { details });
  }
}

export interface RequireDispatchOptions {
  operation: 'send' | 'work';
  actorType?: CareActorType;
  item?: { kind: string; id: string };
}

/** Throws the typed denial; returns when the dispatch gate admits an `api` action on the account. */
export function requireDispatch(db: Database.Database, accountId: string, ownerEpoch: number, opts: RequireDispatchOptions): void {
  const decision = evaluateDispatchGate(db, accountId, ownerEpoch, 'core', 'api', {
    operation: opts.operation,
    actorType: opts.actorType,
    item: opts.item,
  });
  if (!decision.allow) throw denialToError(decision, opts.operation);
}
