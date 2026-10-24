import { Bot, Hand, Loader2 } from 'lucide-preact';
import { ct } from '@modules/care/web/lib/care/i18n';
import type { CareAiMode, CareConversationWorkflowDto } from '@modules/care/web/lib/care/dto';
import { aiHintKey } from '@modules/care/web/lib/care/inboxView';
import { agentName, type AgentLite } from '@modules/care/web/lib/care/useInboxExtras';

const MODES: CareAiMode[] = ['off', 'draft', 'auto'];

/**
 * AI bar under the conversation header: the agent, a Tắt · Soạn nháp · Tự gửi switch, a hint, and take-over / hand back.
 * Everything is disabled with its reason when the channel has no AI (Telegram) or while the owner has taken over.
 */
export function AiBar({ workflow, agents, isEmail, busy, draftBusy, onMode, onTakeover, onRequestDraft }: {
  workflow: CareConversationWorkflowDto;
  agents: AgentLite[];
  isEmail: boolean;
  busy: boolean;
  draftBusy: boolean;
  onMode: (mode: CareAiMode) => void;
  onTakeover: (on: boolean) => void;
  onRequestDraft: () => void;
}) {
  const ai = workflow.ai;
  const supported = ai.supported;
  const modeLocked = !supported || ai.takenOver || !ai.agentId || busy;
  const noteKey = ai.note ? `inbox2.ai.note.${ai.note}` : null;
  const noteText = noteKey && ct(noteKey) !== noteKey ? ct(noteKey) : null;
  // Unsupported: the server's reason replaces the generic line; otherwise it is appended (paused until, opted out...).
  const hint = !supported && noteText ? noteText : ct(aiHintKey(workflow));
  const note = supported ? noteText : null;
  return (
    <>
      <div class="care-aibar" data-testid="care-aibar">
        <span class="care-aibar-agent">
          <Bot size={14} aria-hidden="true" />
          {supported && ai.agentId ? <>AI <b>{agentName(agents, ai.agentId)}</b></> : <span>{ct('inbox2.ai.title')}</span>}
        </span>
        <div class="care-seg" role="radiogroup" aria-label={ct('inbox2.ai.modeLabel')}>
          {MODES.map((m) => {
            const on = !ai.takenOver && supported && ai.mode === m;
            return (
              <button key={m} type="button" role="radio" aria-checked={on} disabled={modeLocked} class={`care-seg-btn${on ? ' is-on' : ''}`} data-testid={`care-ai-${m}`} onClick={() => { if (!on) onMode(m); }}>
                {ct(`inbox2.ai.mode.${m}`)}
              </button>
            );
          })}
        </div>
        {supported && ai.agentId && !ai.takenOver && ai.mode !== 'off' && (
          <button type="button" class="care-ctl is-small" disabled={draftBusy} onClick={onRequestDraft} data-testid="care-request-draft">
            {draftBusy ? <Loader2 size={12} class="animate-spin" aria-hidden="true" /> : <Bot size={12} aria-hidden="true" />} {ct('inbox2.ai.requestDraft')}
          </button>
        )}
        {supported && (
          <button type="button" class={`care-take${ai.takenOver ? ' is-back' : ''}`} disabled={busy} onClick={() => onTakeover(!ai.takenOver)} data-testid="care-takeover">
            <Hand size={13} aria-hidden="true" /> {ai.takenOver ? ct('inbox2.ai.giveBack') : ct('inbox2.ai.takeOver')}
          </button>
        )}
        <span class="care-aibar-hint" data-testid="care-ai-hint">
          {hint}
          {note ? ` ${note}` : ''}
          {isEmail && supported && ai.agentId && !ai.takenOver ? ` ${ct('inbox2.ai.emailScope')}` : ''}
        </span>
      </div>
      {ai.takenOver && supported && (
        <div class="care-takeover-banner" role="status" data-testid="care-takeover-banner">{ct('inbox2.ai.takeoverBanner')}</div>
      )}
    </>
  );
}
