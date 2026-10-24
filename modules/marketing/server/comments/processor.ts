/**
 * Decides what to do with new comments: runs the pipeline (rules.ts), checks
 * the reply limits, asks the agent when needed, and either stores the final
 * state (skipped / human / hidden) or queues a reply for the sender.
 *
 * A comment stays `new` (to be looked at again) only when the decision has to
 * wait: the hourly cap is spent, the kill switch is off, or Facebook is
 * rate-limiting. Everything else ends in a definite status.
 */

import {
  bumpFbReplyTemplateUses,
  countFbRepliesDecidedSince,
  countFbRepliesToAuthorOnPost,
  getFbCommentPage,
  getFbPostText,
  hasFbReplyToAuthorSince,
  listFbNewComments,
  listFbReplyTemplates,
  listFbThreadComments,
  updateFbComment,
  type FbCommentPageRow,
  type FbCommentRow,
  type FbReplyTemplateRow,
} from '../store.js';
import { listAgentIds } from '../compat.js';
import { getRuntime } from '../runtime.js';
import { logger } from '../compat.js';
import {
  ComposioConnectionExpiredError,
  ComposioRateLimitError,
  FbBudgetExceeded,
} from '../../../_lib/composio.js';
import { notifyOwner } from '../notify.js';
import type { ReplyRuleConfig, ReplyTemplateDto } from '../types.js';
import { buildCommentPrompt, runCommentAgentTurn, type CommentDecision } from './agent-turn.js';
import { describeError, handleExpired, setCommentHidden } from './common.js';
import { effectiveRules, readFaqFile, readSkillText } from './config.js';
import { checkReplyLimits, computeSendAfter, isStale, STALE_REASON, type LimitUsage } from './limits.js';
import { findUnknownUrls, runPipeline } from './rules.js';
import { getAutoReplySince } from './state.js';

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** New comments looked at per Page per tick; the agent is the slow part, so it has its own cap. */
const BATCH_PER_PAGE = 30;
const AGENT_TURNS_PER_TICK = 3;

export function templateFromRow(r: FbReplyTemplateRow): ReplyTemplateDto {
  const list = (json: string): string[] => {
    try {
      const v = JSON.parse(json) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
  };
  return {
    id: r.id,
    pageId: r.page_id,
    postId: r.post_id,
    name: r.name,
    keywords: list(r.keywords_json),
    matchMode: r.match_mode === 'exact' ? 'exact' : 'contains',
    variants: list(r.variants_json),
    privateText: r.private_text,
    enabled: r.enabled === 1,
    sort: r.sort,
    uses: r.uses,
  };
}

export function loadTemplates(pageId: string): ReplyTemplateDto[] {
  return listFbReplyTemplates(pageId).map(templateFromRow);
}

/** What happened to a comment in one pass. */
export type Disposition = 'decided' | 'deferred' | 'stop-page' | 'stop-all';

export interface ProcessDeps {
  now?: () => number;
}

interface QueueArgs {
  step: 'template' | 'agent';
  ruleRef: string;
  reason: string;
  action: 'reply' | 'react';
  replyText: string;
  privateText: string;
  topic: string;
}

function queue(c: FbCommentRow, rules: ReplyRuleConfig, now: number, args: QueueArgs): void {
  const draft = rules.sendMode === 'draft';
  updateFbComment(c.id, {
    step: args.step,
    rule_ref: args.ruleRef,
    reason: args.reason,
    action: args.action,
    reply_text: args.replyText,
    private_text: args.privateText,
    topic: args.topic,
    status: draft ? 'draft' : 'queued',
    send_after: computeSendAfter(rules, now),
    decided_at: now,
    error: '',
  });
}

function finish(c: FbCommentRow, now: number, fields: Parameters<typeof updateFbComment>[1]): void {
  updateFbComment(c.id, { decided_at: now, error: '', ...fields });
}

function limitUsage(c: FbCommentRow, rules: ReplyRuleConfig, now: number): LimitUsage {
  return {
    pageRepliesLastHour: countFbRepliesDecidedSince(c.page_id, now - 3600),
    authorRepliesOnPost: countFbRepliesToAuthorOnPost(c.post_id, c.author_id, c.id),
    authorRepliedRecently: rules.onlyIfNotRepliedHours != null
      && hasFbReplyToAuthorSince(c.post_id, c.author_id, c.id, now - rules.onlyIfNotRepliedHours * 3600),
  };
}

async function notifyHuman(page: FbCommentPageRow, c: FbCommentRow, rules: ReplyRuleConfig, why: string): Promise<void> {
  if (rules.notify === 'none') return;
  const snippet = c.message.replace(/\s+/g, ' ').trim().slice(0, 200);
  await notifyOwner(`Bình luận cần người xử lý trên "${page.name}" (${why}): ${c.author_name || 'Khách'}: "${snippet}"`);
}

function agentLooksSafe(decision: CommentDecision, knownText: string): boolean {
  return findUnknownUrls(`${decision.text} ${decision.privateText}`, knownText).length === 0;
}

async function runAgent(
  page: FbCommentPageRow,
  c: FbCommentRow,
  rules: ReplyRuleConfig,
): Promise<{ decision: CommentDecision | null; error?: string; knownText: string }> {
  const post = getFbPostText(c.post_id);
  const caption = rules.contextPost && post ? [post.title, post.caption].filter(Boolean).join('\n') : '';
  const faq = rules.contextFaqPath ? readFaqFile(rules.contextFaqPath) : '';
  const voice = rules.contextVoice ? page.brand_voice : '';
  const thread = rules.contextThread > 0
    ? listFbThreadComments(c.post_id, c.created_time, c.id, rules.contextThread).reverse().map((t) => ({
        who: t.from_page ? 'page' as const : 'customer' as const,
        name: t.author_name,
        text: t.message || t.reply_text,
      }))
    : [];
  const prompt = buildCommentPrompt({
    pageName: page.name, brandVoice: voice, postCaption: caption, faq, thread,
    authorName: c.author_name, comment: c.message, instructions: rules.instructions,
  });
  const agentId = rules.agentId === 'main' || listAgentIds().includes(rules.agentId) ? rules.agentId : 'main';
  const result = await runCommentAgentTurn({
    agentId, commentId: c.id, skillText: rules.skill ? readSkillText(rules.skill) : '', prompt,
  });
  return { decision: result.decision, error: result.error, knownText: `${faq}\n${caption}\n${voice}\n${rules.instructions}` };
}

function agentMayReply(agentId: string): boolean {
  const ctx = getRuntime();
  const id = agentId === 'main' || listAgentIds().includes(agentId) ? agentId : 'main';
  return !ctx || ctx.access.can(id, 'comments.reply');
}

/**
 * Applies the pipeline to one comment. Returns what the caller should do next.
 * `agentBudget.left` is decremented when an agent turn is spent.
 */
export async function processComment(
  page: FbCommentPageRow,
  c: FbCommentRow,
  agentBudget: { left: number },
  now: number = nowSec(),
): Promise<Disposition> {
  const rules = effectiveRules(page.id, c.post_id);

  if (!rules.enabled) {
    finish(c, now, { step: 'skip', status: 'skipped', reason: 'Bài này tắt trả lời tự động' });
    return 'decided';
  }
  const since = getAutoReplySince(page.id);
  if (isStale(c.created_time, now) || since == null || c.created_time < since) {
    finish(c, now, { step: 'skip', status: 'skipped', reason: STALE_REASON });
    return 'decided';
  }

  const outcome = runPipeline({
    text: c.message, authorName: c.author_name, rules, templates: loadTemplates(page.id), postId: c.post_id,
  });

  switch (outcome.step) {
    case 'spam': {
      try {
        await setCommentHidden(page, c.id, true);
      } catch (err) {
        if (err instanceof ComposioConnectionExpiredError) { await handleExpired(page); return 'stop-page'; }
        if (err instanceof ComposioRateLimitError || err instanceof FbBudgetExceeded) return 'stop-all';
        finish(c, now, { step: 'spam', rule_ref: 'spam', reason: outcome.reason, status: 'failed', error: describeError(err) });
        return 'decided';
      }
      finish(c, now, { step: 'spam', rule_ref: 'spam', reason: outcome.reason, status: 'hidden' });
      return 'decided';
    }

    case 'complaint':
      finish(c, now, { step: 'complaint', rule_ref: 'complaint', reason: outcome.reason, status: 'human' });
      await notifyHuman(page, c, rules, outcome.reason);
      return 'decided';

    case 'template': {
      const verdict = checkReplyLimits('template', rules, limitUsage(c, rules, now));
      if (!verdict.ok) {
        if (verdict.kind === 'defer') return 'deferred';
        finish(c, now, { step: 'skip', status: 'skipped', reason: verdict.reason });
        return 'decided';
      }
      queue(c, rules, now, {
        step: 'template', ruleRef: `template:${outcome.template.id}`, reason: outcome.reason, action: 'reply',
        replyText: outcome.replyText, privateText: outcome.privateText, topic: outcome.template.name,
      });
      bumpFbReplyTemplateUses(outcome.template.id);
      return 'decided';
    }

    case 'agent': {
      const verdict = checkReplyLimits('agent', rules, limitUsage(c, rules, now));
      if (!verdict.ok) {
        if (verdict.kind === 'defer') return 'deferred';
        finish(c, now, { step: 'skip', status: 'skipped', reason: verdict.reason });
        return 'decided';
      }
      if (!agentMayReply(rules.agentId)) {
        finish(c, now, { step: 'agent', rule_ref: `agent:${rules.agentId}`, status: 'human', reason: `Agent "${rules.agentId}" chưa được cấp quyền comments.reply` });
        await notifyHuman(page, c, rules, 'agent chưa có quyền trả lời bình luận');
        return 'decided';
      }
      if (agentBudget.left <= 0) return 'deferred';
      agentBudget.left--;

      const ref = `agent:${rules.agentId}`;
      let turn: Awaited<ReturnType<typeof runAgent>>;
      try {
        turn = await runAgent(page, c, rules);
      } catch (err) {
        logger.warn({ err: (err as Error)?.name, commentId: c.id }, 'fbstudio comment agent turn failed');
        return 'deferred';
      }
      const d = turn.decision;
      if (!d) {
        finish(c, now, {
          step: 'agent', rule_ref: ref, status: 'failed', reason: outcome.reason,
          error: turn.error ?? 'Agent không trả về quyết định hợp lệ',
        });
        return 'decided';
      }
      const base = { step: 'agent', rule_ref: ref, topic: d.topic } as const;
      if (d.action === 'skip') {
        finish(c, now, { ...base, status: 'skipped', reason: d.reason || 'Agent bỏ qua' });
        return 'decided';
      }
      if (d.action === 'handoff') {
        finish(c, now, { ...base, status: 'human', reason: d.reason || 'Agent chuyển người' });
        await notifyHuman(page, c, rules, d.reason || 'agent chuyển người');
        return 'decided';
      }
      if (d.action === 'reply' && !agentLooksSafe(d, turn.knownText)) {
        finish(c, now, { ...base, status: 'human', reason: 'Trả lời của agent có liên kết không có trong tài liệu' });
        await notifyHuman(page, c, rules, 'trả lời chứa liên kết lạ');
        return 'decided';
      }
      queue(c, rules, now, {
        step: 'agent', ruleRef: ref, reason: d.reason || outcome.reason,
        action: d.action === 'react' ? 'react' : 'reply',
        replyText: d.text, privateText: d.privateText, topic: d.topic,
      });
      return 'decided';
    }

    default:
      finish(c, now, { step: 'skip', status: 'skipped', reason: outcome.reason });
      return 'decided';
  }
}

/** One processing pass over the new comments of every Page in `pageIds`. */
export async function processNewComments(pageIds: string[], now: () => number = nowSec): Promise<void> {
  const agentBudget = { left: AGENT_TURNS_PER_TICK };
  for (const pageId of pageIds) {
    const page = getFbCommentPage(pageId);
    if (!page || !page.enabled || page.status === 'EXPIRED' || page.status === 'MISSING') continue;
    for (const c of listFbNewComments(pageId, BATCH_PER_PAGE)) {
      let disposition: Disposition;
      try {
        disposition = await processComment(page, c, agentBudget, now());
      } catch (err) {
        logger.warn({ err: (err as Error)?.name, commentId: c.id }, 'fbstudio comment processing failed');
        disposition = 'deferred';
      }
      if (disposition === 'stop-all') return;
      if (disposition === 'stop-page') break;
    }
  }
}
