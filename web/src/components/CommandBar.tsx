// Command bar fixed at the bottom of the app frame (design: ChatBar.dc.html). Picks a bot, takes one line, opens a new
// conversation with that bot, sends the line and moves to /chat/<id>. Pages with their own composer hide it (see AppMain).
import { ArrowRight, ChevronDown, Mic, Paperclip, X } from 'lucide-preact';
import { useRef, useState } from 'preact/hooks';
import { Link, useLocation } from 'wouter-preact';
import { apiPost, errorText } from '@/lib/api';
import { useAgents } from '@/lib/agents';
import { NO_BOT_HINT, usableBots } from '@/lib/bots';
import { createConversation } from '@/lib/chat-conversations';
import { COMMAND_AGENT_KEY, composeMessage, pickAgent, readAttachment } from '@/lib/command-bar';
import type { Attachment } from '@/lib/command-bar';
import { pushToast } from '@/lib/toasts';

function remembered(): string | null {
  try {
    return localStorage.getItem(COMMAND_AGENT_KEY);
  } catch {
    return null;
  }
}

export function CommandBar() {
  const [, nav] = useLocation();
  const { agents, loading } = useAgents();
  const [choice, setChoice] = useState<string | null>(remembered);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  // only GenBot bots that have a key are offered (Open AgenticOS runs every agent on GenBot)
  const bots = usableBots(agents);
  const enabled = bots.filter((a) => a.enabled);
  const agentId = pickAgent(bots, choice);
  const canSend = !sending && agentId !== '' && (text.trim() !== '' || files.length > 0);
  // no bot has a key yet: point at the how-to on Đội AI · Bot instead of failing on send
  const noBot = !loading && enabled.length === 0;

  function pick(id: string) {
    setChoice(id);
    try {
      localStorage.setItem(COMMAND_AGENT_KEY, id);
    } catch {
      /* storage blocked: the choice lasts for this visit */
    }
  }

  async function attach(list: FileList | null) {
    for (const f of Array.from(list ?? [])) {
      try {
        const a = await readAttachment(f);
        setFiles((cur) => (cur.some((x) => x.name === a.name) ? cur : [...cur, a]));
      } catch (e) {
        pushToast({ tone: 'error', title: 'Không đính kèm được', description: errorText(e) });
      }
    }
    if (picker.current) picker.current.value = '';
  }

  async function submit(e: Event) {
    e.preventDefault();
    const content = composeMessage(text, files);
    if (!content || !canSend) return;
    setSending(true);
    try {
      const c = await createConversation(agentId);
      await apiPost(`/conversations/${encodeURIComponent(c.id)}/messages`, { content });
      setText('');
      setFiles([]);
      nav(`/chat/${c.id}`);
    } catch (err) {
      pushToast({ tone: 'error', title: 'Chưa gửi được', description: errorText(err) });
    } finally {
      setSending(false);
    }
  }

  return (
    <form class="cmdbar" aria-label="Ra lệnh cho đội AI" onSubmit={(e) => void submit(e)}>
      <label class="cmdbar-bot">
        <span class="cmdbar-dot" aria-hidden="true" />
        <span class="sr-only">Chọn bot</span>
        <select value={agentId} disabled={enabled.length === 0} onChange={(e) => pick((e.target as HTMLSelectElement).value)} aria-label="Chọn bot">
          {enabled.length === 0 && <option value="">{loading ? 'Đang tải…' : 'Chưa có bot'}</option>}
          {enabled.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <ChevronDown size={14} aria-hidden="true" />
      </label>
      {noBot && <Link href="/bots" class="cmdbar-howto" data-testid="cmdbar-no-bot" title={NO_BOT_HINT}>Nối bot</Link>}
      <button type="button" class="cmdbar-round" disabled title="Nói thay vì gõ: sắp có" aria-label="Nói thay vì gõ (sắp có)">
        <Mic size={20} />
      </button>
      <button type="button" class="cmdbar-square" title="Đính kèm tệp chữ (.txt, .md, .csv, .json)" aria-label="Đính kèm tệp" onClick={() => picker.current?.click()}>
        <Paperclip size={20} />
      </button>
      <input ref={picker} type="file" multiple accept=".txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.log,text/*" class="hidden" onChange={(e) => void attach((e.target as HTMLInputElement).files)} />
      <div class="cmdbar-field">
        {files.length > 0 && (
          <ul class="cmdbar-files" aria-label="Tệp đính kèm">
            {files.map((f) => (
              <li key={f.name}>
                <span class="truncate">{f.name}</span>
                <button type="button" aria-label={`Bỏ ${f.name}`} onClick={() => setFiles((cur) => cur.filter((x) => x.name !== f.name))}><X size={12} /></button>
              </li>
            ))}
          </ul>
        )}
        <input
          type="text"
          class="cmdbar-input"
          aria-label="Bạn muốn đội AI làm gì"
          placeholder={noBot ? 'Chưa có bot GenBot có khoá: nối bot ở Đội AI · Bot' : 'Bạn muốn đội AI làm gì?'}
          value={text}
          disabled={sending}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
        />
      </div>
      <button type="submit" class="cmdbar-send" aria-label="Gửi" disabled={!canSend}>
        <ArrowRight size={20} />
      </button>
    </form>
  );
}
