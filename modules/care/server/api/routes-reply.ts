/**
 * Reply / delivery routes (CC-07 surface, CC-11 behaviour).
 *
 * The API validates the request shape, resolves the IMMUTABLE target from the stored
 * conversation (the client never names a conversation key or another account), and hands a typed
 * request to the injected `CareReplyPort`. Idempotency, payload hashing, gates and the durable
 * outbox are the port's job. Without a port every route answers 501 with a capability error:
 * there is no direct-send fallback.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import { validateDeliveryCommand, type DeliveryCommand } from '../../../_lib/care-kit/contract.js';
import type { CareReplyAcceptedDto } from './dto.js';
import { ApiError, capability, invalid, notFound } from './errors.js';
import { withSignatureOnce } from '../application/agent-output.js';
import { requireDispatch } from './gate.js';
import { parseBody, parseChannel, type CareApiContext } from './context.js';
import type { CareChatReplyTarget, CareEmailReplyTarget, CareReplyPort, CareReplyRequest } from './ports.js';
import { idParam } from './util.js';

const address = z.string().min(3).max(320);
const MAX_ATTACHMENTS = 10;
const MAX_STYLES = 200;
const MAX_MENTIONS = 50;
const replySchema = z
  .object({
    clientRequestId: z.string().min(8).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
    accountId: z.string().min(1).max(256).optional(),
    channel: z.string().min(1).max(32).optional(),
    // Empty text is re-checked below.
    text: z.string().max(100_000),
    /** Not supported yet: rejected with a capability error. */
    attachments: z.array(z.object({ mediaId: z.string().min(1).max(128) }).strict()).max(MAX_ATTACHMENTS).optional(),
    /** Not supported yet: rejected with a capability error. */
    styles: z
      .array(
        z
          .object({
            st: z.string().min(1).max(32),
            start: z.number().int().min(0),
            len: z.number().int().min(1),
            indentSize: z.number().int().min(1).max(16).optional(),
          })
          .strict(),
      )
      .max(MAX_STYLES)
      .optional(),
    /** Not supported yet: rejected with a capability error. */
    mentions: z
      .array(
        z
          .object({
            uid: z.string().min(1).max(64),
            pos: z.number().int().min(0),
            len: z.number().int().min(1),
            type: z.union([z.literal(0), z.literal(1)]).optional(),
          })
          .strict(),
      )
      .max(MAX_MENTIONS)
      .optional(),
    expectedConversationRevision: z.number().int().min(1).optional(),
    target: z
      .object({
        replyToMessageId: z.string().min(1).max(256).optional(),
        topicId: z.string().min(1).max(32).optional(),
        to: z.array(address).max(100).optional(),
        cc: z.array(address).max(100).optional(),
        subject: z.string().min(1).max(998).optional(),
        inReplyToHeader: z.string().min(1).max(998).optional(),
      })
      .strict()
      .optional(),
    bcc: z.array(address).max(100).optional(),
  })
  .strict();

function requirePort(ctx: CareApiContext): CareReplyPort {
  if (!ctx.replyPort) {
    throw new ApiError('UNSUPPORTED_CAPABILITY', 501, 'Reply delivery is not enabled yet.');
  }
  return ctx.replyPort;
}

export function registerReplyRoutes(sub: Hono, ctx: CareApiContext): void {
  sub.post('/conversations/:id/replies', async (c) => {
    const id = idParam(c.req.param('id'));

    const port = requirePort(ctx);
    const m = ctx.model();
    const body = await parseBody(c, replySchema);
    if (body.text.length === 0) throw invalid();
    if (body.attachments?.length) throw capability('Attachments are not supported for this account.');
    if (body.styles?.length || body.mentions?.length) throw capability('Text formatting and mentions are not supported for this account.');

    const conv = m.stores.conversations.getConversation(id);
    // A different account in the body reads exactly like an unknown conversation.
    if (!conv || (body.accountId && body.accountId !== conv.accountId)) throw notFound();
    const account = m.stores.accounts.getAccount(conv.accountId);
    if (!account) throw notFound();

    const requested = parseChannel(body.channel);
    if (requested && requested !== account.channel) {
      throw new ApiError('INVALID_TARGET', 400, 'The channel does not match the conversation account.');
    }

    let replyToNative: string | undefined;
    if (body.target?.replyToMessageId) {
      // Canonical message ID, which must live in THIS conversation; the port gets the native ID.
      replyToNative = m.messageInConversation(id, body.target.replyToMessageId).nativeMessageId;
    }

    // The server owns the mailbox signature: it is appended exactly once (text that already ends with it is left alone), so a
    // composer that previewed it, an agent draft that carries it and a retry all produce the same final text.
    const text = account.channel === 'email' ? withSignatureOnce(body.text, ctx.signatureOf(account)) : body.text;

    let target: CareChatReplyTarget | CareEmailReplyTarget;
    let probe: DeliveryCommand;
    const common = {
      clientRequestId: body.clientRequestId,
      accountId: account.id,
      purpose: 'care' as const,
      actor: 'manual' as const,
      ownerEpoch: account.ownerEpoch,
      text,
    };
    if (account.channel === 'email') {
      if (body.target?.topicId !== undefined) throw new ApiError('INVALID_TARGET', 400, 'topicId is not valid for email.');
      const to = body.target?.to ?? [];
      const subject = body.target?.subject ?? '';
      target = {
        kind: 'email',
        externalConversationKey: conv.externalKey,
        to,
        ...(body.target?.cc ? { cc: body.target.cc } : {}),
        subject,
        ...(replyToNative ? { replyToMessageId: replyToNative } : {}),
        ...(body.target?.inReplyToHeader ? { inReplyToHeader: body.target.inReplyToHeader } : {}),
      };
      probe = { ...common, kind: 'email', channel: 'email', target, ...(body.bcc ? { bcc: body.bcc } : {}) };
    } else {
      if (body.bcc || body.target?.to || body.target?.cc || body.target?.subject || body.target?.inReplyToHeader) {
        throw new ApiError('INVALID_TARGET', 400, 'Chat replies cannot carry email recipients, subject or BCC.');
      }
      target = {
        kind: 'chat',
        externalConversationKey: conv.externalKey,
        ...(replyToNative ? { replyToMessageId: replyToNative } : {}),
        ...(body.target?.topicId ? { topicId: body.target.topicId } : {}),
      };
      probe = { ...common, kind: 'chat', channel: account.channel, target };
    }
    // Reuse the connector contract's structural validation (addresses, header safety, topic id).
    validateDeliveryCommand(probe);

    const request: CareReplyRequest = {
      clientRequestId: body.clientRequestId,
      conversationId: conv.id,
      accountId: account.id,
      channel: account.channel,
      purpose: 'care',
      actor: 'manual',
      text,
      target,
      ...(body.bcc ? { bcc: body.bcc } : {}),
      ...(body.expectedConversationRevision !== undefined ? { expectedConversationRevision: body.expectedConversationRevision } : {}),
    };
    // expectedConversationRevision is NOT compared here: a retry of an accepted request must still
    // return the same intent after the conversation moved on. The port applies it after its dedupe.

    // The ONE dispatch gate, before anything is enqueued: kill switch, module/path/channel switches, owner, epoch,
    // account state and send flag. A retry of an already accepted request is refused too while a switch is off.
    requireDispatch(m.db, account.id, account.ownerEpoch, { operation: 'send', actorType: 'manual' });

    const accepted = await port.submitReply(request);
    const dto: CareReplyAcceptedDto = { intentId: accepted.intent.id, duplicate: accepted.duplicate, intent: accepted.intent };
    c.header('Location', `/api/m/care/outbox/${encodeURIComponent(accepted.intent.id)}`);
    return c.json(dto, 202);
  });

  sub.get('/outbox/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const port = requirePort(ctx);
    const intent = await port.getOutbox(id);
    if (!intent) throw notFound();
    return c.json(intent);
  });

  sub.post('/outbox/:id/cancel', async (c) => {
    const id = idParam(c.req.param('id'));
    const port = requirePort(ctx);
    const intent = await port.cancel(id);
    if (!intent) throw notFound();
    return c.json(intent);
  });

  sub.post('/outbox/:id/reconcile', async (c) => {
    const port = requirePort(ctx);
    const intent = await port.reconcile(idParam(c.req.param('id')));
    if (!intent) throw notFound();
    return c.json(intent, 202);
  });
}
