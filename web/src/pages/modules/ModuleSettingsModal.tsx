// "Cài đặt" of one module, drawn from module.json `settings`. Secrets come back masked; leaving the mask keeps the stored value.
import { useEffect, useState } from 'preact/hooks';
import { Modal } from '@/components/Modal';
import { Toggle } from '@/components/Toggle';
import { apiGet, apiPut, errorText } from '@/lib/api';
import type { ModuleInfo, ModuleSettingSpec } from '@/lib/api-types';
import { pushToast } from '@/lib/toasts';

const MASK = '********';

/** Settings a person edits; JSON blobs the module keeps for itself stay hidden. */
export function editableSettings(m: ModuleInfo): [string, ModuleSettingSpec][] {
  return Object.entries(m.manifest.settings ?? {}).filter(([, s]) => !/\(JSON\)/i.test(s.label));
}

function Field({ k, spec, value, onChange }: { k: string; spec: ModuleSettingSpec; value: unknown; onChange: (v: unknown) => void }) {
  const id = `ms-${k}`;
  const help = spec.help ? <p class="hint m-0 mt-1">{spec.help}</p> : null;
  if (spec.type === 'boolean') {
    return (
      <div class="flex items-start justify-between gap-3 py-1">
        <div><label for={id} class="text-[13px]">{spec.label}</label>{help}</div>
        <Toggle on={value === true} onChange={() => onChange(!(value === true))} ariaLabel={spec.label} />
      </div>
    );
  }
  const common = { id, class: 'field w-full', value: value === undefined || value === null ? '' : String(value) };
  return (
    <div class="flex flex-col gap-1 py-1">
      <label for={id} class="text-[12.5px] text-[var(--color-text-muted)]">{spec.label}</label>
      {spec.type === 'select' ? (
        <select {...common} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
          {(spec.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : spec.type === 'number' ? (
        <input {...common} type="number" onInput={(e) => { const raw = (e.target as HTMLInputElement).value; onChange(raw === '' ? null : Number(raw)); }} />
      ) : spec.type === 'secret' ? (
        <input {...common} type="password" autocomplete="off" placeholder={value === MASK ? 'Đã lưu, để nguyên nếu không đổi' : 'Chưa nhập'}
          value={value === MASK ? '' : common.value} onInput={(e) => onChange((e.target as HTMLInputElement).value || (value === MASK ? MASK : ''))} />
      ) : (
        <input {...common} type="text" onInput={(e) => onChange((e.target as HTMLInputElement).value)} />
      )}
      {help}
    </div>
  );
}

export function ModuleSettingsModal({ module: m, onClose }: { module: ModuleInfo | null; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setValues(null);
    setErr(null);
    if (!m) return;
    apiGet<Record<string, unknown>>(`/modules/${m.manifest.id}/settings`).then(setValues, (e) => setErr(errorText(e)));
  }, [m?.manifest.id]);

  if (!m) return null;
  const fields = editableSettings(m);

  async function save() {
    if (!m || !values) return;
    setBusy(true);
    setErr(null);
    try {
      const patch = Object.fromEntries(fields.map(([k]) => [k, values[k]]));
      await apiPut(`/modules/${m.manifest.id}/settings`, patch);
      pushToast({ tone: 'success', title: `Đã lưu cài đặt ${m.manifest.name}` });
      onClose();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Cài đặt · ${m.manifest.name}`} width={520} closeDisabled={busy}
      footer={<>{err && <span class="mr-auto text-[12px] text-[var(--color-status-failed)]">{err}</span>}<button type="button" class="control-button" disabled={busy} onClick={onClose}>Huỷ</button><button type="button" class="control-button control-accent" disabled={busy || !values} onClick={() => void save()}>{busy ? 'Đang lưu…' : 'Lưu'}</button></>}>
      {!values && !err ? <p class="hint">Đang tải…</p> : null}
      {values && (
        <div class="flex flex-col gap-2">
          {fields.map(([k, spec]) => <Field key={k} k={k} spec={spec} value={values[k] ?? spec.default} onChange={(v) => setValues({ ...values, [k]: v })} />)}
          <p class="hint m-0 mt-1">Khoá bí mật được mã hoá trong data/aios.db, không hiện lại sau khi lưu.</p>
        </div>
      )}
    </Modal>
  );
}
