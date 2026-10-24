/**
 * Runtime enum + shape guards for Customer Care values that cross a trust boundary
 * (adapter events, store inputs). Pure and browser safe.
 */

import { CareError } from './errors.js';
import type {
  AssignmentMode,
  AssignmentScope,
  CareAccountDesiredState,
  CareAccountHealth,
  CareChannel,
  CareConversationKind,
  CareJobType,
  CareMessageDirection,
  CareOrigin,
  CareSenderRole,
  CareStage,
  CareWriteOwner,
} from './types.js';

export const CARE_CHANNELS: readonly CareChannel[] = ['zalo', 'telegram', 'email'];
export const CARE_ORIGINS: readonly CareOrigin[] = ['live', 'history', 'recovery'];
export const CARE_SENDER_ROLES: readonly CareSenderRole[] = ['customer', 'self', 'operator', 'agent', 'system'];
export const CARE_DIRECTIONS: readonly CareMessageDirection[] = ['in', 'out'];
export const CARE_CONVERSATION_KINDS: readonly CareConversationKind[] = ['direct', 'group', 'topic', 'email_thread'];
export const CARE_DESIRED_STATES: readonly CareAccountDesiredState[] = ['active', 'paused', 'draining', 'disconnected'];
export const CARE_HEALTH_STATES: readonly CareAccountHealth[] = ['healthy', 'degraded', 'error'];
export const CARE_WRITE_OWNERS: readonly CareWriteOwner[] = ['legacy', 'draining', 'core'];
export const CARE_STAGES: readonly CareStage[] = ['new', 'consulting', 'quoted', 'deposit', 'won', 'lost'];
export const CARE_JOB_TYPES: readonly CareJobType[] = ['inbound_turn', 'outbox_dispatch', 'sync_poll', 'cleanup'];
export const CARE_ASSIGNMENT_SCOPES: readonly AssignmentScope[] = [
  'conversation',
  'customer',
  'identity',
  'domain',
  'account',
  'channel',
  'global',
];
export const CARE_ASSIGNMENT_MODES: readonly AssignmentMode[] = ['observe', 'draft', 'auto'];

/** Conversation kinds a channel can legitimately produce. */
export const CHANNEL_CONVERSATION_KINDS: Record<CareChannel, readonly CareConversationKind[]> = {
  zalo: ['direct', 'group'],
  telegram: ['direct', 'group', 'topic'],
  email: ['email_thread'],
};

export function oneOf<T extends string>(allowed: readonly T[], value: unknown, label: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new CareError('INVALID_COMMAND', `Invalid ${label}: ${String(value)}`, 400);
  }
  return value as T;
}

export function requireNonEmptyString(value: unknown, label: string, maxLength = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new CareError('INVALID_COMMAND', `${label} must be a non-empty string (max ${maxLength})`, 400);
  }
  return value;
}

export function requireSafeInteger(value: unknown, label: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new CareError('INVALID_COMMAND', `${label} must be a safe integer >= ${min}`, 400);
  }
  return value;
}

export function requireTimestampMs(value: unknown, label: string): number {
  return requireSafeInteger(value, label, 0);
}

export function requireConversationKindForChannel(channel: CareChannel, kind: unknown): CareConversationKind {
  const k = oneOf(CARE_CONVERSATION_KINDS, kind, 'conversation kind');
  if (!CHANNEL_CONVERSATION_KINDS[channel].includes(k)) {
    throw new CareError('INVALID_TARGET', `Conversation kind '${k}' is not valid for channel '${channel}'`, 400);
  }
  return k;
}

/** Default kind when an adapter did not state one: the only kind an email account can have, DM otherwise. */
export function defaultConversationKind(channel: CareChannel): CareConversationKind {
  return channel === 'email' ? 'email_thread' : 'direct';
}
