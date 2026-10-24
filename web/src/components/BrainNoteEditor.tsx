import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { apiGet, apiPut, ApiError } from '@/lib/api';
import { renderBrainMarkdown } from '@/lib/markdown';
import { prefillChatDock } from '@/lib/chat-dock';

type Snapshot = { content: string; revision: string };
function errorText(error: unknown): string {
  if (error instanceof ApiError && error.body && typeof error.body === 'object' && 'error' in error.body) return String(error.body.error);
  return 'Không kết nối được máy chủ. Bản đang sửa vẫn được giữ lại.';
}

export function BrainNoteEditor({ path, vault, vaultId, onSaved, noteIds, onNavigate, heading = '' }: { path: string; vault: string; vaultId?: string; onSaved: () => void; noteIds: ReadonlySet<string>; onNavigate: (path: string, heading?: string) => void; heading?: string }) {
  const [base, setBase] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const article = useRef<HTMLElement>(null);
  const storageKey = `claudeclaw.brainDraft.v1:${vaultId || vault}:${path}`;
  const dirty = base !== null && draft !== base.content;
  const html = useMemo(() => renderBrainMarkdown(draft, path, noteIds), [draft, path, noteIds]);
  useEffect(() => {
    if (!base || !heading) return;
    const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, '-');
    const target = [...(article.current?.querySelectorAll('h1,h2,h3,h4,h5,h6') || [])].find(el => normalize(el.textContent || '') === normalize(heading));
    target?.scrollIntoView({ block: 'nearest' });
  }, [base, heading, editing, preview]);

  useEffect(() => {
    let cancelled = false;
    setBase(null); setMessage(''); setFailed(false);
    const url = `/brain/file?folder=${encodeURIComponent(vaultId || '')}&path=${encodeURIComponent(path)}`;
    apiGet<{ content: string; mtimeMs: number }>(url).then(file => {
      const snapshot: Snapshot = { content: file.content, revision: String(file.mtimeMs) };
      if (cancelled) return;
      let restored: Snapshot | null = null;
      try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
        if (saved && typeof saved.content === 'string' && typeof saved.revision === 'string') restored = saved;
      } catch { /* Storage may be disabled. */ }
      if (restored && restored.content !== snapshot.content) {
        setBase({ content: snapshot.content, revision: restored.revision });
        setDraft(restored.content); setEditing(true);
        setMessage(restored.revision === snapshot.revision ? 'Đã khôi phục bản chưa lưu trong tab này.' : 'File đã thay đổi. Bản nháp được giữ lại; sao chép rồi tải lại để đối chiếu.');
      } else { setBase(snapshot); setDraft(snapshot.content); }
    }).catch(error => { if (!cancelled) { setFailed(true); setMessage(errorText(error)); } });
    return () => { cancelled = true; };
  }, [path, storageKey, reload, vaultId]);

  useEffect(() => {
    if (!dirty) return;
    function warn(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = ''; }
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function change(value: string) {
    setDraft(value); setMessage(''); setFailed(false);
    try { sessionStorage.setItem(storageKey, JSON.stringify({ content: value, revision: base?.revision })); }
    catch { setMessage('Trình duyệt không giữ được bản nháp. Hãy lưu trước khi rời trang.'); }
  }
  async function save() {
    if (!base || saving || !dirty) return;
    setSaving(true); setMessage(''); setFailed(false);
    try {
      const payload: { path: string; content: string; revision: string; vault?: string } = { path, content: draft, revision: base.revision };
      if (vaultId && vaultId !== 'all') payload.vault = vaultId;
      const saved = await apiPut<Snapshot>('/brain/file', payload);
      setBase(saved); setDraft(saved.content);
      try { sessionStorage.removeItem(storageKey); } catch {}
      setMessage('Đã lưu vào vault.'); onSaved();
    } catch (error) { setFailed(true); setMessage(errorText(error)); }
    finally { setSaving(false); }
  }
  function discard() {
    if (dirty && !window.confirm('Bỏ bản đang sửa và đọc lại file trong vault?')) return;
    try { sessionStorage.removeItem(storageKey); } catch {}
    setEditing(false); setPreview(false); setReload(n => n + 1);
  }
  function format(before: string, after = '') {
    const el = input.current;
    if (!el || saving) return;
    const start = el.selectionStart, end = el.selectionEnd;
    change(draft.slice(0, start) + before + draft.slice(start, end) + after + draft.slice(end));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + before.length, end + before.length); });
  }
  async function copy() {
    try { await navigator.clipboard.writeText(draft); setMessage('Đã sao chép nội dung.'); }
    catch { setFailed(true); setMessage('Không sao chép được. Chọn nội dung trong ô Markdown để sao chép.'); }
  }
  return <div class="sb-editor">
    <div class="sb-editor-actions">
      <button class="sb-button" disabled={saving} onClick={discard}>Tải lại từ vault</button>
      <button class="sb-button" disabled={!base} onClick={() => void copy()}>Sao chép</button>
      <button class="sb-button" disabled={!base || dirty || saving} title={dirty ? 'Lưu ghi chú trước khi đưa vào chat' : 'Đưa tham chiếu vào ô soạn, chưa gửi'} onClick={() => prefillChatDock(`Đọc ghi chú ${JSON.stringify(path)} trong vault ${JSON.stringify(vault)} bằng công cụ Second Brain trước khi trả lời.\nYêu cầu của tôi: `)}>Hỏi AI về note</button>
      {dirty && <span class="sb-unsaved">Chưa lưu</span>}
    </div>
    {message && <p class="sb-message" role={failed ? 'alert' : 'status'}>{message}</p>}
    {!base ? (!failed && <p class="sb-message" role="status">Đang đọc ghi chú…</p>) : <>
      {editing && !preview ? <>
        <div class="sb-format" role="toolbar" aria-label="Định dạng Markdown">
          <button class="sb-button" onClick={() => format('**', '**')} aria-label="In đậm"><b>B</b></button>
          <button class="sb-button" onClick={() => format('*', '*')} aria-label="In nghiêng"><i>I</i></button>
          <button class="sb-button" onClick={() => format('\n## ')}>H2</button>
          <button class="sb-button" onClick={() => format('\n- ')} aria-label="Danh sách">•</button>
          <button class="sb-button" onClick={() => format('[', '](https://)')}>Liên kết</button>
          <button class="sb-button" onClick={() => format('\n> ')}>Trích dẫn</button>
        </div>
        <textarea ref={input} class="sb-source" aria-label="Nguồn Markdown" value={draft} disabled={saving} spellcheck={false} onInput={e => change(e.currentTarget.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); } }} />
      </> : <article ref={article} class="sb-note-content" onClick={e => {
        const link = (e.target as Element).closest('a');
        if (!link) return;
        const href = link.getAttribute('href') || '';
        if (href.startsWith('#brain-unresolved=')) {
          e.preventDefault(); setMessage(`Chưa tìm thấy ghi chú hoặc có nhiều ghi chú trùng tên: ${decodeURIComponent(href.slice('#brain-unresolved='.length))}. Tìm bằng tên hoặc đường dẫn trong cây thư mục.`); return;
        }
        if (!href.startsWith('/brain?') || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        const params = new URL(href, window.location.origin).searchParams;
        const next = params.get('note');
        if (next) { e.preventDefault(); onNavigate(next, params.get('heading') || ''); }
      }} dangerouslySetInnerHTML={{ __html: html }} />}
    </>}
  </div>;
}
