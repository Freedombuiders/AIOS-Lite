import { useEffect, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import type { RuntimeId } from '@core/types';
import { Modal } from '@/components/Modal';
import { Field } from '@/components/ui';
import { apiPost, errorText } from '@/lib/api';
import { invalidateFetchCache } from '@/lib/useFetch';
import type { MarketPreview, MarketTemplate } from '@/lib/teams';
import { pushToast } from '@/lib/toasts';
import { RuntimeSelect } from './RuntimeSelect';

export function MarketInstallDialog({ template, onClose }: { template: MarketTemplate | null; onClose: () => void }) {
  const [name, setName] = useState('');
  const [runtime, setRuntime] = useState<RuntimeId>('claude');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<MarketPreview | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    setName(template?.name ?? '');
    setRuntime('claude');
    setFields(Object.fromEntries((template?.fields ?? []).map((f) => [f.key, f.defaultValue])));
    setPreview(null);
    setErr(null);
    setCreated(null);
    setOpen(null);
  }, [template?.id]);

  useEffect(() => {
    if (!template) return;
    let cancelled = false;
    const t = setTimeout(() => {
      apiPost<MarketPreview>(`/agent-market/${template.id}/preview`, { name, runtime, fields })
        .then((p) => !cancelled && (setPreview(p), setErr(null)))
        .catch((e) => !cancelled && setErr(errorText(e)));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [template?.id, name, runtime, JSON.stringify(fields)]);

  async function install() {
    if (!template) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await apiPost<{ agent: { id: string; name: string } }>(`/agent-market/${template.id}/install`, { name, runtime, fields });
      setCreated(r.agent);
      invalidateFetchCache('/agents');
      pushToast({ tone: 'success', title: `Đã thêm “${r.agent.name}” vào đội` });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={template !== null}
      onClose={onClose}
      title={template ? `Cài vào đội: ${template.name}` : ''}
      width={680}
      closeDisabled={busy}
      footer={created ? (
        <>
          <Link href={`/agents/${created.id}`} class="control-button">Mở agent</Link>
          <button type="button" class="control-button control-accent" onClick={onClose}>Xong</button>
        </>
      ) : (
        <>
          <button type="button" class="control-button" disabled={busy} onClick={onClose}>Huỷ</button>
          <button type="button" class="control-button control-accent" disabled={busy || !preview || preview.missingRequired.length > 0} onClick={() => void install()}>{busy ? 'Đang cài…' : 'Cài vào đội'}</button>
        </>
      )}
    >
      {template && created && <p class="m-0 text-[12px]">Đã tạo agent <span class="mono">{created.id}</span>. Agent ở chế độ an toàn và chưa có quyền nào; mở agent để cấp Second Brain, kết nối hoặc module.</p>}
      {template && !created && (
        <div class="space-y-3 text-[12px]">
          <p class="m-0 text-[var(--color-text-muted)]">{template.description}</p>
          <div class="grid grid-cols-2 gap-3">
            <Field label="Tên agent"><input class="field" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></Field>
            <Field label="Runtime" hint="Chọn công cụ chạy agent; đổi được sau."><RuntimeSelect value={runtime} onChange={setRuntime} /></Field>
          </div>
          {template.fields.map((f) => (
            <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} hint={f.help || undefined}>
              {f.multiline
                ? <textarea class="field" rows={3} placeholder={f.placeholder} value={fields[f.key] ?? ''} onInput={(e) => setFields({ ...fields, [f.key]: (e.target as HTMLTextAreaElement).value })} />
                : <input class="field" placeholder={f.placeholder} value={fields[f.key] ?? ''} onInput={(e) => setFields({ ...fields, [f.key]: (e.target as HTMLInputElement).value })} />}
            </Field>
          ))}
          {err && <div class="text-[var(--color-status-failed)]">{err}</div>}
          {preview && (
            <div>
              <div class="section-title mb-1">Sẽ tạo agent <span class="mono normal-case">{preview.agentId}</span> với các file</div>
              <ul class="m-0 list-none space-y-1 p-0">
                {preview.files.map((f) => (
                  <li key={f.path}>
                    <button type="button" class="cursor-pointer border-0 bg-transparent p-0 text-left" onClick={() => setOpen(open === f.path ? null : f.path)}>
                      <span class="mono">{f.path}</span> <span class="hint">· {f.description}</span>
                    </button>
                    {open === f.path && <pre class="mono m-0 mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--color-elevated)] p-2 text-[11px]">{f.content}</pre>}
                  </li>
                ))}
              </ul>
              {preview.warnings.map((w) => <div key={w} class="hint mt-1">{w}</div>)}
              {preview.missingRequired.length > 0 && <div class="mt-1 text-[var(--color-status-review)]">Còn thiếu: {preview.missingRequired.join(', ')}.</div>}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
