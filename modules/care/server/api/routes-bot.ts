/**
 * T07: `GET /conversations/:id/bot` for the inbox's right column (BotPanel).
 *
 * The row's own `workflow.bot` already says WHICH state the conversation is in; this adds what the panel needs to let the
 * owner change it: the effective rule, the nick-wide and the per-conversation rule, the per-conversation AI switch, and the
 * rules read from the real module settings. Writes use the existing routes: `PUT /conversations/:id/ai|pause|takeover`
 * and `/assignments`.
 */

import type { Hono } from 'hono';
import type { CareAssignment } from '../../../_lib/care-kit/types.js';
import { previewEffectiveRule } from '../policy/assignment-resolver.js';
import { ruleContextOf } from '../workflow/bot-state.js';
import type { CareAiMode, CareBotPanelDto, CareBotRuleSummaryDto } from './dto-inbox.js';
import { notFound } from './errors.js';
import type { CareApiContext } from './context.js';
import { idParam } from './util.js';

const summary = (a: CareAssignment, scope: 'account' | 'conversation'): CareBotRuleSummaryDto => ({
  id: a.id,
  scope,
  mode: a.mode,
  agentId: a.agentId,
  enabled: a.enabled,
  configVersion: a.configVersion,
  priority: a.priority,
  instructionsRef: a.instructionsRef ?? null,
  policyExt: a.policyExt ?? null,
});

export function registerBotRoutes(sub: Hono, ctx: CareApiContext): void {
  sub.get('/conversations/:id/bot', (c) => {
    const m = ctx.model();
    // The DTO carries `workflow.bot`; a missing or unreadable conversation is a 404 like everywhere else.
    const dto = m.read(() => m.getConversationDto(idParam(c.req.param('id'))));
    const rec = dto ? m.stores.conversations.getConversation(dto.id) : null;
    if (!dto || !rec || !dto.workflow?.bot) throw notFound();

    const assignments = m.stores.assignments.listAssignments(rec.accountId);
    const preview = previewEffectiveRule(assignments, ruleContextOf(rec, dto.channel));
    const accountRule = assignments.find((a) => a.scope === 'account' && a.accountId === rec.accountId) ?? null;
    const conversationRule = assignments.find((a) => a.scope === 'conversation' && a.accountId === rec.accountId && a.scopeTarget === rec.externalKey) ?? null;
    const rule = preview.rule ?? null;

    const body: CareBotPanelDto = {
      conversationId: dto.id,
      accountId: dto.accountId,
      kind: dto.kind,
      conversationKey: rec.externalKey,
      state: dto.workflow.bot,
      aiMode: storedAiMode(m.db, dto.id),
      takenOver: dto.workflow.ai.takenOver,
      effective: {
        outcome: preview.outcome,
        tier: rule?.tier ?? null,
        agentId: preview.outcome === 'active' && rule ? rule.agentId : null,
        mode: preview.outcome === 'active' && rule ? rule.mode : null,
      },
      accountRule: accountRule ? summary(accountRule, 'account') : null,
      conversationRule: conversationRule ? summary(conversationRule, 'conversation') : null,
      rules: {
        settings: ctx.botSettings ? safeSettings(ctx.botSettings) : null,
        maxRepliesPerThreadDay: preview.outcome === 'active' && rule ? rule.policy.values.maxRepliesPerThreadDay : null,
        humanPauseMinutes: preview.outcome === 'active' && rule ? rule.policy.values.humanPauseMinutes : null,
      },
    };
    return c.json(body);
  });
}

function safeSettings(read: NonNullable<CareApiContext['botSettings']>): CareBotPanelDto['rules']['settings'] {
  try {
    return read();
  } catch {
    return null; // the panel then says the settings could not be read; it never blocks
  }
}

/** The per-conversation switch as stored: the workflow DTO reports `off` both for "never set" and for "set to off". */
function storedAiMode(db: import('better-sqlite3').Database, conversationId: string): CareAiMode | null {
  const row = db.prepare('SELECT ai_mode AS m FROM care_conversation_state WHERE conversation_id = ?').get(conversationId) as { m: CareAiMode | null } | undefined;
  return row?.m ?? null;
}
