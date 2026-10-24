// Conversation with the director agent: bubbles, live streaming text, activity, inline cards.
import { useEffect, useRef } from 'preact/hooks';
import { ChevronRight } from 'lucide-preact';
import { formatDurationMs, readableOn } from '@modules/video/web/lib/video-edit/format';
import {
  agentById, liveActivity, messages, project, streamText,
} from '@modules/video/web/lib/video-edit/studio';
import type { VideoMessage } from '@modules/video/web/lib/video-edit/types';
import { PlanCard, ResultCard, SourceVideoCard } from './cards';
import { ApprovalCard } from './studio/ApprovalCard';
import { activitySteps } from '@modules/video/web/lib/video-production';
import { renderMarkdown } from '@/lib/markdown';

export function ChatThread() {
  const p = project.value;
  const list = messages.value;
  const live = streamText.value;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const liveOnly = Object.keys(live).filter((id) => !list.some((m) => m.id === id));
  const busy = !!p?.busy;
  const showTyping = busy && liveOnly.length === 0 && !list.some((m) => m.role === 'agent' && live[m.id] !== undefined);
  const tick = list.length + liveOnly.length + Object.values(live).reduce((a, t) => a + t.length, 0) + (showTyping ? 1 : 0) + (p?.plan ? 1 : 0) + (p?.outputs.final ? 1 : 0);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [tick, p?.id]);
  useEffect(() => { stick.current = true; }, [p?.id]);

  if (!p) return null;
  const agent = agentById(p.agentId);
  const agentName = agent?.name ?? p.agentId;

  return (
    <div
      class="vs-thread"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
      }}
    >
      <div class="vs-thread-inner">
        {p.source && <SourceVideoCard project={p} />}
        {list.map((m) => <MessageRow key={m.id} m={m} agentName={agentName} text={live[m.id] ?? m.text} streaming={busy && live[m.id] !== undefined} />)}
        {liveOnly.map((id) => (
          <MessageRow
            key={id}
            m={{ id, projectId: p.id, role: 'agent', text: '', createdAt: p.updatedAt }}
            agentName={agentName}
            text={live[id]}
            streaming={busy}
          />
        ))}
        {showTyping && <Typing agentName={agentName} />}
        {p.plan && <PlanCard project={p} plan={p.plan} />}
        {p.outputs.final && <ResultCard project={p} />}
      </div>
    </div>
  );
}

function Typing({ agentName }: { agentName: string }) {
  return (
    <div class="vs-msg vs-msg-agent" role="status" aria-label={`${agentName} đang trả lời`}>
      <Avatar name={agentName} />
      <div class="vs-msg-col">
        <div class="vs-msg-who">{agentName}</div>
        <div class="vs-bubble vs-bubble-agent"><span class="vs-typing" aria-hidden="true"><i /><i /><i /></span></div>
      </div>
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  const initials = name.trim().slice(0, 2).toLocaleUpperCase('vi-VN') || 'AI';
  return <span class="vs-avatar" style={{ color: readableOn('#8b8af0') }} aria-hidden="true">{initials}</span>;
}

function MessageRow({ m, agentName, text, streaming }: { m: VideoMessage; agentName: string; text: string; streaming: boolean }) {
  if (m.role === 'system') {
    return (
      <div class="vs-msg-system">
        {m.text}
        {m.card?.type === 'generate_approval' && <div class="vs-msg-card"><ApprovalCard approvalId={m.card.approvalId} /></div>}
      </div>
    );
  }
  if (m.role === 'user') {
    return (
      <div class="vs-msg vs-msg-user">
        <div class="vs-msg-col">
          {m.attachments && m.attachments.length > 0 && (
            <div class="vs-attach-row vs-attach-row-msg">
              {m.attachments.map((a) => (
                <span key={`${a.kind}:${a.ref}`} class="vs-attach">
                  <span class="vs-attach-kind">{a.kind === 'video' ? 'VIDEO' : 'KHO'}</span>
                  <span class="vs-attach-name">{a.label}</span>
                </span>
              ))}
            </div>
          )}
          <div class="vs-bubble vs-bubble-user">{m.text}</div>
        </div>
      </div>
    );
  }
  const activity = activitySteps([...(m.activity ?? []), ...((liveActivity.value[m.id] ?? []).filter((a) => !(m.activity ?? []).some((b) => b.label === a.label && b.detail === a.detail)))]);
  return (
    <div class="vs-msg vs-msg-agent">
      <Avatar name={agentName} />
      <div class="vs-msg-col">
        <div class="vs-msg-who">{agentName}</div>
        <div class={`vs-bubble vs-bubble-agent${m.error ? ' is-error' : ''}`} role={streaming ? 'status' : undefined}>
          {text ? <div class="vs-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} /> : (streaming ? <span class="vs-typing" aria-label="Đang trả lời"><i /><i /><i /></span> : '')}
          {streaming && text && <span class="vs-caret" aria-hidden="true" />}
        </div>
        {activity.length > 0 && (
          <details class="vs-activity">
            <summary><ChevronRight size={13} aria-hidden="true" /> {activity.length} bước</summary>
            <ul>
              {activity.map((a, i) => (
                <li key={i} class={a.done ? 'is-done' : undefined}><span>{a.done ? '✓ ' : ''}{a.label}</span>{a.detail && <span class="vs-faint"> · {a.detail}</span>}</li>
              ))}
            </ul>
          </details>
        )}
        {m.durationMs !== undefined && !streaming && <div class="vs-msg-meta">Xong trong {formatDurationMs(m.durationMs)}</div>}
      </div>
    </div>
  );
}
