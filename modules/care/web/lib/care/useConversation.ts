// Loads one conversation + its message window, keeps it fresh from stream ticks, and exposes the
// paging actions. All state transitions go through the pure helpers in cursor.ts.

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { careApi } from './client';
import { emptyWindow, mergeLatest, mergeNewer, mergeOlder, windowFromPage, type MessageWindow } from './cursor';
import type { CareConversationDto } from './dto';
import { toCareFailure, type CareFailure } from './failure';

export interface ConversationState {
  conversation: CareConversationDto | null;
  window: MessageWindow;
  loading: boolean;
  error: CareFailure | null;
  loadingOlder: boolean;
  loadingNewer: boolean;
  /** Newer messages exist but the reader is looking at an older window. */
  behind: boolean;
  /** Id of a message that arrived after the first load (drives the aria-live announcement). */
  announce: { id: string; role: string; text: string } | null;
}

const INITIAL: ConversationState = {
  conversation: null, window: emptyWindow(), loading: false, error: null, loadingOlder: false, loadingNewer: false, behind: false, announce: null,
};

export function useConversation(id: string | null, around: string | null, convTick: number, resyncTick: number) {
  const [state, setState] = useState<ConversationState>(INITIAL);
  const seq = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastTicks = useRef({ convTick, resyncTick });

  const loadFresh = useCallback(async (convId: string, aroundId: string | null) => {
    const mine = ++seq.current;
    setState({ ...INITIAL, loading: true });
    try {
      const [conversation, page] = await Promise.all([
        careApi.conversation(convId),
        careApi.messages(convId, aroundId ? { around: aroundId } : {}),
      ]);
      if (mine !== seq.current) return;
      setState({ ...INITIAL, conversation, window: windowFromPage(page) });
    } catch (e) {
      if (mine !== seq.current) return;
      setState({ ...INITIAL, error: toCareFailure(e) });
    }
  }, []);

  // Open / switch conversation (or jump to a search hit).
  useEffect(() => {
    lastTicks.current = { convTick, resyncTick };
    if (!id) {
      seq.current += 1;
      setState(INITIAL);
      return;
    }
    void loadFresh(id, around);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, around]);

  const refresh = useCallback(async (resync = false) => {
    if (!id) return;
    const mine = ++seq.current;
    try {
      const [conversation, page] = await Promise.all([careApi.conversation(id), careApi.messages(id)]);
      if (mine !== seq.current) return;
      setState((s) => {
        const before = s.window.items[0]?.id ?? null;
        const merged = resync
          ? { window: s.window.newerCursor === null ? windowFromPage(page) : s.window, behind: s.window.newerCursor !== null }
          : mergeLatest(s.window, page);
        const head = merged.window.items[0];
        const fresh = head && head.id !== before && s.window.items.length > 0 && head.senderRole === 'customer';
        return {
          ...s,
          conversation,
          window: merged.window,
          behind: merged.behind,
          error: null,
          announce: fresh ? { id: head.id, role: head.senderRole, text: head.text.slice(0, 140) } : s.announce,
        };
      });
    } catch (e) {
      if (mine !== seq.current) return;
      // A failed background refresh keeps what is on screen; only a vanished conversation is fatal.
      const f = toCareFailure(e);
      if (f.code === 'NOT_FOUND') setState({ ...INITIAL, error: f });
    }
  }, [id]);

  // Stream-driven refresh of the open conversation.
  useEffect(() => {
    const prev = lastTicks.current;
    lastTicks.current = { convTick, resyncTick };
    if (!id || (prev.convTick === convTick && prev.resyncTick === resyncTick)) return;
    void refresh(prev.resyncTick !== resyncTick);
  }, [id, convTick, resyncTick, refresh]);

  const loadOlder = useCallback(async () => {
    const s = stateRef.current;
    if (!id || !s.window.olderCursor || s.loadingOlder) return;
    const mine = seq.current;
    setState((x) => ({ ...x, loadingOlder: true }));
    try {
      const page = await careApi.messages(id, { before: s.window.olderCursor });
      if (mine !== seq.current) return;
      setState((x) => ({ ...x, loadingOlder: false, window: mergeOlder(x.window, page) }));
    } catch (e) {
      if (mine !== seq.current) return;
      setState((x) => ({ ...x, loadingOlder: false, error: x.window.items.length ? null : toCareFailure(e) }));
    }
  }, [id]);

  const loadNewer = useCallback(async () => {
    const s = stateRef.current;
    if (!id || !s.window.newerCursor || s.loadingNewer) return;
    const mine = seq.current;
    setState((x) => ({ ...x, loadingNewer: true }));
    try {
      const page = await careApi.messages(id, { after: s.window.newerCursor });
      if (mine !== seq.current) return;
      setState((x) => ({ ...x, loadingNewer: false, window: mergeNewer(x.window, page) }));
    } catch {
      if (mine !== seq.current) return;
      setState((x) => ({ ...x, loadingNewer: false }));
    }
  }, [id]);

  const setConversation = useCallback((conversation: CareConversationDto) => {
    setState((x) => (x.conversation && x.conversation.id === conversation.id ? { ...x, conversation } : x));
  }, []);

  const reload = useCallback(() => { if (id) void loadFresh(id, null); }, [id, loadFresh]);

  return { state, loadOlder, loadNewer, setConversation, reload, refresh };
}
