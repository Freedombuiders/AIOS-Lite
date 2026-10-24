import { describe, expect, it } from 'vitest';
import {
  aiChip, aiHintKey, aiIsActive, avatarHue, documentTitle, initialsOf, ownerChip, snoozeUntilLabel, statusChipOf, titleCount, unreadCount, waitLabel, waitMinutes, waitTone,
} from './inboxView';
import { conv } from './fixtures.test-util';
import type { CareAiStateDto, CareAssigneeDto, CareConversationWorkflowDto } from './dto';

type WfOver = Partial<Omit<CareConversationWorkflowDto, 'ai' | 'assignee'>> & { ai?: Partial<CareAiStateDto>; assignee?: Partial<CareAssigneeDto> };

function wf(over: WfOver = {}): CareConversationWorkflowDto {
  const { ai, assignee, ...rest } = over;
  return {
    status: 'open', snoozedUntilMs: null, changedAtMs: null, stateRevision: 1, pendingDrafts: 0,
    assignee: { kind: 'none', agentId: null, source: 'none', ...assignee },
    ai: { agentId: null, mode: 'draft', source: 'none', takenOver: false, supported: true, note: null, ...ai },
    ...rest,
  };
}

const MIN = 60_000;

describe('wait chip tone', () => {
  const now = 10_000_000;
  it('is neutral before the threshold, amber after it, red from 3x', () => {
    expect(waitTone(now - 2 * MIN, now, 10)).toBe('ok');
    expect(waitTone(now - 10 * MIN, now, 10)).toBe('warn');
    expect(waitTone(now - 29 * MIN, now, 10)).toBe('warn');
    expect(waitTone(now - 30 * MIN, now, 10)).toBe('late');
    expect(waitTone(now - 500 * MIN, now, 10)).toBe('late');
  });
  it('has no tone when nobody waits, and a bad threshold falls back to the default (10)', () => {
    expect(waitTone(null, now, 10)).toBeNull();
    expect(waitTone(now - 12 * MIN, now, 0)).toBe('warn');
  });
  it('minutes never go negative (clock skew) and the label picks a sensible unit', () => {
    expect(waitMinutes(now + 5 * MIN, now)).toBe(0);
    expect(waitLabel(0)).toEqual({ unit: 'min', n: 0 });
    expect(waitLabel(42)).toEqual({ unit: 'min', n: 42 });
    expect(waitLabel(125)).toEqual({ unit: 'hour', n: 2 });
    expect(waitLabel(60 * 24 * 3 + 5)).toEqual({ unit: 'day', n: 3 });
  });
});

describe('owner and AI chips', () => {
  it('owner chip follows the assignee kind', () => {
    expect(ownerChip(wf({ assignee: { kind: 'owner' } }))).toEqual({ kind: 'me' });
    expect(ownerChip(wf({ assignee: { kind: 'agent', agentId: 'review-care' } }))).toEqual({ kind: 'ai', agentId: 'review-care' });
    expect(ownerChip(wf({ assignee: { kind: 'agent', agentId: null }, ai: { agentId: 'gmail-reply' } }))).toEqual({ kind: 'ai', agentId: 'gmail-reply' });
    expect(ownerChip(wf())).toEqual({ kind: 'none' });
  });
  it('AI chip priority: paused > off > draft waiting > auto-send', () => {
    expect(aiChip(wf({ pendingDrafts: 2, ai: { agentId: 'a', takenOver: true } }))).toBe('paused');
    expect(aiChip(wf({ pendingDrafts: 2, ai: { agentId: 'a', mode: 'off' } }))).toBe('off');
    expect(aiChip(wf({ pendingDrafts: 1, ai: { agentId: 'a', mode: 'auto' } }))).toBe('draft');
    expect(aiChip(wf({ ai: { agentId: 'a', mode: 'auto' } }))).toBe('auto');
    expect(aiChip(wf({ ai: { agentId: 'a', mode: 'draft' } }))).toBeNull();
    expect(aiChip(wf())).toBeNull();
  });
  it('a channel without AI (Telegram) never shows an AI chip', () => {
    expect(aiChip(wf({ pendingDrafts: 1, ai: { supported: false, agentId: 'a', mode: 'auto' } }))).toBeNull();
  });
  it('"AI is on it" matches the server definition', () => {
    expect(aiIsActive(wf({ ai: { agentId: 'a', mode: 'draft' } }))).toBe(true);
    expect(aiIsActive(wf({ ai: { agentId: 'a', mode: 'off' } }))).toBe(false);
    expect(aiIsActive(wf({ ai: { agentId: 'a', takenOver: true } }))).toBe(false);
    expect(aiIsActive(wf({ ai: { agentId: null } }))).toBe(false);
    expect(aiIsActive(wf({ ai: { agentId: 'a', supported: false } }))).toBe(false);
  });
});

describe('avatar and unread', () => {
  it('initials are the last two words, or two letters of one word', () => {
    expect(initialsOf('Nguyễn Minh Thư')).toBe('MT');
    expect(initialsOf('Đỗ Gia Huy')).toBe('GH');
    expect(initialsOf('Phạm Đức Anh')).toBe('ĐA');
    expect(initialsOf('Bảo')).toBe('BẢ');
    expect(initialsOf('   ')).toBe('?');
  });
  it('the tint is stable per id and within the hue circle', () => {
    expect(avatarHue('conv-1')).toBe(avatarHue('conv-1'));
    expect(avatarHue('conv-1')).toBeGreaterThanOrEqual(0);
    expect(avatarHue('conv-1')).toBeLessThan(360);
  });
  it('unread count is the larger of the channel count and the dashboard flag', () => {
    expect(unreadCount({ remoteUnreadCount: 3, localUnread: true })).toBe(3);
    expect(unreadCount({ remoteUnreadCount: 0, localUnread: true })).toBe(1);
    expect(unreadCount({ remoteUnreadCount: 0, localUnread: false })).toBe(0);
  });
});

describe('status chip and snooze label (Asia/Ho_Chi_Minh)', () => {
  it('open shows the wait, snoozed shows the target', () => {
    const now = Date.UTC(2026, 9, 13, 3, 0); // 10:00 in Vietnam
    const open = statusChipOf(conv({ waitingSinceMs: now - 5 * MIN, workflow: wf({ status: 'open' }) }), now);
    expect(open).toEqual({ status: 'open', waitMin: 5, snoozedUntilMs: null });
    const snoozed = statusChipOf(conv({ workflow: wf({ status: 'snoozed', snoozedUntilMs: now + 3_600_000 }) }), now);
    expect(snoozed?.snoozedUntilMs).toBe(now + 3_600_000);
    expect(statusChipOf(conv(), now)).toBeNull(); // old server: no workflow
  });
  it('labels today, tomorrow and later days by Vietnam wall clock, not the browser zone', () => {
    const now = Date.UTC(2026, 9, 13, 16, 30); // 23:30 on the 13th in Vietnam
    // 17:00 UTC the same day = 00:00 on the 14th in Vietnam -> tomorrow
    expect(snoozeUntilLabel(Date.UTC(2026, 9, 13, 17, 0), now)).toEqual({ time: '00:00', day: 'tomorrow', weekday: 3 });
    expect(snoozeUntilLabel(Date.UTC(2026, 9, 13, 16, 45), now)).toMatchObject({ time: '23:45', day: 'today' });
    const later = snoozeUntilLabel(Date.UTC(2026, 9, 19, 2, 0), now); // Monday the 19th, 09:00 in Vietnam
    expect(later).toEqual({ time: '09:00', day: 'weekday', weekday: 1 });
  });
});

describe('tab title', () => {
  it('shows the count of conversations that need the owner', () => {
    expect(documentTitle('Hộp thư chung', 4)).toBe('(4) Hộp thư chung');
    expect(documentTitle('Hộp thư chung', 0)).toBe('Hộp thư chung');
    expect(documentTitle('Hộp thư chung', null)).toBe('Hộp thư chung');
    expect(documentTitle('Hộp thư chung', 250)).toBe('(99+) Hộp thư chung');
  });
  it('reads the count from byView.me', () => {
    const byView = { me: 7, ai: 1, none: 2, all: 10 };
    expect(titleCount({ byView })).toBe(7);
    expect(titleCount(null)).toBeNull();
    expect(titleCount(undefined)).toBeNull();
  });
});

describe('AI hint', () => {
  it('says why when AI is unavailable, paused or unassigned, and describes the mode otherwise', () => {
    expect(aiHintKey(wf({ ai: { supported: false, agentId: 'a' } }))).toBe('inbox2.ai.hint.unsupported');
    expect(aiHintKey(wf({ ai: { takenOver: true, agentId: 'a' } }))).toBe('inbox2.ai.hint.takenOver');
    expect(aiHintKey(wf({ ai: { agentId: null } }))).toBe('inbox2.ai.hint.noAgent');
    expect(aiHintKey(wf({ ai: { agentId: 'a', mode: 'auto' } }))).toBe('inbox2.ai.hint.auto');
    expect(aiHintKey(wf({ ai: { agentId: 'a', mode: 'off' } }))).toBe('inbox2.ai.hint.off');
  });
});
