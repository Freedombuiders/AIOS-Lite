/** Đạo diễn AI: the director agent's chat for one video (host project), with @KOL mentions and quick commands. */
import { useEffect, useState } from 'preact/hooks';
import { ArrowUp, ChevronUp, Sparkles, Square } from 'lucide-preact';

import { abortTurn, agentById, bootstrap, messages, openProjectStream, project, selectProject, selectedProjectId, sendMessage } from '@modules/video/web/lib/video-edit/studio';
import type { CastMember, Production } from '@modules/video/web/lib/video-production';
import { ChatThread } from '../ChatThread';
import { MentionComposer } from '../production/MentionComposer';
import { useMedia } from './useMedia';

let booted: Promise<void> | null = null;
export function ensureStudioBoot(): Promise<void> {
  booted ??= bootstrap().catch(() => { booted = null; });
  return booted;
}

/** Keeps the shared studio signals (chat, plan, editor) on the host project of the open video. */
export function useHostProject(hostId: string | null) {
  useEffect(() => {
    if (!hostId) return;
    let stop: (() => void) | undefined;
    let alive = true;
    void ensureStudioBoot().then(async () => {
      if (!alive) return;
      if (selectedProjectId.value !== hostId) await selectProject(hostId);
      if (alive) stop = openProjectStream(hostId);
    });
    return () => { alive = false; stop?.(); };
  }, [hostId]);
}

function quickCommands(p: Production): string[] {
  if (p.state === 'brief') return ['Lên kịch bản và phân cảnh giúp tôi'];
  if (p.state === 'storyboard' || p.state === 'failed') {
    return [
      'Viết lại hook 3 giây đầu mạnh hơn',
      `Rút video còn ${Math.max(15, Math.round(p.targetSec * 0.7))} giây`,
      'Thay B-roll bằng cảnh quay thật miễn phí nếu được',
      p.pendingApproval ? 'Giải thích chi phí lô đang chờ duyệt' : 'Xin duyệt và tạo các cảnh',
    ];
  }
  if (p.state === 'generating') return ['Tiến độ các cảnh thế nào?'];
  if (p.state === 'ready') return ['Hoàn thiện video với HyperFrames', 'Tạo lại cảnh chưa ưng'];
  return ['Phụ đề to và nổi bật hơn', 'Thêm nhạc nền nhẹ', 'Đề xuất 3 hook khác'];
}

export function DirectorPanel({ p, cast }: { p: Production; cast: CastMember[] }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [open, setOpen] = useState(false); // phone: bottom sheet
  const phone = useMedia('(max-width: 980px)');
  const collapsed = phone && !open;
  const host = project.value?.id === p.projectId ? project.value : null;
  const busy = Boolean(host?.busy);
  const agent = host ? agentById(host.agentId) : undefined;
  const castHere = cast.filter((c) => p.cast.includes(c.id));

  async function send(message: string) {
    const clean = message.trim();
    if (!clean || busy || sending || !host) return;
    setSending(true);
    try { if (await sendMessage(clean)) setText(''); } finally { setSending(false); }
  }

  return (
    <aside class={`vx-director${open ? ' is-open' : ''}`} aria-label="Đạo diễn AI">
      <header
        class="vx-director-head"
        {...(phone ? {
          role: 'button', tabIndex: 0, 'aria-expanded': open, 'aria-label': open ? 'Thu gọn Đạo diễn AI' : 'Mở Đạo diễn AI',
          onClick: () => setOpen(!open),
          onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); } },
        } : {})}
      >
        <span class="vx-director-mark"><Sparkles size={15} /></span>
        <span class="min-w-0">
          <b>Đạo diễn AI</b>
          <small>{busy ? 'Đang làm việc…' : agent ? `${agent.name} · ${agent.engineLabel} · sẵn sàng` : 'Sẵn sàng'}</small>
        </span>
        <span class={`vp-dot ${busy ? 'is-busy' : 'is-on'}`} />
        <span class="vx-director-chevron" aria-hidden="true"><ChevronUp size={16} /></span>
      </header>
      <div class="vx-director-thread vs-root" {...(collapsed ? { inert: true } : {})}>
        {!host && <p class="vp-faint" style={{ padding: '16px' }}>Đang mở hội thoại…</p>}
        {host && messages.value.length === 0 && !busy && (
          <div class="vx-director-empty">
            <span class="vx-director-mark"><Sparkles size={15} /></span>
            <b>Ra lệnh bằng lời, Đạo diễn AI làm bằng công cụ</b>
            <p>Sửa kịch bản, đổi cảnh, chọn công cụ, ước tính chi phí, hoàn thiện với HyperFrames. Mọi khoản tốn tiền đều chờ bạn duyệt một lần.</p>
          </div>
        )}
        {host && <ChatThread />}
      </div>
      <div class="vx-director-compose" {...(collapsed ? { inert: true } : {})}>
        <div class="vx-quick" aria-label="Lệnh nhanh">
          {quickCommands(p).map((q) => (
            <button key={q} type="button" class="vp-chip" disabled={busy || sending || !host} onClick={() => void send(q)}>{q}</button>
          ))}
        </div>
        <div class="vp-composer vx-composer">
          <MentionComposer
            value={text}
            onInput={setText}
            cast={castHere.length ? castHere : cast}
            placeholder={busy ? 'Đạo diễn AI đang làm việc…' : 'Ra lệnh cho Đạo diễn AI… (gõ @ để gọi KOL)'}
            onSubmit={() => void send(text)}
            submitOnEnter
          />
          <div class="vp-composer-bar">
            <span class="vp-faint" style={{ fontSize: '11px' }}>Enter gửi · Shift+Enter xuống dòng · @ gọi KOL</span>
            <span class="vp-spacer" />
            {busy ? (
              <button type="button" class="vx-send is-stop" aria-label="Dừng Đạo diễn AI" onClick={() => void abortTurn()}><Square size={13} fill="currentColor" /></button>
            ) : (
              <button type="button" class="vx-send" aria-label="Gửi" disabled={!text.trim() || sending || !host} onClick={() => void send(text)}><ArrowUp size={16} /></button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
