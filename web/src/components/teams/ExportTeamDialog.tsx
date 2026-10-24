import { useState } from 'preact/hooks';
import { Modal } from '@/components/Modal';
import { Field } from '@/components/ui';
import { apiPost, errorText } from '@/lib/api';
import { useAgents } from '@/lib/agents';
import { downloadBase64 } from '@/lib/teams';
import { pushToast } from '@/lib/toasts';

interface ExportReply { filename: string; base64: string; files: string[]; redactions: number; inputs: string[] }

export function ExportTeamDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { agents } = useAgents();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<ExportReply | null>(null);

  const toggle = (id: string) => {
    const next = new Set(picked);
    if (!next.delete(id)) next.add(id);
    setPicked(next);
  };

  async function run() {
    if (!name.trim()) return setErr('Nhập tên gói.');
    if (picked.size === 0) return setErr('Chọn ít nhất một agent.');
    setBusy(true);
    setErr(null);
    try {
      const r = await apiPost<ExportReply>('/teams/export', { name: name.trim(), agentIds: [...picked] });
      downloadBase64(r.filename, r.base64);
      setDone(r);
      pushToast({ tone: 'success', title: `Đã xuất ${r.filename}` });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setDone(null);
    setErr(null);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Xuất gói team"
      width={560}
      closeDisabled={busy}
      footer={done ? <button type="button" class="control-button control-accent" onClick={close}>Xong</button> : (
        <>
          <button type="button" class="control-button" disabled={busy} onClick={close}>Huỷ</button>
          <button type="button" class="control-button control-accent" disabled={busy} onClick={() => void run()}>{busy ? 'Đang xuất…' : 'Xuất file zip'}</button>
        </>
      )}
    >
      {done ? (
        <div class="space-y-2 text-[12px]">
          <div class="font-medium">Đã tải {done.filename} ({done.files.length} file).</div>
          <p class="m-0 text-[var(--color-text-muted)]">Đã gỡ {done.redactions} giá trị nhạy cảm (khoá, token, đường dẫn máy, email). Chúng trở thành ô điền khi người khác cài gói{done.inputs.length ? `: ${done.inputs.join(', ')}` : ''}.</p>
        </div>
      ) : (
        <div class="space-y-3 text-[12px]">
          <Field label="Tên gói"><input class="field" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Ví dụ: Đội bán hàng của tôi" /></Field>
          <Field label="Agent trong gói" hint="Kèm persona, skill, kiến thức và lịch của các agent này. Không kèm khoá hay token.">
            <div class="max-h-56 space-y-1 overflow-y-auto rounded border border-[var(--color-border)] p-2">
              {agents.map((a) => (
                <label key={a.id} class="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" checked={picked.has(a.id)} onChange={() => toggle(a.id)} />
                  <span>{a.name}</span><span class="hint mono">{a.id}</span>
                </label>
              ))}
              {agents.length === 0 && <span class="hint">Chưa có agent nào.</span>}
            </div>
          </Field>
          {err && <div class="text-[var(--color-status-failed)]">{err}</div>}
        </div>
      )}
    </Modal>
  );
}
