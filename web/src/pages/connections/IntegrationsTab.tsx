import { useMemo, useState } from 'preact/hooks';
import { ExternalLink, Eye, EyeOff, Plug, Search } from 'lucide-preact';
import { Link } from 'wouter-preact';
import { ConfirmModal } from '@/components/ConfirmModal';
import { Modal } from '@/components/Modal';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { apiPost, errorText } from '@/lib/api';
import { fold, resolveAgentName } from '@/lib/format';
import { disconnectIntegration, GRANT_LEVELS, RISK_LABEL, saveIntegration, testIntegration, type IntegrationCommand, type IntegrationField, type IntegrationRisk, type IntegrationSummary } from '@/lib/integrations';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';

const configured = (i: IntegrationSummary) => i.status !== 'not_configured';
const grantLabel = (g: string) => GRANT_LEVELS.find((l) => l.value === g)?.label ?? g;

export function StatusPill({ i }: { i: IntegrationSummary }) {
  if (i.status === 'ok') return <Pill tone="done">Đã kết nối{i.accountLabel ? ` · ${i.accountLabel}` : ''}</Pill>;
  if (i.status === 'error') return <Pill tone="failed">Lỗi</Pill>;
  if (i.status === 'unchecked') return <Pill tone="queued">Chưa kiểm tra</Pill>;
  return <Pill tone="neutral">Chưa kết nối</Pill>;
}

const RISK_TONE: Record<IntegrationRisk, 'neutral' | 'warn' | 'error'> = { read: 'neutral', write: 'warn', destructive: 'error' };

function CommandList({ commands }: { commands: IntegrationCommand[] }) {
  return (
    <ul class="m-0 list-none divide-y divide-[var(--color-border)] p-0">
      {commands.map((c) => (
        <li key={c.name} class="flex flex-wrap items-start gap-2 px-3 py-1.5 text-[12px]">
          <Pill tone={RISK_TONE[c.risk]}>{RISK_LABEL[c.risk]}</Pill>
          <span class="mono font-medium">{c.name}</span>
          <span class="hint min-w-0 flex-1">{c.description}</span>
        </li>
      ))}
    </ul>
  );
}

function FieldInput({ field: f, value, disabled, onChange }: { field: IntegrationField; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const [shown, setShown] = useState(false);
  const secret = f.kind === 'secret';
  const placeholder = secret && f.value ? `Đã lưu ${f.value}, để trống để giữ nguyên` : f.placeholder;
  return (
    <label class="block">
      <span class="label">{f.label}{f.required && <span class="text-[var(--color-status-failed)]"> *</span>}</span>
      <span class="relative block">
        <input class={`field ${secret ? 'pr-9' : ''}`} disabled={disabled} type={secret && !shown ? 'password' : 'text'} value={value} placeholder={placeholder}
          autocomplete={secret ? 'new-password' : 'off'} spellcheck={false} onInput={(e) => onChange((e.target as HTMLInputElement).value)} />
        {secret && (
          <button type="button" aria-label={shown ? `Ẩn ${f.label}` : `Hiện ${f.label}`} aria-pressed={shown} class="absolute right-1 top-1/2 -translate-y-1/2 border-0 bg-transparent p-1 text-[var(--color-text-muted)]" onClick={() => setShown(!shown)}>
            {shown ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
      </span>
      {f.help && <span class="hint mt-1 block">{f.help}</span>}
    </label>
  );
}

const initialValues = (i: IntegrationSummary) => Object.fromEntries(i.fields.map((f) => [f.key, f.kind === 'text' ? f.value : '']));

function IntegrationModal({ integration, composioReady, onClose, onChanged }: { integration: IntegrationSummary; composioReady: boolean; onClose: () => void; onChanged: () => void }) {
  const [cur] = useState(integration);
  const [values, setValues] = useState(() => initialValues(integration));
  const [busy, setBusy] = useState<'save' | 'test' | 'oauth' | 'check' | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [redirectUrl, setRedirectUrl] = useState('');
  const [confirming, setConfirming] = useState(false);
  const isOn = configured(cur);
  const oauth = cur.authKind === 'oauth';

  async function save(e?: Event) {
    e?.preventDefault();
    if (busy || oauth) return;
    const missing = cur.fields.find((f) => f.required && !(values[f.key] ?? '').trim() && !(f.kind === 'secret' && f.value));
    if (missing) { setError(`Nhập ${missing.label}.`); return; }
    setBusy('save'); setError('');
    try {
      const res = await saveIntegration(cur.id, values);
      pushToast({ tone: 'success', title: `Đã kết nối ${cur.name}`, description: res.accountLabel || undefined });
      onChanged(); onClose();
    } catch (err) {
      const detail = (err as { body?: { error?: { detail?: string } } }).body?.error?.detail;
      setError(detail ? `${errorText(err)}: ${detail}` : errorText(err));
    } finally { setBusy(null); }
  }
  async function retest() {
    setBusy('test'); setError('');
    try {
      const r = await testIntegration(cur.id);
      if (r.ok) { pushToast({ tone: 'success', title: 'Kết nối hoạt động', description: r.accountLabel || r.detail }); setNote(r.detail); }
      else setError(r.detail);
      onChanged();
    } catch (err) { setError(errorText(err)); } finally { setBusy(null); }
  }
  async function disconnect() {
    try {
      await disconnectIntegration(cur.id);
      pushToast({ tone: 'success', title: `Đã ngắt kết nối ${cur.name}`, description: 'Quyền đã cấp cho agent được giữ nguyên.' });
      onChanged(); onClose();
    } catch (err) { setError(errorText(err)); setConfirming(false); }
  }
  async function startOAuth() {
    setBusy('oauth'); setError('');
    try { const r = await apiPost<{ redirectUrl: string }>(`/integrations/${cur.id}/oauth/start`); setRedirectUrl(r.redirectUrl); setNote('Mở trang đăng nhập bên dưới. Hoàn tất xong, quay lại để kiểm tra.'); }
    catch (err) { setError(errorText(err)); } finally { setBusy(null); }
  }
  async function checkOAuth() {
    setBusy('check'); setError('');
    try {
      const r = await apiPost<{ connected: boolean; status?: string }>(`/integrations/${cur.id}/oauth/check`);
      if (r.connected) { pushToast({ tone: 'success', title: `Đã kết nối ${cur.name}` }); onChanged(); onClose(); }
      else setNote(`Chưa hoàn tất đăng nhập (${r.status || 'đang chờ'}).`);
    } catch (err) { setError(errorText(err)); } finally { setBusy(null); }
  }

  const footer = (
    <>
      {isOn && <button type="button" class="control-button text-[var(--color-status-failed)]" disabled={!!busy} onClick={() => setConfirming(true)}>Ngắt kết nối</button>}
      {isOn && <button type="button" class="control-button" disabled={!!busy} onClick={() => void retest()}>{busy === 'test' ? 'Đang kiểm tra…' : 'Kiểm tra lại'}</button>}
      {oauth
        ? <button type="button" class="control-button control-accent ml-auto" disabled={!!busy || !composioReady} onClick={() => void startOAuth()}>{busy === 'oauth' ? 'Đang mở…' : isOn ? 'Đăng nhập lại' : 'Đăng nhập'}</button>
        : <button type="button" class="control-button control-accent ml-auto" disabled={!!busy} onClick={() => void save()}>{busy === 'save' ? 'Đang kiểm tra…' : 'Lưu & kiểm tra'}</button>}
    </>
  );

  return (
    <>
      <Modal open onClose={onClose} closeDisabled={!!busy} title={`${isOn ? 'Cài đặt' : 'Kết nối'} ${cur.name}`} width={600} footer={footer}>
        <form onSubmit={save} class="flex flex-col gap-3" autocomplete="off">
          <div class="flex flex-wrap items-center gap-2"><StatusPill i={cur} />{cur.status === 'error' && cur.statusDetail && <span class="text-[12px] text-[var(--color-status-failed)]">{cur.statusDetail}</span>}</div>
          <p class="m-0 text-[12.5px] text-[var(--color-text-muted)]">{cur.description}</p>
          {cur.setupSteps.length > 0 && (
            <div>
              <div class="label">Cách lấy thông tin kết nối</div>
              <ol class="m-0 list-decimal space-y-1 pl-5 text-[12.5px]">{cur.setupSteps.map((s, n) => <li key={n}>{s}</li>)}</ol>
              {cur.docsUrl && <a href={cur.docsUrl} target="_blank" rel="noopener noreferrer" class="mt-1.5 inline-flex items-center gap-1 text-[12.5px]">Xem tài liệu <ExternalLink size={11} /></a>}
            </div>
          )}
          {oauth && (
            <div class="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
              {!composioReady && <p class="m-0 text-[12.5px]">Kết nối Composio trước để mở đăng nhập Google.</p>}
              {redirectUrl && <a href={redirectUrl} target="_blank" rel="noopener noreferrer" class="control-button control-accent inline-flex items-center gap-1 no-underline">Mở đăng nhập <ExternalLink size={12} /></a>}
              {composioReady && <button type="button" class="control-button" disabled={!!busy} onClick={() => void checkOAuth()}>{busy === 'check' ? 'Đang xác nhận…' : 'Kiểm tra đăng nhập'}</button>}
            </div>
          )}
          {cur.fields.map((f) => <FieldInput key={f.key} field={f} value={values[f.key] ?? ''} disabled={!!busy} onChange={(v) => setValues({ ...values, [f.key]: v })} />)}
          <button type="submit" class="sr-only" tabIndex={-1} aria-hidden="true">Lưu</button>
          {note && <p role="status" class="m-0 text-[12.5px] text-[var(--color-text-muted)]">{note}</p>}
          {error && <p role="alert" class="m-0 break-words text-[12.5px] text-[var(--color-status-failed)]">{error}</p>}

          <div>
            <div class="label">Agent đang được cấp</div>
            {cur.grantedTo.length === 0 ? <span class="hint">Chưa agent nào. Cấp ở Agents › Quyền › Integration.</span> : (
              <div class="flex flex-wrap gap-1.5">{cur.grantedTo.map((g) => <Link key={g.agentId} href={`/agents/${g.agentId}`} class="no-underline"><Pill tone={g.grant === 'write' ? 'warn' : 'neutral'}>{resolveAgentName(g.agentId)} · {grantLabel(g.grant)}</Pill></Link>)}</div>
            )}
            <div class="hint mt-1">{cur.calls24h} lượt gọi trong 24 giờ qua.</div>
          </div>
          {cur.commands.length > 0 && (
            <details class="rounded-[var(--radius-md)] border border-[var(--color-border)]">
              <summary class="cursor-pointer px-3 py-2 text-[12.5px] font-medium">Agent dùng được gì ({cur.commands.length} lệnh)</summary>
              <CommandList commands={cur.commands} />
            </details>
          )}
        </form>
      </Modal>
      <ConfirmModal open={confirming} onClose={() => setConfirming(false)} onConfirm={() => void disconnect()} destructive title={`Ngắt kết nối ${cur.name}?`} confirmLabel="Ngắt kết nối" cancelLabel="Giữ lại"
        body="Thông tin kết nối trên máy này sẽ bị xoá; agent không gọi được cho tới khi kết nối lại. Quyền trên nhà cung cấp không bị thu hồi." />
    </>
  );
}

function Card({ i, onOpen }: { i: IntegrationSummary; onOpen: () => void }) {
  const on = configured(i);
  return (
    <article class="card card-pad flex min-w-0 flex-col gap-2" data-testid={`integration-${i.id}`}>
      <div class="flex flex-wrap items-center gap-2">
        <Plug size={16} class="text-[var(--color-accent)]" />
        <h3 class="m-0 text-[13.5px] font-semibold">{i.name}</h3>
        <Pill>{i.authKind === 'oauth' ? 'Đăng nhập' : 'API key'}</Pill>
      </div>
      <p class="m-0 text-[12.5px] text-[var(--color-text-muted)]">{i.description}</p>
      <div><StatusPill i={i} /></div>
      {on && <div class="hint">{i.grantedTo.length ? `${i.grantedTo.length} agent được cấp` : 'Chưa cấp cho agent'} · {i.calls24h} lượt gọi / 24 giờ</div>}
      <div class="mt-auto flex items-center gap-2 pt-1">
        <button type="button" class="control-button control-sm" onClick={onOpen}>{on ? 'Sửa' : 'Kết nối'}</button>
        {i.docsUrl && <a href={i.docsUrl} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-[12px]">Hướng dẫn <ExternalLink size={11} /></a>}
      </div>
    </article>
  );
}

export function IntegrationsTab() {
  const f = useFetch<{ items: IntegrationSummary[] }>('/integrations', 60_000);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('service'));
  const items = f.data?.items ?? [];
  const groups = useMemo(() => {
    const q = fold(query);
    const m = new Map<string, IntegrationSummary[]>();
    for (const i of items) if (!q || fold(`${i.name} ${i.description}`).includes(q)) m.set(i.category, [...(m.get(i.category) ?? []), i]);
    return [...m.entries()];
  }, [items, query]);
  const opened = items.find((i) => i.id === openId);
  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center gap-3">
        <label class="relative"><span class="sr-only">Tìm dịch vụ</span><Search size={13} class="absolute left-2.5 top-2.5 text-[var(--color-text-faint)]" /><input type="search" class="field pl-8" style={{ width: 260 }} placeholder="Tìm dịch vụ…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} /></label>
        <span class="hint">{items.filter(configured).length}/{items.length} đã kết nối. Khoá được mã hoá trên máy này.</span>
      </div>
      <PageState loading={f.loading && !f.data} error={f.error} empty={!!f.data && groups.length === 0} emptyTitle="Không tìm thấy dịch vụ phù hợp" />
      {groups.map(([cat, list]) => (
        <section key={cat}>
          <h2 class="m-0 mb-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{cat}</h2>
          <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{list.map((i) => <Card key={i.id} i={i} onOpen={() => setOpenId(i.id)} />)}</div>
        </section>
      ))}
      {opened && <IntegrationModal key={opened.id} integration={opened} composioReady={items.some((i) => i.id === 'composio' && configured(i))} onClose={() => setOpenId(null)} onChanged={f.refresh} />}
    </div>
  );
}
