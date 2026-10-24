import { describe, expect, it } from 'vitest';
import { applyAgentTurnEffects } from './agent-turn-effects.js';
import { seed } from './agent-test-support.js';

describe('applyAgentTurnEffects / setOptedOut', () => {
  it('marks the conversation opted out once, bumping the revision only on change', () => {
    const s = seed();
    const before = s.stores.conversations.getConversation(s.conversationId)!;
    expect(before.isOptedOut).toBe(false);
    applyAgentTurnEffects(s.stores, s.conversationId, ['mark_opted_out']);
    const after = s.stores.conversations.getConversation(s.conversationId)!;
    expect(after.isOptedOut).toBe(true);
    expect(after.revision).toBe(before.revision + 1);
    applyAgentTurnEffects(s.stores, s.conversationId, ['mark_opted_out']);
    expect(s.stores.conversations.getConversation(s.conversationId)!.revision).toBe(after.revision);
    applyAgentTurnEffects(s.stores, s.conversationId, []);
    expect(s.stores.conversations.setOptedOut(s.conversationId, false)).toBe(true);
    expect(s.stores.conversations.getConversation(s.conversationId)!.isOptedOut).toBe(false);
    expect(s.stores.conversations.setOptedOut('missing', true)).toBe(false);
    s.close();
  });

  it('an opt-out message ends in a skipped run, the effect, and then no further turn for the conversation', async () => {
    const s = seed({ messages: [{ text: 'Đừng nhắn tin cho mình nữa' }] });
    const out = await s.turn().run({ conversationId: s.conversationId, triggerMessageId: s.triggerId });
    expect(out).toMatchObject({ status: 'skipped', reason: 'opted_out', effects: ['mark_opted_out'] });
    applyAgentTurnEffects(s.stores, s.conversationId, out.effects);
    const next = s.ingest.ingestNormalizedMessage({
      ...(s.stores.messages.getMessage(s.triggerId) as never as Record<string, never>),
      accountId: s.account.id, externalConversationKey: 'peer:1', nativeMessageNamespace: 'zalo_chat', nativeMessageId: 'later-1', nativeVersion: '1',
      direction: 'in', senderRole: 'customer', senderIdentityKey: 'customer:1', origin: 'live', sentAtMs: Date.parse('2026-10-09T10:05:00Z'),
      text: 'cho mình hỏi giá', metadata: { type: 'chat' },
    } as never);
    s.now.value = Date.parse('2026-10-09T10:06:00Z');
    const again = await s.turn().run({ conversationId: s.conversationId, triggerMessageId: next.messageId! });
    expect(again).toMatchObject({ status: 'skipped', reason: 'opted_out' });
    expect(s.runner.requests).toHaveLength(0);
    s.close();
  });
});
