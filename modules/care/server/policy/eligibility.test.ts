import { describe, expect, it } from 'vitest';
import { resolveEffectiveRule } from './assignment-resolver.js';
import {
  ELIGIBILITY_REASONS,
  evaluateEligibility,
  killSwitchOffLayer,
  type EligibilityInput,
  type EligibilityReason,
} from './eligibility.js';
import { assignment, eligibleInput, emailGateMessage, gateMessage, killSwitches, NOW } from './test-support.js';

const autoRule = (over: Parameters<typeof assignment>[0] = {}, channel: 'zalo' | 'email' = 'zalo') =>
  resolveEffectiveRule([assignment({ scope: 'account', mode: 'auto', ...over })], {
    accountId: 'acc',
    channel,
    conversationKey: 'k',
    conversationKind: channel === 'email' ? 'email_thread' : 'direct',
  });

function reasonOf(input: EligibilityInput): EligibilityReason {
  return evaluateEligibility(input).reason;
}

describe('baseline and determinism', () => {
  it('an eligible live customer message passes for zalo and email', () => {
    expect(evaluateEligibility(eligibleInput('zalo'))).toEqual({ eligible: true, reason: 'eligible' });
    expect(evaluateEligibility(eligibleInput('email'))).toEqual({ eligible: true, reason: 'eligible' });
  });

  it('is deterministic: same input, same result, input not mutated', () => {
    const input = eligibleInput('zalo', { conversation: { kind: 'direct', isPaused: true, pausedUntilMs: null, isOptedOut: false } });
    const snapshot = JSON.stringify(input);
    const a = evaluateEligibility(input);
    const b = evaluateEligibility(input);
    expect(a).toEqual(b);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('every reason code is stable, unique and lower snake case', () => {
    expect(new Set(ELIGIBILITY_REASONS).size).toBe(ELIGIBILITY_REASONS.length);
    for (const r of ELIGIBILITY_REASONS) expect(r).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });
});

describe('Telegram AI hard block (V1: disabled by design)', () => {
  it('blocks every AI step before anything else, even when all else is wrong', () => {
    const broken = eligibleInput('zalo', {
      channel: 'telegram',
      killSwitches: killSwitches({ moduleEnabled: false }),
      resolution: null,
      account: { id: 'acc', desiredState: 'paused', writeOwner: 'legacy', aiEnabled: false, syncEnabled: false, sendEnabled: false, healthStatus: 'error' },
    });
    for (const step of ['model_call', 'context_expansion', 'summary'] as const) {
      expect(evaluateEligibility({ ...broken, step }).reason).toBe('telegram_ai_blocked');
    }
    expect(evaluateEligibility({ ...broken, step: 'send', actor: 'auto_care_reply' }).reason).toBe('telegram_ai_blocked');
    expect(evaluateEligibility({ ...broken, step: 'send', actor: 'approved_care_draft' }).reason).toBe('telegram_ai_blocked');
  });

  it('blocks a context expansion that pulls Telegram data into another channel', () => {
    const input = eligibleInput('zalo', { step: 'context_expansion', expansion: { sourceChannel: 'telegram', permitted: true } });
    expect(reasonOf(input)).toBe('telegram_ai_blocked');
    expect(reasonOf({ ...input, expansion: { sourceChannel: 'zalo', permitted: false } })).toBe('context_source_not_permitted');
    expect(reasonOf({ ...input, expansion: undefined })).toBe('context_source_not_permitted');
    expect(reasonOf({ ...input, expansion: { sourceChannel: 'zalo', permitted: true } })).toBe('eligible');
  });

  it('does not block a human typing on Telegram or marketing without AI', () => {
    const base = eligibleInput('zalo', { channel: 'telegram', step: 'send' });
    expect(reasonOf({ ...base, actor: 'manual_care_reply' })).toBe('eligible');
    expect(reasonOf({ ...base, actor: 'marketing', marketingConsent: true })).toBe('eligible');
  });
});

describe('kill switches', () => {
  it('names the layer that turned a switch off', () => {
    const ks = killSwitches({ channels: { zalo: { aiEnabled: false } }, accounts: { acc: { autoSendEnabled: false } } });
    expect(killSwitchOffLayer(ks, 'ai', 'zalo', 'acc')).toBe('channel:zalo');
    expect(killSwitchOffLayer(ks, 'ai', 'email', 'acc')).toBeNull();
    expect(killSwitchOffLayer(ks, 'auto_send', 'email', 'acc')).toBe('account:acc');
    expect(killSwitchOffLayer(killSwitches({ moduleEnabled: false }), 'module', 'zalo', 'acc')).toBe('global');
  });

  it('module off stops everything, including manual sends', () => {
    const ks = killSwitches({ moduleEnabled: false });
    expect(reasonOf(eligibleInput('zalo', { killSwitches: ks }))).toBe('kill_switch_module');
    expect(reasonOf(eligibleInput('zalo', { killSwitches: ks, actor: 'manual_care_reply', step: 'send' }))).toBe('kill_switch_module');
  });

  it('AI off stops model steps but not a manual reply ("turning AI off does not turn manual chat off")', () => {
    const ks = killSwitches({ aiEnabled: false });
    expect(reasonOf(eligibleInput('zalo', { killSwitches: ks }))).toBe('kill_switch_ai');
    expect(reasonOf(eligibleInput('zalo', { killSwitches: ks, actor: 'manual_care_reply' }))).toBe('kill_switch_ai');
    expect(reasonOf(eligibleInput('zalo', { killSwitches: ks, actor: 'manual_care_reply', step: 'send' }))).toBe('eligible');
    // A person approving an existing draft is a human act, not a model step.
    expect(reasonOf(eligibleInput('zalo', { killSwitches: ks, actor: 'approved_care_draft', step: 'send' }))).toBe('eligible');
  });

  it('auto-send off downgrades an auto reply to a draft before the model and denies the send itself', () => {
    const ks = killSwitches({ autoSendEnabled: false });
    const pre = evaluateEligibility(eligibleInput('zalo', { killSwitches: ks }));
    expect(pre).toEqual({ eligible: true, reason: 'eligible', adjustment: { kind: 'to_draft', cause: 'kill_switch_auto_send' } });
    expect(reasonOf(eligibleInput('zalo', { killSwitches: ks, step: 'send' }))).toBe('kill_switch_auto_send');
  });
});

describe('account / source gates', () => {
  const acct = (over: Partial<EligibilityInput['account']>) => ({ ...eligibleInput('zalo').account, ...over });
  it.each<[string, Partial<EligibilityInput['account']>, EligibilityReason]>([
    ['paused account', { desiredState: 'paused' }, 'account_inactive'],
    ['draining account', { desiredState: 'draining' }, 'account_inactive'],
    ['legacy-owned account', { writeOwner: 'legacy' }, 'write_owner_not_core'],
    ['draining owner', { writeOwner: 'draining' }, 'write_owner_not_core'],
    ['ai flag off', { aiEnabled: false }, 'account_ai_disabled'],
    ['sync off', { syncEnabled: false }, 'account_sync_disabled'],
    ['send off (auto mode)', { sendEnabled: false }, 'account_send_disabled'],
    ['unhealthy (auto mode)', { healthStatus: 'error' }, 'account_unhealthy'],
  ])('%s', (_name, over, reason) => {
    expect(reasonOf(eligibleInput('zalo', { account: acct(over) }))).toBe(reason);
  });

  it('send-disabled does not block drafting for a person (draft mode)', () => {
    const draft = autoRule({ mode: 'draft' });
    expect(reasonOf(eligibleInput('zalo', { resolution: draft, account: acct({ sendEnabled: false, healthStatus: 'error' }) }))).toBe('eligible');
  });

  it('send-disabled blocks a manual or approved send and marketing', () => {
    for (const actor of ['manual_care_reply', 'approved_care_draft', 'marketing'] as const) {
      expect(reasonOf(eligibleInput('zalo', { actor, step: 'send', marketingConsent: true, account: acct({ sendEnabled: false }) }))).toBe('account_send_disabled');
    }
  });
});

describe('assignment gates', () => {
  it('no assignment, disabled assignment (deny override) and observe-only', () => {
    expect(reasonOf(eligibleInput('zalo', { resolution: { status: 'none', reason: 'no_assignment' } }))).toBe('no_assignment');
    expect(reasonOf(eligibleInput('zalo', { resolution: null }))).toBe('no_assignment');
    expect(reasonOf(eligibleInput('zalo', { resolution: autoRule({ enabled: false }) }))).toBe('assignment_disabled');
    expect(reasonOf(eligibleInput('zalo', { resolution: autoRule({ mode: 'observe' }) }))).toBe('observe_only');
  });

  it('an operator asking for a draft works in observe mode but never past a disabled rule', () => {
    expect(reasonOf(eligibleInput('zalo', { actor: 'manual_care_reply', resolution: autoRule({ mode: 'observe' }), burst: [] }))).toBe('eligible');
    expect(reasonOf(eligibleInput('zalo', { actor: 'manual_care_reply', resolution: autoRule({ enabled: false }), burst: [] }))).toBe('assignment_disabled');
  });
});

describe('message gates through eligibility (ported from the Zalo/Email gate tests)', () => {
  const group = (over: Partial<EligibilityInput> = {}, ext: Record<string, unknown> | null = null) =>
    eligibleInput('zalo', {
      conversation: { kind: 'group', isPaused: false, pausedUntilMs: null, isOptedOut: false },
      resolution: resolveEffectiveRule([assignment({ scope: 'account', mode: 'auto', policyExt: ext })], {
        accountId: 'acc', channel: 'zalo', conversationKey: 'g', conversationKind: 'group',
      }),
      ...over,
    });

  it('stays silent in a group unless addressed, looking at the whole burst', () => {
    expect(reasonOf(group({ burst: [gateMessage()] }, { triggerKeywords: ['báo giá'] }))).toBe('not_directed');
    const burst = [gateMessage({ directedAtAccount: true, text: '@shop' }), gateMessage({ text: 'khoá này học mấy buổi?' })];
    expect(reasonOf(group({ burst }, { triggerKeywords: ['báo giá'] }))).toBe('eligible');
  });

  it('matches trigger keywords without diacritics; @all only counts when allowed', () => {
    const ext = { groupTrigger: 'mention_or_keyword', triggerKeywords: ['báo giá'] };
    expect(reasonOf(group({ burst: [gateMessage({ text: 'cho em xin bao gia' })] }, ext))).toBe('eligible');
    expect(reasonOf(group({ burst: [gateMessage({ mentionsAll: true })] }, ext))).toBe('not_directed');
    expect(reasonOf(group({ burst: [gateMessage({ mentionsAll: true })] }, { ...ext, replyToAllMention: true }))).toBe('eligible');
    expect(reasonOf(group({ burst: [gateMessage({ text: 'anything' })] }, { groupTrigger: 'all' }))).toBe('eligible');
  });

  it('smart mode lets unmentioned questions and images through but keeps the cheap gates', () => {
    const smart = { groupTrigger: 'smart' };
    expect(reasonOf(group({ burst: [gateMessage({ text: 'lỗi này là sao các anh, không vẽ được' })] }, smart))).toBe('eligible');
    expect(reasonOf(group({ burst: [gateMessage({ contentKind: 'image', text: '' })] }, smart))).toBe('eligible');
    expect(reasonOf(group({ burst: [gateMessage({ text: 'dạ' })] }, smart))).toBe('noise');
    expect(reasonOf(group({ burst: [gateMessage({ text: 'đừng nhắn nữa' }), gateMessage({ contentKind: 'image', text: '' })] }, smart))).toBe('opted_out');
    expect(reasonOf(group({ burst: [gateMessage({ contentKind: 'image', text: '' })] }, { groupTrigger: 'mention' }))).toBe('not_directed');
  });

  it('answers 1-1 chats without a mention; rejects unsupported and empty bursts', () => {
    expect(reasonOf(eligibleInput('zalo'))).toBe('eligible');
    expect(reasonOf(eligibleInput('zalo', { burst: [gateMessage({ contentKind: 'other', text: '' })] }))).toBe('unsupported_type');
    expect(reasonOf(eligibleInput('zalo', { burst: [] }))).toBe('not_inbound');
  });

  it('skips acknowledgements, answers a burst with one real question, flags opt-out with or without diacritics', () => {
    const dm = (texts: string[]) => reasonOf(eligibleInput('zalo', { burst: texts.map((text) => gateMessage({ text })) }));
    expect(dm(['ok', 'Dạ!', '👍'])).toBe('noise');
    expect(dm(['Vâng.'])).toBe('noise');
    expect(dm(['ok', 'ok nhưng học phí bao nhiêu?'])).toBe('eligible');
    expect(dm(['Đừng nhắn tin cho mình nữa'])).toBe('opted_out');
    expect(dm(['dung lam phien'])).toBe('opted_out');
    expect(dm(['STOP'])).toBe('opted_out');
    expect(dm(['gặp người thật, và đừng nhắn nữa'])).toBe('opted_out');
    expect(dm(['đúng, nhận được rồi nhé, cảm ơn nhiều'])).toBe('eligible');
  });

  it('origin gates: history, recovery, outbound, self/operator echoes, deleted, internal sender', () => {
    const one = (m: Partial<ReturnType<typeof gateMessage>>, over: Partial<EligibilityInput> = {}) =>
      reasonOf(eligibleInput('zalo', { burst: [gateMessage(m)], ...over }));
    expect(one({ origin: 'history' })).toBe('not_live_origin');
    expect(one({ origin: 'recovery' })).toBe('not_live_origin');
    expect(one({ direction: 'out', senderRole: 'self' })).toBe('not_inbound');
    expect(one({ senderRole: 'operator' })).toBe('not_customer_message');
    expect(one({ senderRole: 'agent' })).toBe('not_customer_message');
    expect(one({ isDeleted: true })).toBe('trigger_deleted');
    expect(one({ senderKey: 'uid-other-nick' }, { messageGate: { internalIdentityKeys: ['uid-other-nick'] } })).toBe('internal_sender');
  });

  it('a stale trigger (older than the window) is rejected; care-since cuts off older messages', () => {
    const old = gateMessage({ sentAtMs: NOW - 80 * 3_600_000 });
    expect(reasonOf(eligibleInput('zalo', { burst: [old] }))).toBe('stale_trigger');
    expect(reasonOf(eligibleInput('zalo', { burst: [gateMessage()], messageGate: { notBeforeMs: NOW } }))).toBe('before_care_since');
  });
});

describe('email gates through eligibility', () => {
  const mail = (m: Partial<ReturnType<typeof gateMessage>> = {}, email: Parameters<typeof emailGateMessage>[1] = {}, over: Partial<EligibilityInput> = {}) =>
    reasonOf(eligibleInput('email', { burst: [emailGateMessage(m, email)], ...over }));

  it('passes a normal customer question', () => {
    expect(mail()).toBe('eligible');
  });

  it('rejects our own and internal addresses', () => {
    expect(mail({}, { from: 'shop@gmail.com' })).toBe('own_address');
    expect(mail({}, { from: 'other@gmail.com' })).toBe('internal_sender');
  });

  it('rejects automated mail by header, sender pattern or the thread flag', () => {
    expect(mail({}, { headers: { 'List-Unsubscribe': '<mailto:x@y>' } })).toBe('automated');
    expect(mail({}, { headers: { 'Auto-Submitted': 'auto-replied' } })).toBe('automated');
    expect(mail({}, { from: 'no-reply@bank.vn' })).toBe('automated');
    expect(mail({}, { subject: 'Out of office: back Monday' })).toBe('automated');
    expect(mail({}, { isAutomated: true, automatedReason: 'flagged' })).toBe('automated');
    expect(evaluateEligibility(eligibleInput('email', { burst: [emailGateMessage({}, { headers: { precedence: 'bulk' } })] })).detail).toBe('precedence_bulk');
  });

  it('honours primary_only from the rule (default on) and lets an explicit false through', () => {
    expect(mail({}, { category: 'promotions' })).toBe('category_not_primary');
    expect(mail({}, { category: '' })).toBe('eligible');
    const open = autoRule({ policyExt: { primaryOnly: false } }, 'email');
    expect(mail({}, { category: 'promotions' }, { resolution: open })).toBe('eligible');
  });

  it('detects an opt-out in the new text but ignores quoted history and footers', () => {
    expect(mail({ text: 'Please unsubscribe me' })).toBe('opted_out');
    expect(mail({ text: 'Cảm ơn shop\n\nOn Tue, 7 Oct 2026, Shop <shop@gmail.com> wrote:\n> stop emailing me' })).toBe('noise');
    expect(mail({ text: 'Cho mình hỏi giá\nUnsubscribe | Manage preferences' })).toBe('eligible');
  });

  it('rejects thank-you-only bursts and empty bodies; accepts a thank-you plus a question', () => {
    expect(mail({ text: 'Cảm ơn shop' })).toBe('noise');
    expect(mail({ text: 'Thanks!' })).toBe('noise');
    expect(mail({ text: '   ' })).toBe('empty_body');
    expect(mail({ text: 'Cảm ơn shop, khi nào giao hàng?' })).toBe('eligible');
  });

  it('judges the burst by its newest message for origin and age', () => {
    const burst = [emailGateMessage({ origin: 'history' }), emailGateMessage({ origin: 'live' })];
    expect(reasonOf(eligibleInput('email', { burst }))).toBe('eligible');
    expect(reasonOf(eligibleInput('email', { burst: [emailGateMessage({ origin: 'live' }), emailGateMessage({ origin: 'history' })] }))).toBe('not_live_origin');
    expect(reasonOf(eligibleInput('email', { burst: [emailGateMessage({ sentAtMs: NOW - 80 * 3_600_000 })] }))).toBe('stale_trigger');
  });
});

describe('conversation state, human reply, freshness, quotas', () => {
  it('paused conversation (indefinite or until a future time) but not an expired pause', () => {
    const conv = (over: Partial<EligibilityInput['conversation']>) => ({ kind: 'direct' as const, isPaused: true, pausedUntilMs: null, isOptedOut: false, ...over });
    expect(reasonOf(eligibleInput('zalo', { conversation: conv({}) }))).toBe('conversation_paused');
    expect(reasonOf(eligibleInput('zalo', { conversation: conv({ pausedUntilMs: NOW + 1000 }) }))).toBe('conversation_paused');
    expect(reasonOf(eligibleInput('zalo', { conversation: conv({ pausedUntilMs: NOW - 1000 }) }))).toBe('eligible');
  });

  it('conversation opt-out blocks auto, approved and marketing but not a manual reply', () => {
    const optedOut = { kind: 'direct' as const, isPaused: false, pausedUntilMs: null, isOptedOut: true };
    expect(evaluateEligibility(eligibleInput('zalo', { conversation: optedOut }))).toMatchObject({ reason: 'opted_out', detail: 'conversation' });
    expect(reasonOf(eligibleInput('zalo', { conversation: optedOut, actor: 'approved_care_draft', step: 'send' }))).toBe('opted_out');
    expect(reasonOf(eligibleInput('zalo', { conversation: optedOut, actor: 'marketing', step: 'send', marketingConsent: true }))).toBe('opted_out');
    expect(reasonOf(eligibleInput('zalo', { conversation: optedOut, actor: 'manual_care_reply', step: 'send' }))).toBe('eligible');
  });

  it('human pause window comes from the rule, per channel, and 0 disables it', () => {
    const minutesAgo = (m: number) => NOW - m * 60_000;
    expect(reasonOf(eligibleInput('zalo', { lastHumanReplyAtMs: minutesAgo(10) }))).toBe('human_active'); // zalo default 30
    expect(reasonOf(eligibleInput('zalo', { lastHumanReplyAtMs: minutesAgo(40) }))).toBe('eligible');
    expect(reasonOf(eligibleInput('email', { lastHumanReplyAtMs: minutesAgo(40) }))).toBe('human_active'); // email default 240
    expect(reasonOf(eligibleInput('email', { lastHumanReplyAtMs: minutesAgo(300) }))).toBe('eligible');
    const none = autoRule({ policyExt: { humanPauseMinutes: 0 } });
    expect(reasonOf(eligibleInput('zalo', { resolution: none, lastHumanReplyAtMs: minutesAgo(1) }))).toBe('eligible');
  });

  it('a person answering during the run is caught by the post-run recheck even with no pause window', () => {
    const none = autoRule({ policyExt: { humanPauseMinutes: 0 } });
    const base = eligibleInput('zalo', { resolution: none, lastHumanReplyAtMs: NOW - 5_000, humanRepliedSinceMs: NOW - 10_000 });
    expect(evaluateEligibility(base)).toMatchObject({ reason: 'human_active', detail: 'during_run' });
    expect(reasonOf({ ...base, humanRepliedSinceMs: NOW })).toBe('eligible');
  });

  it('context changed makes an auto turn or an approved draft stale; a stale reviewed draft needs review again', () => {
    expect(reasonOf(eligibleInput('zalo', { contextChanged: true }))).toBe('stale_context');
    expect(reasonOf(eligibleInput('zalo', { actor: 'approved_care_draft', step: 'send', contextChanged: true }))).toBe('stale_context');
    expect(reasonOf(eligibleInput('zalo', { actor: 'approved_care_draft', step: 'send', draftStale: true }))).toBe('stale_context');
    expect(reasonOf(eligibleInput('zalo', { actor: 'manual_care_reply', step: 'send', contextChanged: true, draftStale: true }))).toBe('eligible');
  });

  it('quotas: per thread (rule field), per agent, per account; provider cooldown', () => {
    expect(reasonOf(eligibleInput('zalo', { usage: { threadRepliesToday: 30 } }))).toBe('thread_quota');
    expect(reasonOf(eligibleInput('zalo', { usage: { threadRepliesToday: 29 } }))).toBe('eligible');
    expect(reasonOf(eligibleInput('email', { usage: { threadRepliesToday: 3 } }))).toBe('thread_quota');
    expect(reasonOf(eligibleInput('zalo', { usage: { agentRunsToday: 500 } }))).toBe('agent_quota');
    expect(reasonOf(eligibleInput('zalo', { limits: { agentDailyReplyCap: null }, usage: { agentRunsToday: 99999 } }))).toBe('eligible');
    expect(reasonOf(eligibleInput('zalo', { limits: { accountDailyCap: 10 }, usage: { accountSendsToday: 10 } }))).toBe('account_quota');
    expect(reasonOf(eligibleInput('zalo', { cooldownUntilMs: NOW + 5000 }))).toBe('cooldown_active');
    expect(reasonOf(eligibleInput('zalo', { cooldownUntilMs: NOW - 5000 }))).toBe('eligible');
    const capped = autoRule({ policyExt: { maxRepliesPerThreadDay: 1 } });
    expect(reasonOf(eligibleInput('zalo', { resolution: capped, usage: { threadRepliesToday: 1 } }))).toBe('thread_quota');
  });
});

describe('quiet hours keep each channel behaviour', () => {
  const quiet = { active: true, endsAtMs: NOW + 3_600_000 };
  it('zalo: an auto reply becomes a draft', () => {
    expect(evaluateEligibility(eligibleInput('zalo', { quietHours: quiet }))).toEqual({
      eligible: true,
      reason: 'eligible',
      adjustment: { kind: 'to_draft', cause: 'quiet_hours' },
    });
  });

  it('email: an auto reply is deferred until the window ends', () => {
    expect(evaluateEligibility(eligibleInput('email', { quietHours: quiet }))).toEqual({
      eligible: true,
      reason: 'eligible',
      adjustment: { kind: 'defer', cause: 'quiet_hours', notBeforeMs: NOW + 3_600_000 },
    });
  });

  it('a rule can override its own channel mode, including block; draft mode is unaffected', () => {
    expect(reasonOf(eligibleInput('zalo', { quietHours: quiet, resolution: autoRule({ policyExt: { quietHoursMode: 'block' } }) }))).toBe('quiet_hours');
    expect(evaluateEligibility(eligibleInput('zalo', { quietHours: quiet, resolution: autoRule({ mode: 'draft' }) })).adjustment).toBeUndefined();
  });

  it('marketing is denied in quiet hours; a manual send is not', () => {
    expect(reasonOf(eligibleInput('zalo', { actor: 'marketing', step: 'send', marketingConsent: true, quietHours: quiet }))).toBe('quiet_hours');
    expect(reasonOf(eligibleInput('zalo', { actor: 'manual_care_reply', step: 'send', quietHours: quiet }))).toBe('eligible');
  });
});

describe('actor / purpose matrix', () => {
  it('marketing needs consent and honours cooldown', () => {
    const base = eligibleInput('zalo', { actor: 'marketing', step: 'send' });
    expect(reasonOf(base)).toBe('marketing_consent_missing');
    expect(reasonOf({ ...base, marketingConsent: true })).toBe('eligible');
    expect(reasonOf({ ...base, marketingConsent: true, cooldownUntilMs: NOW + 1 })).toBe('cooldown_active');
  });

  it('manual send ignores pause, human reply, staleness and quotas but not the mandatory gates', () => {
    const base = eligibleInput('zalo', {
      actor: 'manual_care_reply',
      step: 'send',
      conversation: { kind: 'direct', isPaused: true, pausedUntilMs: null, isOptedOut: true },
      lastHumanReplyAtMs: NOW,
      contextChanged: true,
      usage: { threadRepliesToday: 999, agentRunsToday: 999 },
    });
    expect(reasonOf(base)).toBe('eligible');
    expect(reasonOf({ ...base, account: { ...base.account, desiredState: 'paused' } })).toBe('account_inactive');
    expect(reasonOf({ ...base, cooldownUntilMs: NOW + 10 })).toBe('cooldown_active');
  });

  it('approved draft keeps mandatory guards (send flag, opt-out, cooldown) that approval cannot bypass', () => {
    const base = eligibleInput('zalo', { actor: 'approved_care_draft', step: 'send' });
    expect(reasonOf(base)).toBe('eligible');
    expect(reasonOf({ ...base, account: { ...base.account, sendEnabled: false } })).toBe('account_send_disabled');
    expect(reasonOf({ ...base, cooldownUntilMs: NOW + 10 })).toBe('cooldown_active');
    expect(reasonOf({ ...base, killSwitches: killSwitches({ moduleEnabled: false }) })).toBe('kill_switch_module');
  });
});
