// T07: loads the bot column of one conversation (panel + agent runs) and runs every change the owner can make there.
// Each change answers with a toast carrying "Hoàn tác" for five seconds. Nothing polls: the panel reloads when the care
// stream says this conversation changed (`convTick`) and after each of its own actions.

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { CareAiMode, CareAssignmentMode, CareBotPanelDto, CareBotRuleSummaryDto } from '@modules/care/server/api/dto-inbox';
import type { CareRunDto } from '@modules/care/server/api/dto-ops';
import { pushToast } from '@/lib/toasts';
import { careApi } from './client';
import type { CareConversationDto } from './dto';
import { toCareFailure } from './failure';
import { ct } from './i18n';
import { modeLabel, type AnyMode, type PanelScope } from './botView';
import type { RuleBody } from './rules';

/** How long the "Hoàn tác" button stays on screen. */
export const UNDO_MS = 5000;

/** Scope the panel opens on: this conversation when it already has a rule or switch of its own, otherwise the whole nick. */
export function defaultScope(panel: Pick<CareBotPanelDto, 'conversationRule' | 'aiMode'>): PanelScope {
  return panel.conversationRule || panel.aiMode === 'off' || panel.aiMode === 'draft' ? 'conversation' : 'account';
}

/** Body of a PUT/POST to /assignments for one scope, changing only what `patch` names. */
export function ruleBody(scope: PanelScope, panel: CareBotPanelDto, patch: { mode?: CareAssignmentMode; agentId?: string; enabled?: boolean }): RuleBody {
  const cur: CareBotRuleSummaryDto | null = scope === 'account' ? panel.accountRule : panel.conversationRule;
  const body: RuleBody = {
    scope,
    accountId: panel.accountId,
    scopeTarget: scope === 'conversation' ? panel.conversationKey : null,
    priority: cur?.priority ?? 100,
    enabled: patch.enabled ?? cur?.enabled ?? true,
    mode: patch.mode ?? cur?.mode ?? 'draft',
    agentId: patch.agentId ?? cur?.agentId,
    instructionsRef: cur?.instructionsRef ?? null,
    policyExt: cur?.policyExt ?? null,
  };
  if (cur) body.expectedConfigVersion = cur.configVersion;
  return body;
}

export interface BotPanelState {
  panel: CareBotPanelDto | null;
  runs: CareRunDto[];
  loading: boolean;
  error: string | null;
  busy: boolean;
}

export function useBotPanel(conversationId: string, convTick: number, resyncTick: number, onConversation: (c: CareConversationDto) => void) {
  const [state, setState] = useState<BotPanelState>({ panel: null, runs: [], loading: true, error: null, busy: false });
  const seq = useRef(0);
  const panelRef = useRef<CareBotPanelDto | null>(null);
  panelRef.current = state.panel;

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [panel, runs] = await Promise.all([
        careApi.botPanel(conversationId),
        careApi.runs(conversationId).then((r) => r.items).catch(() => [] as CareRunDto[]),
      ]);
      if (mine !== seq.current) return;
      setState((s) => ({ ...s, panel, runs, loading: false, error: null }));
    } catch (e) {
      if (mine !== seq.current) return;
      setState((s) => ({ ...s, loading: false, error: toCareFailure(e).message }));
    }
  }, [conversationId]);

  useEffect(() => { setState({ panel: null, runs: [], loading: true, error: null, busy: false }); }, [conversationId]);
  useEffect(() => { void load(); }, [load, convTick, resyncTick]);

  /** Runs one change, then reloads. `undo` (when given) is offered for five seconds. */
  const act = useCallback(async (title: string, run: () => Promise<CareConversationDto | unknown>, undo?: () => Promise<unknown>) => {
    setState((s) => ({ ...s, busy: true }));
    try {
      const res = await run();
      const conv = res as Partial<CareConversationDto> | null;
      if (conv && typeof conv.id === 'string' && conv.workflow) onConversation(conv as CareConversationDto);
      pushToast({
        tone: 'success',
        title,
        ttlMs: UNDO_MS,
        ...(undo
          ? {
              action: {
                label: ct('bot.toast.undo'),
                onClick: async () => {
                  try {
                    const back = await undo();
                    const c2 = back as Partial<CareConversationDto> | null;
                    if (c2 && typeof c2.id === 'string' && c2.workflow) onConversation(c2 as CareConversationDto);
                    pushToast({ tone: 'info', title: ct('bot.toast.undone'), ttlMs: 2500 });
                  } catch (e) {
                    pushToast({ tone: 'error', title: ct('bot.toast.undoFailed'), description: toCareFailure(e).message });
                  } finally {
                    void load();
                  }
                },
              },
            }
          : {}),
      });
    } catch (e) {
      pushToast({ tone: 'error', title: ct('bot.toast.failed'), description: toCareFailure(e).message });
    } finally {
      setState((s) => ({ ...s, busy: false }));
      void load();
    }
  }, [load, onConversation]);

  /** Mode change in a scope: the rule's mode for the nick, the per-conversation switch for this chat. */
  const setMode = useCallback((scope: PanelScope, mode: AnyMode) => {
    const panel = panelRef.current;
    if (!panel) return Promise.resolve();
    const title = ct('bot.toast.mode', { mode: modeLabel(mode) });
    if (scope === 'conversation') {
      const before: CareAiMode = panel.aiMode ?? 'auto'; // "never set" behaves exactly like auto
      return act(title, () => careApi.setAiMode(conversationId, mode as CareAiMode), () => careApi.setAiMode(conversationId, before));
    }
    const before = panel.accountRule;
    return act(
      title,
      () => careApi.saveRule(before?.id ?? null, ruleBody('account', panel, { mode: mode as CareAssignmentMode, ...(before ? {} : { agentId: panel.effective.agentId ?? undefined }) })),
      before ? () => careApi.saveRule(before.id, { ...ruleBody('account', panel, { mode: before.mode }), expectedConfigVersion: before.configVersion + 1 }) : undefined,
    );
  }, [act, conversationId]);

  /** Bot picker. `agentId` '' = no bot; '__inherit' (conversation scope) = follow the nick again. */
  const setAgent = useCallback((scope: PanelScope, agentId: string, agentName: string) => {
    const panel = panelRef.current;
    if (!panel) return Promise.resolve();
    const cur = scope === 'account' ? panel.accountRule : panel.conversationRule;
    const title = agentId === '' ? ct('bot.pick.none') : agentId === '__inherit' ? ct('bot.scope.account') : ct('bot.pick.saved', { name: agentName });
    if (agentId === '__inherit') {
      if (!cur) return Promise.resolve();
      return act(title, () => careApi.deleteRule(cur.id, cur.configVersion));
    }
    if (agentId === '') {
      if (!cur) return Promise.resolve();
      return act(title, () => careApi.saveRule(cur.id, ruleBody(scope, panel, { enabled: false })), () => careApi.saveRule(cur.id, { ...ruleBody(scope, panel, { enabled: cur.enabled }), expectedConfigVersion: cur.configVersion + 1 }));
    }
    return act(
      title,
      () => careApi.saveRule(cur?.id ?? null, ruleBody(scope, panel, { agentId, enabled: true })),
      cur ? () => careApi.saveRule(cur.id, { ...ruleBody(scope, panel, { agentId: cur.agentId, enabled: cur.enabled }), expectedConfigVersion: cur.configVersion + 1 }) : undefined,
    );
  }, [act]);

  /** Timed pause (30 phút / 2 giờ / đến khi bật lại). */
  const pause = useCallback((minutes: 30 | 120 | null) => {
    const panel = panelRef.current;
    const what = minutes === 30 ? ct('bot.pause.what30') : minutes === 120 ? ct('bot.pause.what120') : ct('bot.pause.whatOpen');
    const before = panel?.state;
    const restore = (): Promise<unknown> => {
      if (!before?.paused) return careApi.resume(conversationId);
      if (before.pausedUntilMs === null) return careApi.setPause(conversationId, null);
      return careApi.setPause(conversationId, before.pausedUntilMs - Date.now() <= 30 * 60_000 ? 30 : 120);
    };
    return act(ct('bot.toast.pause', { what }), () => careApi.setPause(conversationId, minutes), restore);
  }, [act, conversationId]);

  const resume = useCallback(() => {
    const before = panelRef.current?.state;
    const redo = (): Promise<unknown> => (before?.pausedUntilMs ?? null) === null ? careApi.setPause(conversationId, null) : careApi.setPause(conversationId, (before!.pausedUntilMs! - Date.now()) <= 30 * 60_000 ? 30 : 120);
    return act(ct('bot.toast.resume'), () => careApi.resume(conversationId), before?.paused ? redo : undefined);
  }, [act, conversationId]);

  /** The owner hands a handed-off (or taken-over) conversation back to the bot. Only the owner can: it is the existing take-over switch. */
  const giveBack = useCallback(() => act(ct('bot.toast.giveBack'), () => careApi.setTakeover(conversationId, false), () => careApi.setTakeover(conversationId, true)), [act, conversationId]);

  return { ...state, reload: load, setMode, setAgent, pause, resume, giveBack };
}
