import { describe, expect, it } from 'vitest';
import { CareError } from '../../../_lib/care-kit/errors.js';
import { memoryFixture } from '../test-fixtures.js';
import {
  aiChannelGate,
  assertAiAllowedForChannel,
  TELEGRAM_AI_DISABLED_REASON,
  telegramAiAllowed,
} from './ai-block.js';

describe('Telegram AI is disabled by design in V1 (AC-032)', () => {
  it('is a hard false with a stable reason, whatever the caller passes', () => {
    expect(telegramAiAllowed()).toEqual({ allowed: false, reason: 'disabled_by_design_v1' });
    expect(TELEGRAM_AI_DISABLED_REASON).toBe('disabled_by_design_v1');
    for (const ctx of [undefined, null, {}, { aiEnabled: true }, { ai_enabled: 1, consent: true, override: 'yes' }, 'true', 1]) {
      expect(telegramAiAllowed(ctx).allowed).toBe(false);
    }
  });

  it('cannot be bypassed by the ai flag on the account row (all gates on)', () => {
    const fx = memoryFixture({
      channel: 'telegram',
      connectorKind: 'telegram-user',
      nativeAccountId: '5000',
      aiEnabled: true,
      syncEnabled: true,
      sendEnabled: true,
      desiredState: 'active',
      writeOwner: 'core',
    });
    try {
      expect(fx.account.aiEnabled).toBe(true); // the flag really is on...
      expect(telegramAiAllowed(fx.account).allowed).toBe(false); // ...and changes nothing
      fx.stores.accounts.updateAccountFlags(fx.account.id, { aiEnabled: true });
      const stored = fx.stores.accounts.getAccount(fx.account.id)!;
      expect(stored.aiEnabled).toBe(true);
      expect(aiChannelGate(stored.channel)).toEqual({ allowed: false, reason: 'disabled_by_design_v1' });
      expect(() => assertAiAllowedForChannel(stored.channel)).toThrow(CareError);
    } finally {
      fx.close();
    }
  });

  it('the verdict is immutable and the guard throws a coded 403 for Telegram only', () => {
    const verdict = telegramAiAllowed();
    expect(Object.isFrozen(verdict)).toBe(true);
    expect(() => {
      (verdict as { allowed: boolean }).allowed = true;
    }).toThrow();
    expect(telegramAiAllowed().allowed).toBe(false); // a fresh call is unaffected

    try {
      assertAiAllowedForChannel('telegram');
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CareError);
      expect((err as CareError).status).toBe(403);
      expect((err as CareError).details).toEqual({ reason: 'disabled_by_design_v1' });
    }
    expect(() => assertAiAllowedForChannel('zalo')).not.toThrow();
    expect(() => assertAiAllowedForChannel('email')).not.toThrow();
    expect(aiChannelGate('zalo').allowed).toBe(true);
  });

  it('is not influenced by environment flags', () => {
    const prev = process.env.CARE_TELEGRAM_AI;
    process.env.CARE_TELEGRAM_AI = '1';
    try {
      expect(telegramAiAllowed().allowed).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CARE_TELEGRAM_AI;
      else process.env.CARE_TELEGRAM_AI = prev;
    }
  });
});
