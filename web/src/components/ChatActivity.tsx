import { useEffect, useState } from 'preact/hooks';
import {
  Lightbulb, ChevronRight, Box, Brain, Bot, Terminal, FilePen, FileText, Search, ListChecks, Info, CircleCheck, CircleAlert,
} from 'lucide-preact';
import { renderMarkdown } from '@/lib/markdown';
import { t } from '@/lib/i18n';
import {
  formatThoughtDuration, splitReply,
  type LiveTurn, type TurnActivity, type TurnActivityGroup, type TurnActivityStep,
} from '@/lib/chat-activity';

// "Thought for 3s ›" rows between reply paragraphs, each expanding into the
// tool calls the agent made at that point, plus the live "Thinking • 3s"
// row while a turn runs.

function stepIcon(step: TurnActivityStep) {
  if (step.status === 'failed') return CircleAlert;
  switch (step.kind) {
    case 'mcp': return Box;
    case 'search': return Search;
    case 'edit': return FilePen;
    case 'read': return FileText;
    case 'execute': return Terminal;
    case 'subagent': return Bot;
    case 'plan': return ListChecks;
    case 'compact': return Info;
    default: return Brain;
  }
}

/** MCP labels arrive as "server: tool name"; show them as "Called tool". */
function StepLabel({ step }: { step: TurnActivityStep }) {
  if (step.kind === 'mcp') {
    const sep = step.label.indexOf(': ');
    const server = sep > 0 ? step.label.slice(0, sep) : '';
    const tool = sep > 0 ? step.label.slice(sep + 2) : step.label;
    return (
      <>
        {t('chat.called')} <span class="chat-activity-tool">{tool}</span>
        {server && <span class="chat-activity-faint"> · {server}</span>}
      </>
    );
  }
  return <>{step.label}</>;
}

function StepList({ steps, done }: { steps: TurnActivityStep[]; done: boolean }) {
  return (
    <ol class="chat-activity-steps">
      {steps.map((step) => {
        const Icon = stepIcon(step);
        const running = !done && !step.status;
        return (
          <li key={step.id} class={`chat-activity-step ${step.status === 'failed' ? 'is-failed' : ''} ${running ? 'is-running' : ''}`}>
            <span class="chat-activity-step-icon"><Icon size={13} /></span>
            <span class="chat-activity-step-label"><StepLabel step={step} /></span>
          </li>
        );
      })}
      {done && (
        <li class="chat-activity-step is-done">
          <span class="chat-activity-step-icon"><CircleCheck size={13} /></span>
          <span class="chat-activity-step-label">{t('chat.done')}</span>
        </li>
      )}
    </ol>
  );
}

export function ThoughtGroup({ group }: { group: TurnActivityGroup }) {
  const [open, setOpen] = useState(false);
  const label = t('chat.thoughtFor', { time: formatThoughtDuration(group.durationMs) });
  if (group.steps.length === 0) {
    return (
      <div class="chat-activity">
        <div class="chat-activity-head is-static"><Lightbulb size={13} /><span>{label}</span></div>
      </div>
    );
  }
  return (
    <div class="chat-activity">
      <button type="button" class="chat-activity-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Lightbulb size={13} />
        <span>{label}</span>
        <ChevronRight size={13} class={`chat-activity-chevron ${open ? 'is-open' : ''}`} />
      </button>
      {open && <StepList steps={group.steps} done />}
    </div>
  );
}

function MarkdownChunk({ text }: { text: string }) {
  return <div class="chat-message-content chat-md chat-reply-chunk" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

/** An assistant reply with its thought groups interleaved. */
export function ReplyWithActivity({ content, activity }: { content: string; activity?: TurnActivity }) {
  const segments = splitReply(content, activity);
  return (
    <>
      {segments.map((seg, i) => seg.type === 'text'
        ? <MarkdownChunk key={`t${i}`} text={seg.text} />
        : <ThoughtGroup key={`g${i}`} group={seg.group} />)}
    </>
  );
}

/** Seconds since `since`, re-rendering once a second. */
function useElapsed(since: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return Math.max(0, now - since);
}

function DotGrid() {
  return (
    <span class="chat-thinking-dots" aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => <span key={i} style={{ animationDelay: `${(i % 3) * 120 + Math.floor(i / 3) * 90}ms` }} />)}
    </span>
  );
}

/** The bottom row of a running turn: "Thinking • 3s ›", expanding into the
 *  steps of the current (not yet answered) stretch of work. */
function LiveThinking({ turn }: { turn: LiveTurn }) {
  const [open, setOpen] = useState(false);
  const steps = turn.current?.steps ?? [];
  const since = turn.current ? turn.startedAt + turn.current.startMs : turn.lastTextAt;
  const elapsed = useElapsed(since);
  const latest = steps[steps.length - 1];
  const head = (
    <>
      <DotGrid />
      <span class="chat-thinking-label">{t('chat.thinkingNow')}</span>
      <span class="chat-activity-faint">• {formatThoughtDuration(elapsed)}</span>
      {steps.length > 0 && <ChevronRight size={13} class={`chat-activity-chevron ${open ? 'is-open' : ''}`} />}
      {!open && latest && <span class="chat-activity-latest"><StepLabel step={latest} /></span>}
    </>
  );
  return (
    <div class="chat-activity chat-activity-live" role="status">
      {steps.length > 0
        ? <button type="button" class="chat-activity-head" aria-expanded={open} onClick={() => setOpen(!open)}>{head}</button>
        : <div class="chat-activity-head is-static">{head}</div>}
      {open && steps.length > 0 && <StepList steps={steps} done={false} />}
    </div>
  );
}

/** A turn in flight: the reply streamed so far, its finished thought
 *  groups, and the live thinking row. */
export function LiveTurnView({ turn, compact = false }: { turn: LiveTurn; compact?: boolean }) {
  const activity: TurnActivity = { v: 1, durationMs: 0, groups: turn.groups };
  return (
    <div class={`chat-message chat-message-agent chat-message-flat ${compact ? 'chat-message-compact' : ''}`}>
      <div class="chat-message-body">
        <div class="chat-reply">
          <ReplyWithActivity content={turn.text} activity={activity} />
          <LiveThinking turn={turn} />
        </div>
      </div>
    </div>
  );
}
