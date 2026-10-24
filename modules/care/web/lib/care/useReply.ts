// Reply submission for one conversation: per-conversation draft, stable clientRequestId, and the
// outcome handling (202 / duplicate / 501 / 409 / network). Everything that must survive a
// conversation switch lives in the module-level stores; component state is only the transient notice.

import { useEffect, useRef, useState } from 'preact/hooks';
import { careApi } from './client';
import { classifyFailure, draftHasContent, prepareSubmit, settleDraftAgainst, type ComposerDraft, type SubmitOutcome } from './composer';
import type { CareConversationDto, CareMessageDto } from './dto';
import { toCareFailure, type CareFailure } from './failure';
import { ct } from './i18n';
import { reasonText } from './reasons';
import { draftStore, intentStore } from './singletons';

export type NoticeTone = 'info' | 'warn' | 'error';
export interface Notice { tone: NoticeTone; text: string }

function errorText(code: string): string {
  const key = `composer.error.${code}`;
  const v = ct(key);
  return v === key ? ct('composer.error.DEFAULT') : v;
}

export function noticeFor(outcome: SubmitOutcome, failure: CareFailure | null): Notice | null {
  // A gate / runtime reason (module off, owner changing, path disabled...) explains itself better than the code.
  const why = reasonText(failure?.reason);
  if (why && (outcome.kind === 'rejected' || outcome.kind === 'conflict')) return { tone: outcome.kind === 'conflict' ? 'warn' : 'error', text: why };
  switch (outcome.kind) {
    case 'accepted':
      return { tone: 'info', text: outcome.duplicate ? ct('composer.duplicate') : ct('composer.accepted') };
    case 'unavailable':
      return null; // rendered as the persistent capability panel instead
    case 'conflict':
      return { tone: 'warn', text: outcome.code === 'DUPLICATE_REQUEST_PAYLOAD_MISMATCH' ? ct('composer.mismatch') : outcome.code === 'STALE_REVISION' ? ct('composer.stale') : errorText(outcome.code) };
    case 'unknown':
      return { tone: 'warn', text: ct('composer.unknown') };
    case 'rejected':
      if (outcome.code === 'RATE_LIMITED' && failure?.retryAt) {
        return { tone: 'error', text: ct('composer.rateLimited', { time: new Date(failure.retryAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) }) };
      }
      return { tone: 'error', text: errorText(outcome.code) };
  }
}

export function useReply(args: {
  conversation: CareConversationDto;
  messages: CareMessageDto[];
  ownAddresses: string[];
  kind: 'chat' | 'email';
  /** From /status: false means the server has no reply port (501). null while unknown. */
  replyEnabled: boolean | null;
  /** From the account's `delivery.replyVia`; undefined on a server without inbox v2. */
  replyVia?: 'legacy' | 'core' | 'none';
  onAccepted: () => void;
}) {
  const { conversation, kind } = args;
  const id = conversation.id;
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const offDrafts = draftStore.subscribe(bump);
    const offIntents = intentStore.subscribe(bump);
    return () => { offDrafts(); offIntents(); };
  }, []);

  const draft = draftStore.get(id, kind);

  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [capabilityMissing, setCapabilityMissing] = useState(false);
  const mounted = useRef(true);
  const current = useRef(id);
  current.current = id;
  useEffect(() => () => { mounted.current = false; }, []);

  // `none`: no way to deliver for this account. A legacy account always delivers through the old outbox, whatever /status says.
  const unavailable = args.replyVia === 'none' || (args.replyVia !== 'legacy' && args.replyEnabled === false) || capabilityMissing;

  function update(fn: (d: ComposerDraft) => ComposerDraft): void {
    draftStore.update(id, kind, fn);
    if (notice) setNotice(null);
  }

  async function submit(): Promise<void> {
    if (submitting || unavailable) return;
    const stored = draftStore.get(id, kind);
    if (!draftHasContent(stored)) {
      setNotice({ tone: 'warn', text: ct('composer.empty') });
      return;
    }
    const prepared = prepareSubmit({ draft: stored, conversation, messages: args.messages, ownAddresses: args.ownAddresses });
    if (!prepared.ok) {
      setNotice({ tone: 'warn', text: prepared.reason === 'no_recipient' ? ct('composer.noRecipient') : prepared.reason === 'no_message' ? ct('composer.noMessage') : ct('composer.empty') });
      return;
    }
    const { body, draft: sent } = prepared.value;
    // Persist the id BEFORE the request: a reload or crash mid-flight must retry with the same id.
    draftStore.set(id, sent);
    setSubmitting(true);
    setNotice(null);
    let outcome: SubmitOutcome;
    let failure: CareFailure | null = null;
    try {
      const res = await careApi.reply(id, body);
      intentStore.upsert(id, res.intent, sent.kind === 'chat' ? sent.text : sent.body);
      outcome = { kind: 'accepted', duplicate: res.duplicate };
      // The text came from an AI draft: it is answered now, so retire the draft (the server may already have superseded it).
      if (sent.fromDraftId) void careApi.discardInline(sent.fromDraftId).catch(() => undefined);
    } catch (e) {
      failure = toCareFailure(e);
      outcome = classifyFailure(failure);
    }
    draftStore.update(id, kind, (cur) => settleDraftAgainst(cur, sent, outcome));
    if (mounted.current) {
      setSubmitting(false);
      if (outcome.kind === 'unavailable') setCapabilityMissing(true);
      // The conversation may have changed while the request ran; its notice belongs to it alone.
      if (current.current === id) setNotice(noticeFor(outcome, failure));
    }
    if (outcome.kind === 'accepted' || (outcome.kind === 'conflict' && outcome.refresh)) args.onAccepted();
  }

  return { draft, update, submit, submitting, notice, unavailable, dismissNotice: () => setNotice(null) };
}
