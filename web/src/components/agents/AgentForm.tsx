import { useState } from 'preact/hooks';
import type { AgentConfig, ContextProfile, Permission, RuntimeId } from '@core/types';
import { Pill } from '@/components/Pill';
import { Toggle } from '@/components/Toggle';
import { Field } from '@/components/ui';
import { apiPost, errorText } from '@/lib/api';
import type { AgentInput, AgentSummary, DoctorCheck } from '@/lib/api-types';
import { RUNTIME_LABEL } from '@/lib/labels';

export interface AgentFormValue {
  id: string;
  name: string;
  description: string;
  runtime: RuntimeId;
  model: string;
  permission: Permission;
  context: ContextProfile;
  reportsTo: string;
  canDelegate: boolean;
  maxConcurrent: number;
  budget: string;
  enabled: boolean;
  persona: string;
  /** agent.yaml runtime_options, kept whole so saving the form never drops a key */
  runtimeOptions: AgentConfig['runtimeOptions'];
}

export const EMPTY_AGENT: AgentFormValue = {
  id: '', name: '', description: '', runtime: 'claude', model: '', permission: 'safe', context: 'standard', reportsTo: '', canDelegate: false,
  maxConcurrent: 1, budget: '', enabled: true, persona: '', runtimeOptions: {},
};

export function toInput(v: AgentFormValue): AgentInput {
  const budget = v.budget.trim() === '' ? undefined : Number(v.budget);
  return {
    name: v.name.trim(),
    description: v.description.trim(),
    runtime: v.runtime,
    model: v.model.trim() || undefined,
    permission: v.permission,
    context: v.context,
    reportsTo: v.reportsTo || undefined,
    canDelegate: v.canDelegate,
    maxConcurrent: v.maxConcurrent,
    budgetUsdMonth: budget !== undefined && Number.isFinite(budget) ? budget : undefined,
    enabled: v.enabled,
    persona: v.persona,
    runtimeOptions: v.runtimeOptions,
  };
}

export function validateAgent(v: AgentFormValue, creating: boolean): string | null {
  if (creating && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(v.id)) return 'Mã agent chỉ gồm chữ thường không dấu, số và dấu gạch ngang (ví dụ: sales-a).';
  if (!v.name.trim()) return 'Hãy nhập tên agent.';
  if (v.maxConcurrent < 1) return 'Số việc chạy song song tối thiểu là 1.';
  if (v.budget.trim() !== '' && !(Number(v.budget) >= 0)) return 'Ngân sách phải là số không âm.';
  if (v.runtime === 'genbot') {
    const o = v.runtimeOptions;
    if (!String(o.base_url ?? '').trim() || !String(o.bot_id ?? '').trim() || !String(o.key_env ?? '').trim()) return 'Agent GenBot cần đủ địa chỉ GenBot, mã bot và tên biến chứa khoá.';
    if (!/^GENBOT_KEY_[A-Z0-9_]+$/.test(String(o.key_env).trim())) return 'Tên biến chứa khoá phải có dạng GENBOT_KEY_<TÊN>, ví dụ GENBOT_KEY_CSKH. Đừng dán khoá vào đây.';
  }
  return null;
}

const GENBOT_FIELDS: { key: 'base_url' | 'bot_id' | 'key_env'; label: string; placeholder: string; hint: string }[] = [
  { key: 'base_url', label: 'Địa chỉ GenBot', placeholder: 'http://127.0.0.1:8800', hint: 'Cổng nhận webhook của GenBot. http:// chỉ cho máy này, máy khác dùng https://.' },
  { key: 'bot_id', label: 'Mã bot', placeholder: 'bot_abc123', hint: 'Lấy trong app GenBot, thẻ Bot API của bot.' },
  { key: 'key_env', label: 'Biến chứa khoá', placeholder: 'GENBOT_KEY_CSKH', hint: 'Tên biến trong file .env, không phải khoá.' },
];

/** The three GenBot values and a "Kiểm tra" button that sends one real message through the Bot API. */
function GenbotSettings({ value, onChange, agentId }: { value: AgentConfig['runtimeOptions']; onChange: (v: AgentConfig['runtimeOptions']) => void; agentId?: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ status: string; checks: DoctorCheck[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await apiPost<{ status: string; checks: DoctorCheck[] }>('/runtimes/genbot/check', { ...(agentId ? { agentId } : {}), runtimeOptions: value, probe: true }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
      <div class="grid gap-3 sm:grid-cols-3">
        {GENBOT_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            <input class="field mono" value={String(value[f.key] ?? '')} placeholder={f.placeholder} onInput={(e) => onChange({ ...value, [f.key]: (e.target as HTMLInputElement).value.trim() })} />
          </Field>
        ))}
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class="control-button control-sm" disabled={busy} onClick={() => void check()}>{busy ? 'Đang kiểm tra…' : 'Kiểm tra'}</button>
        <span class="hint">Gửi một tin "ping" thật tới bot (tính vào 10 lượt mỗi phút của bot).</span>
      </div>
      {error && <div class="text-[12px] text-[var(--color-danger)]">{error}</div>}
      {result && (
        <ul class="flex flex-col gap-1 text-[12px]">
          {result.checks.map((c, i) => (
            <li key={i} class="flex items-start gap-2">
              <Pill tone={c.level === 'error' ? 'error' : c.level === 'warn' ? 'warn' : 'success'}>{c.level === 'error' ? 'Lỗi' : c.level === 'warn' ? 'Lưu ý' : 'Được'}</Pill>
              <span>{c.message}{c.hint ? <span class="hint"> {c.hint}</span> : null}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface Props {
  value: AgentFormValue;
  onChange: (v: AgentFormValue) => void;
  creating?: boolean;
  others: AgentSummary[];
  /** which blocks to render */
  show?: 'settings' | 'persona' | 'all';
}

export function AgentForm({ value, onChange, creating, others, show = 'all' }: Props) {
  const savedId = creating ? undefined : value.id;
  const set = <K extends keyof AgentFormValue>(k: K, v: AgentFormValue[K]) => onChange({ ...value, [k]: v });
  const [idTouched, setIdTouched] = useState(false);
  const text = (k: 'id' | 'name' | 'description' | 'model' | 'budget') => (e: Event) => set(k, (e.target as HTMLInputElement).value);

  return (
    <div class="flex flex-col gap-3">
      {show !== 'persona' && (
        <>
          <div class="grid gap-3 sm:grid-cols-2">
            <Field label="Tên hiển thị">
              <input
                class="field"
                value={value.name}
                placeholder="Sales A"
                onInput={(e) => {
                  const name = (e.target as HTMLInputElement).value;
                  const slug = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                  onChange({ ...value, name, id: creating && !idTouched ? slug : value.id });
                }}
              />
            </Field>
            <Field label="Mã agent" hint={creating ? 'Dùng làm tên thư mục agents/<mã>, không đổi được sau này.' : undefined}>
              <input class="field mono" value={value.id} disabled={!creating} placeholder="sales-a" onInput={(e) => { setIdTouched(true); text('id')(e); }} />
            </Field>
          </div>
          <Field label="Mô tả ngắn">
            <input class="field" value={value.description} placeholder="Việc agent này phụ trách" onInput={text('description')} />
          </Field>
          <div class="grid gap-3 sm:grid-cols-3">
            <Field label="Runtime (CLI)">
              <select class="field" value={value.runtime} onChange={(e) => set('runtime', (e.target as HTMLSelectElement).value as RuntimeId)}>
                {(Object.keys(RUNTIME_LABEL) as RuntimeId[]).map((r) => (
                  <option key={r} value={r}>
                    {RUNTIME_LABEL[r]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Model" hint="Để trống = mặc định của CLI.">
              <input class="field mono" value={value.model} placeholder="claude-sonnet-5-5" onInput={text('model')} />
            </Field>
            <Field label="Báo cáo cho">
              <select class="field" value={value.reportsTo} onChange={(e) => set('reportsTo', (e.target as HTMLSelectElement).value)}>
                <option value="">— Không —</option>
                {others.filter((a) => a.id !== value.id).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {value.runtime === 'genbot' && <GenbotSettings value={value.runtimeOptions} agentId={savedId} onChange={(runtimeOptions) => set('runtimeOptions', runtimeOptions)} />}
          <div class="grid gap-3 sm:grid-cols-4">
            <Field label="Quyền chạy" hint={value.permission === 'full' ? 'Full: CLI được tự chạy lệnh và sửa file.' : 'Safe: CLI hỏi/chặn thao tác nguy hiểm.'}>
              <select class="field" value={value.permission} onChange={(e) => set('permission', (e.target as HTMLSelectElement).value as Permission)}>
                <option value="safe">Safe (an toàn)</option>
                <option value="full">Full (đầy đủ)</option>
              </select>
            </Field>
            <Field label="Ngữ cảnh" hint={value.context === 'lean' ? 'Lean: không công cụ, prompt ngắn.' : 'Standard: đầy đủ công cụ.'}>
              <select class="field" value={value.context} onChange={(e) => set('context', (e.target as HTMLSelectElement).value as ContextProfile)}>
                <option value="standard">Standard</option>
                <option value="lean">Lean</option>
              </select>
            </Field>
            <Field label="Chạy song song tối đa">
              <input class="field" type="number" min={1} max={8} value={value.maxConcurrent} onInput={(e) => set('maxConcurrent', Number((e.target as HTMLInputElement).value) || 1)} />
            </Field>
            <Field label="Ngân sách tháng ($)" hint="Để trống = không giới hạn.">
              <input class="field" type="number" min={0} step="0.5" value={value.budget} onInput={text('budget')} />
            </Field>
          </div>
          <div class="flex flex-wrap gap-x-6 gap-y-2">
            <label class="flex items-center gap-2 text-[12px]">
              <Toggle on={value.canDelegate} onChange={() => set('canDelegate', !value.canDelegate)} ariaLabel="Được giao việc cho agent khác" /> Được giao việc cho agent khác
            </label>
            <label class="flex items-center gap-2 text-[12px]">
              <Toggle on={value.enabled} onChange={() => set('enabled', !value.enabled)} ariaLabel="Đang bật" /> Đang bật
            </label>
          </div>
        </>
      )}
      {show !== 'settings' && (
        <Field label="Persona (persona.md)" hint="Viết bằng Markdown: vai trò, giọng điệu, quy tắc. Đây là phần agent đọc đầu tiên mỗi lượt.">
          <textarea class="field mono" rows={14} value={value.persona} onInput={(e) => set('persona', (e.target as HTMLTextAreaElement).value)} placeholder="# Vai trò&#10;&#10;Bạn là…" />
        </Field>
      )}
    </div>
  );
}
