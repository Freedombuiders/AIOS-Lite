// Synthetic fixtures for the T07 bot panel tests.
import type { CareBotPanelDto, CareBotStateDto } from '@modules/care/server/api/dto-inbox';
import type { CareRunDto } from '@modules/care/server/api/dto-ops';
import { conv } from './fixtures.test-util';
import type { CareConversationDto } from './dto';

export const bot = (over: Partial<CareBotStateDto> = {}): CareBotStateDto => ({
  label: 'active', agentId: 'cskh', mode: 'draft', yieldReason: null, paused: false, pausedUntilMs: null, humanPauseMinutes: 30, handoff: null, ...over,
});

export function panel(over: Partial<Omit<CareBotPanelDto, 'state' | 'rules'>> & { state?: Partial<CareBotStateDto>; rules?: Partial<CareBotPanelDto['rules']> } = {}): CareBotPanelDto {
  const { state, rules, ...rest } = over;
  return {
    conversationId: 'c1', accountId: 'a1', kind: 'direct', conversationKey: 'peer:1', aiMode: null, takenOver: false,
    effective: { outcome: 'active', tier: 'account', agentId: 'cskh', mode: 'draft' },
    accountRule: { id: 'r-acct', scope: 'account', mode: 'draft', agentId: 'cskh', enabled: true, configVersion: 3, priority: 100, instructionsRef: null, policyExt: null },
    conversationRule: null,
    ...rest,
    state: bot(state),
    rules: {
      settings: { aiEnabled: true, autoSendEnabled: false, handoffKeywords: ['gặp nhân viên', 'khiếu nại'], handoffPauseMinutes: 60, turnDebounceSeconds: 3, quietHoursStart: '22:00', quietHoursEnd: '07:00' },
      maxRepliesPerThreadDay: 30, humanPauseMinutes: 30, ...rules,
    },
  };
}

export const run = (over: Partial<CareRunDto> = {}): CareRunDto => ({
  id: 'run1', accountId: 'a1', conversationId: 'c1', triggerMessageId: 'm1', status: 'skipped', skipReason: 'noise', mode: 'draft', agentId: 'cskh', triggerKind: 'inbound',
  policyRevision: 'r-acct@3', draftRef: null, modelCalled: false, latencyMs: null, costUsd: 0, createdAtMs: 1_700_000_000_000, updatedAtMs: 1_700_000_000_000, ...over,
});

/** A conversation row carrying the server-computed bot state. */
export function convWithBot(label: CareBotStateDto['label'], over: Partial<CareConversationDto> = {}): CareConversationDto {
  return conv({
    workflow: {
      status: 'open', snoozedUntilMs: null, changedAtMs: null, stateRevision: 1, pendingDrafts: label === 'review' ? 1 : 0,
      assignee: { kind: 'none', agentId: null, source: 'none' },
      ai: { agentId: null, mode: 'off', source: 'none', takenOver: false, supported: false, note: 'CORE_AI_UNAVAILABLE' },
      bot: bot({ label }),
    },
    ...over,
  });
}
