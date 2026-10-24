import { Check, ChevronDown } from 'lucide-preact';
import { PopoverMenu } from './PopoverMenu';
import { ct } from '@modules/care/web/lib/care/i18n';
import type { AssigneeChoice } from '@modules/care/web/lib/care/client';
import type { CareConversationWorkflowDto } from '@modules/care/web/lib/care/dto';
import { agentName, type AgentLite } from '@modules/care/web/lib/care/useInboxExtras';

/** What the current assignee is called in the button. */
export function assigneeLabel(w: CareConversationWorkflowDto, agents: AgentLite[]): string {
  const a = w.assignee;
  const base = a.kind === 'owner'
    ? ct('inbox2.assignee.me')
    : a.kind === 'agent'
      ? ct('inbox2.assignee.agent', { name: agentName(agents, a.agentId ?? w.ai.agentId) })
      : ct('inbox2.assignee.none');
  return a.source === 'rule' ? ct('inbox2.assignee.byRule', { label: base }) : base;
}

/** Phụ trách: Bạn / each agent / Chưa giao / Theo quy tắc. Picking applies at once and closes the menu. */
export function AssigneeMenu({ workflow, agents, isEmail, busy, onPick }: {
  workflow: CareConversationWorkflowDto;
  agents: AgentLite[];
  isEmail: boolean;
  busy: boolean;
  onPick: (choice: AssigneeChoice) => void;
}) {
  const a = workflow.assignee;
  const bySource = a.source === 'conversation';
  const isCurrent = (kind: AssigneeChoice['kind'], agentId?: string): boolean => {
    if (kind === 'default') return !bySource;
    return bySource && a.kind === kind && (kind !== 'agent' || a.agentId === agentId);
  };
  const aiOk = workflow.ai.supported;
  return (
    <PopoverMenu
      label={ct('inbox2.assignee.label')}
      className="care-ctl"
      testId="care-assignee"
      disabled={busy}
      menuLabel={ct('inbox2.assignee.menu')}
      content={<><span class="care-ctl-dim">{ct('inbox2.assignee.prefix')}</span> {assigneeLabel(workflow, agents)} <ChevronDown size={12} aria-hidden="true" /></>}
    >
      {(close) => {
        const item = (key: string, kind: AssigneeChoice['kind'], label: string, hint: string, choice: AssigneeChoice, agentId?: string) => {
          const on = isCurrent(kind, agentId);
          return (
            <button key={key} type="button" role="menuitemradio" aria-checked={on} class="care-menu-item" data-testid={`care-assignee-${key}`} onClick={() => { close(); if (!on) onPick(choice); }}>
              <span class="care-menu-label">{label}{on && <Check size={12} aria-hidden="true" />}</span>
              <span class="care-menu-hint">{hint}</span>
            </button>
          );
        };
        return (
          <>
            {item('owner', 'owner', ct('inbox2.assignee.me'), ct('inbox2.assignee.meHint'), { kind: 'owner' })}
            {aiOk && agents.map((ag) => item(`agent-${ag.id}`, 'agent', ct('inbox2.assignee.agent', { name: ag.name }), ct('inbox2.assignee.agentHint'), { kind: 'agent', agentId: ag.id }, ag.id))}
            {!aiOk && <span class="care-menu-note">{ct('inbox2.assignee.noAi')}</span>}
            {item('none', 'none', ct('inbox2.assignee.none'), ct('inbox2.assignee.noneHint'), { kind: 'none' })}
            {item('default', 'default', ct('inbox2.assignee.default'), ct('inbox2.assignee.defaultHint'), { kind: 'default' })}
            {isEmail && <span class="care-menu-note" data-testid="care-assignee-email-note">{ct('inbox2.assignee.emailScope')}</span>}
          </>
        );
      }}
    </PopoverMenu>
  );
}
