import { Bot, Hand, Loader2, Play } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import type { CareBotPanelDto } from '@modules/care/server/api/dto-inbox';
import type { CareRunDto } from '@modules/care/server/api/dto-ops';
import {
  currentMode, handoffText, modeLabel, modeNote, modesFor, PAUSE_CHOICES, pauseText, ruleLines, runLine, runTime, stateChip, yieldText,
  type AnyMode, type PanelScope,
} from '@modules/care/web/lib/care/botView';
import type { CareAccountDto, CareConversationDto } from '@modules/care/web/lib/care/dto';
import { ct } from '@modules/care/web/lib/care/i18n';
import { botAgents, type AgentLite } from '@modules/care/web/lib/care/useInboxExtras';
import { defaultScope, useBotPanel } from '@modules/care/web/lib/care/useBotPanel';

/** "Chuyển cho bạn": the customer asked for a person. Only the owner hands the chat back. */
export function HandoffBanner({ handoff, busy, onGiveBack }: { handoff: NonNullable<CareBotPanelDto['state']['handoff']>; busy: boolean; onGiveBack: () => void }) {
  return (
    <div class="care-handoff" role="alert" data-testid="care-handoff-banner">
      <span class="care-handoff-title"><Hand size={14} aria-hidden="true" /> {ct('bot.handoff.title')}</span>
      <p>{handoffText(handoff)}</p>
      <button type="button" class="cc-button is-primary" disabled={busy} onClick={onGiveBack} data-testid="care-handoff-giveback">
        {busy ? <Loader2 size={13} class="animate-spin" aria-hidden="true" /> : <Bot size={13} aria-hidden="true" />} {ct('bot.handoff.give')}
      </button>
    </div>
  );
}

/** "Bot đã làm gì ở đây": the agent runs of this chat, every skip reason in words. */
export function RunLog({ runs }: { runs: CareRunDto[] }) {
  return (
    <section class="care-botsec" aria-labelledby="care-bot-log" data-testid="care-run-log">
      <h2 id="care-bot-log">{ct('bot.log.title')}</h2>
      {runs.length === 0 && <p class="care-faint">{ct('bot.log.empty')}</p>}
      <ul class="care-runlist">
        {runs.map((r) => {
          const line = runLine(r);
          return (
            <li key={r.id} data-status={r.status} data-skip-reason={r.skipReason ?? undefined}>
              <span class="care-run-at">{runTime(r)}</span>
              <span class={`care-run-text is-${line.tone}`}>{line.text}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function effectiveLine(panel: CareBotPanelDto, agents: AgentLite[]): string {
  const e = panel.effective;
  if (e.outcome === 'active' && e.mode && e.agentId) {
    const name = agents.find((a) => a.id === e.agentId)?.name ?? e.agentId;
    const tier = ct(`bot.effective.tier.${e.tier ?? 'global'}`);
    return `${ct('bot.effective.active', { mode: modeLabel(e.mode), agent: name })} (${tier})`;
  }
  return ct(`bot.effective.${e.outcome}`);
}

export interface BotPanelViewProps {
  conversationId: string;
  panel: CareBotPanelDto;
  runs: CareRunDto[];
  agents: AgentLite[];
  nickLabel: string;
  busy: boolean;
  onMode: (scope: PanelScope, mode: AnyMode) => void;
  onAgent: (scope: PanelScope, agentId: string, agentName: string) => void;
  onPause: (minutes: 30 | 120 | null) => void;
  onResume: () => void;
  onGiveBack: () => void;
}

/** The right column for a direct chat (a group gets `GroupNotice` instead). Pure view: every change goes through the handlers. */
export function BotPanelView({ conversationId, panel, runs, agents, nickLabel, busy, onMode, onAgent, onPause, onResume, onGiveBack }: BotPanelViewProps) {
  const [scope, setScope] = useState<PanelScope>(() => defaultScope(panel));
  // A conversation switch resets the scope; a reload of the same one keeps what the owner picked.
  useEffect(() => { setScope(defaultScope(panel)); }, [conversationId]);

  const bots = botAgents(agents);
  const rule = scope === 'account' ? panel.accountRule : panel.conversationRule;
  const agentValue = scope === 'account' ? (rule && rule.enabled ? rule.agentId : '') : !rule ? '__inherit' : rule.enabled ? rule.agentId : '';
  // A rule may name an agent that is no longer a valid bot: keep it visible instead of silently showing "no bot".
  const known = bots.some((a) => a.id === agentValue);
  const state = panel.state;
  const chip = stateChip(state.label);
  const mode = currentMode(scope, panel);
  const modes = modesFor(scope);
  const shownMode: AnyMode | null = mode ?? (scope === 'conversation' ? 'auto' : null);
  const lines = ruleLines(panel);
  const yielded = yieldText(state, panel.rules.humanPauseMinutes);
  const paused = pauseText(state);

  return (
    <aside class="care-bot" aria-label={ct('bot.title')} data-testid="care-bot-panel" data-bot-state={state.label}>
      {state.handoff && <HandoffBanner handoff={state.handoff} busy={busy} onGiveBack={onGiveBack} />}

      <section class="care-botcard" aria-labelledby="care-bot-title">
        <div class="care-botcard-head">
          <h2 id="care-bot-title">{ct('bot.title')}</h2>
          {chip && <span class={`care-chip care-state is-state-${chip.tone}`} data-testid="care-bot-state">{chip.text}</span>}
        </div>

        <label class="care-botfield">
          <span>{ct('bot.pick.label')}</span>
          <select
            value={agentValue}
            disabled={busy}
            data-testid="care-bot-agent"
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              onAgent(scope, v, bots.find((a) => a.id === v)?.name ?? v);
            }}
          >
            {scope === 'conversation' && <option value="__inherit">{ct('bot.scope.account')}</option>}
            {bots.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            {agentValue !== '' && agentValue !== '__inherit' && !known && <option value={agentValue}>{agentValue}</option>}
            <option value="">{ct('bot.pick.none')}</option>
          </select>
        </label>
        {bots.length === 0 && (
          <p class="care-faint" data-testid="care-bot-noagents">{ct('bot.pick.noAgents')} <Link href="/agents">{ct('bot.pick.manage')}</Link></p>
        )}

        <div class="care-seg3 is-two" role="group" aria-label={ct('bot.scope.label')}>
          {(['account', 'conversation'] as const).map((s) => (
            <button key={s} type="button" aria-pressed={scope === s} class={scope === s ? 'is-on' : ''} data-testid={`care-bot-scope-${s}`} onClick={() => setScope(s)}>
              {s === 'account' ? ct('bot.scope.account') : ct('bot.scope.conversation')}
            </button>
          ))}
        </div>
        <p class="care-botnote" data-testid="care-bot-scope-note">
          {scope === 'account' ? ct('bot.scope.accountNote', { nick: nickLabel || ct('bot.scope.noNick') }) : panel.conversationRule || panel.aiMode ? ct('bot.scope.conversationNote') : ct('bot.scope.accountNote', { nick: nickLabel || ct('bot.scope.noNick') })}
        </p>

        <div class="care-seg3 is-modes" role="group" aria-label={ct('bot.mode.label')} data-testid="care-bot-modes">
          {modes.map((m) => (
            <button key={m} type="button" aria-pressed={shownMode === m} class={shownMode === m ? 'is-on' : ''} disabled={busy} data-testid={`care-bot-mode-${m}`} data-scope={scope} onClick={() => { if (shownMode !== m) onMode(scope, m); }}>
              {modeLabel(m)}
            </button>
          ))}
        </div>
        {shownMode && <p class="care-botnote" data-testid="care-bot-mode-note">{modeNote(scope, shownMode)}</p>}
        <p class="care-botnote is-effective" data-testid="care-bot-effective">{effectiveLine(panel, agents)}</p>
        {yielded && <p class="care-botnote is-yield" data-testid="care-bot-yield">{yielded}</p>}

        <div class="care-pauses" role="group" aria-label={ct('bot.pause.title')}>
          {PAUSE_CHOICES.map((c) => (
            <button key={c.key} type="button" class="cc-button" disabled={busy} data-testid={`care-pause-${c.minutes ?? 'open'}`} onClick={() => onPause(c.minutes)}>
              {ct(c.key)}
            </button>
          ))}
          {paused && (
            <button type="button" class="cc-button is-primary" disabled={busy} data-testid="care-pause-resume" onClick={onResume}>
              <Play size={12} aria-hidden="true" /> {ct('bot.pause.resume')}
            </button>
          )}
        </div>
        {paused && <p class="care-botnote is-yield" data-testid="care-pause-status">{paused}</p>}
      </section>

      <section class="care-botsec" aria-labelledby="care-bot-rules" data-testid="care-bot-rules">
        <h2 id="care-bot-rules">{ct('bot.rules.title')}</h2>
        <ul class="care-rulelist">
          {lines.map((l) => <li key={l.id} class={l.tone === 'warn' ? 'is-warn' : ''} data-rule={l.id}>{l.text}</li>)}
        </ul>
        <Link href="/m/care/rules" class="care-inline-link">{ct('bot.rules.manage')}</Link>
      </section>

      <RunLog runs={runs} />
    </aside>
  );
}

/** A group: history only, the bot never answers there. */
export function GroupNotice() {
  return (
    <aside class="care-bot is-group" aria-label={ct('bot.title')} data-testid="care-bot-group">
      <section class="care-botcard">
        <h2>{ct('bot.group.only')}</h2>
        <p class="care-botnote">{ct('bot.group.note')}</p>
      </section>
    </aside>
  );
}

/** Right column of the inbox: loads the panel of the open conversation and wires the owner's changes. A group shows only its notice. */
export function BotPanel({ conversationId, accounts, agents, convTick, resyncTick, onConversation }: {
  conversationId: string;
  accounts: CareAccountDto[];
  agents: AgentLite[];
  convTick: number;
  resyncTick: number;
  onConversation: (c: CareConversationDto) => void;
}) {
  const bot = useBotPanel(conversationId, convTick, resyncTick, onConversation);
  if (!bot.panel) {
    return (
      <aside class="care-bot" aria-label={ct('bot.title')} data-testid="care-bot-panel">
        <p class="care-faint care-botnote">{bot.loading ? ct('list.loadingMore') : bot.error ?? ''}</p>
      </aside>
    );
  }
  if (bot.panel.kind === 'group' || bot.panel.kind === 'topic') return <GroupNotice />;
  return (
    <BotPanelView
      conversationId={conversationId}
      panel={bot.panel}
      runs={bot.runs}
      agents={agents}
      nickLabel={accounts.find((a) => a.id === bot.panel!.accountId)?.label ?? ''}
      busy={bot.busy}
      onMode={(scope, mode) => void bot.setMode(scope, mode)}
      onAgent={(scope, id, name) => void bot.setAgent(scope, id, name)}
      onPause={(m) => void bot.pause(m)}
      onResume={() => void bot.resume()}
      onGiveBack={() => void bot.giveBack()}
    />
  );
}
