// Kho dữ liệu: browse the cloud's pack store by module, see a pack, preview and install it into a brain folder,
// update it, uninstall it. Every install is an explicit owner action with a preview first.
import { ArrowLeft, RefreshCw } from 'lucide-preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { Modal } from '@/components/Modal';
import { PageHeader, Tab } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { errorText, qs } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import {
  ACTION_LABEL, FILE_STATUS_LABEL, PACK_MODULES, PACK_MODULE_LABEL, installPack, previewPack, previewUninstall, uninstallPack,
  type CloudStatus, type InstallResult, type PackDetail, type PackListItem, type PackPlan, type PackUpdate, type PlanAction,
} from '@/lib/packs';
import { pushToast } from '@/lib/toasts';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import type { Tone } from '@/lib/labels';
import { CloudSignInButton, CloudSignInPanel } from './CloudSignIn';

const ACTION_TONE: Record<PlanAction, Tone> = {
  create: 'success', update: 'info', same: 'neutral', skip: 'warn', delete: 'error', keep: 'warn', forget: 'neutral',
};

function CloudBar({ status, onChanged }: { status: CloudStatus; onChanged: () => void }) {
  return (
    <div class="hint flex flex-wrap items-center gap-2">
      <span>Cloud: <span class="mono">{status.cloudUrl}</span>{status.account ? ` · ${status.account}` : ''}</span>
      <CloudSignInButton cloudUrl={status.cloudUrl} label="Đăng nhập lại" accent={false} onDone={onChanged} />
    </div>
  );
}

function PackCard({ p }: { p: PackListItem }) {
  return (
    <Link href={`/packs/${p.id}`} class="card card-pad flex flex-col gap-1.5 no-underline text-[var(--color-text)] hover:border-[var(--color-accent)]">
      <div class="flex items-start justify-between gap-2">
        <div class="font-medium">{p.name}</div>
        {p.latest?.version && <span class="mono hint">v{p.latest.version}</span>}
      </div>
      {p.summary && <div class="text-[12.5px] text-[var(--color-text-muted)]">{p.summary}</div>}
      <div class="mt-auto flex flex-wrap gap-1.5 pt-1">
        <Pill tone="neutral">{PACK_MODULE_LABEL[p.module] ?? p.module}</Pill>
        {p.industry && <Pill tone="neutral">{p.industry}</Pill>}
        {p.installs.length > 0 && <Pill tone="success">Đã cài · {p.installs.map((i) => i.folderId).join(', ')}</Pill>}
        {p.updateAvailable && <Pill tone="info">Có bản mới</Pill>}
      </div>
    </Link>
  );
}

function StoreList({ status, refreshStatus }: { status: CloudStatus; refreshStatus: () => void }) {
  const [module, setModule] = useState('');
  const list = useFetch<{ items: PackListItem[] }>(`/packs${qs({ module })}`);
  const updates = useFetch<{ items: PackUpdate[] }>('/packs/updates');
  const items = list.data?.items ?? [];
  const yanked = (updates.data?.items ?? []).filter((u) => u.yanked);
  const tabs = (
    <>
      <Tab label="Tất cả" active={module === ''} onClick={() => setModule('')} />
      {PACK_MODULES.map((m) => <Tab key={m} label={PACK_MODULE_LABEL[m]!} active={module === m} onClick={() => setModule(m)} />)}
    </>
  );
  return (
    <>
      <PageHeader
        title="Kho dữ liệu"
        actions={<button type="button" class="control-button inline-flex items-center gap-1" onClick={() => { list.refresh(); updates.refresh(); }}><RefreshCw size={13} /> Tải lại</button>}
        tabs={tabs}
      />
      <div class="mb-3 flex flex-col gap-1">
        <CloudBar status={status} onChanged={() => { refreshStatus(); list.refresh(); }} />
        <p class="hint m-0">Gói là kiến thức chung do người khác soạn. Khi cài, mọi bài học vào ở dạng giả thuyết và mọi công thức ở dạng chưa thử, để bot kiểm lại trên kênh của bạn.</p>
      </div>
      {yanked.length > 0 && (
        <div class="card card-pad mb-3 text-[12.5px] text-[var(--color-status-failed)]">
          {yanked.map((u) => <div key={u.id}>Bản {u.have} của gói <Link href={`/packs/${u.id}`}>{u.id}</Link> đã bị thu hồi{u.latest ? `; bản mới nhất là ${u.latest}` : ''}.</div>)}
        </div>
      )}
      <PageState loading={list.loading && !list.data} error={list.error} empty={!!list.data && items.length === 0} emptyTitle="Chưa có gói nào" emptyDescription="Kho chưa có gói cho mục này." />
      {items.length > 0 && <div class="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>{items.map((p) => <PackCard key={p.id} p={p} />)}</div>}
    </>
  );
}

function PlanView({ plan }: { plan: PackPlan }) {
  const c = plan.counts;
  const shown = plan.items.filter((i) => i.action !== 'same' && i.action !== 'forget');
  return (
    <div class="flex flex-col gap-2 text-[12.5px]">
      <div>
        Vào thư mục <b>{plan.folderId}</b>{plan.from ? <> · từ bản {plan.from} lên {plan.version}</> : null}:
        {' '}{c.create} ghi chú mới, {c.update} cập nhật, {c.delete} xoá, {c.skip} bỏ qua, {c.keep} giữ lại{c.same ? `, ${c.same} không đổi` : ''}.
      </div>
      {plan.assets.length > 0 && <div class="hint">{plan.assets.length} ảnh minh hoạ trong gói không được chép vào brain (brain chỉ nhận ghi chú).</div>}
      {shown.length > 0 && (
        <div class="max-h-72 overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
          <table class="table">
            <thead><tr><th>Việc</th><th>Ghi chú</th><th>Lý do</th></tr></thead>
            <tbody>
              {shown.map((i) => (
                <tr key={i.path}>
                  <td><Pill tone={ACTION_TONE[i.action]}>{ACTION_LABEL[i.action]}</Pill></td>
                  <td class="mono break-all">{i.path}</td>
                  <td class="hint">{i.reason ?? (i.loai ? `loai: ${i.loai}` : '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ResultView({ r }: { r: InstallResult }) {
  return (
    <div class="text-[12.5px]">
      <div>{r.written.length} ghi chú đã ghi, {r.deleted.length} đã xoá, trong một commit: <span class="mono">{r.message}</span></div>
      {[...r.skipped, ...r.kept].length > 0 && (
        <ul class="m-0 mt-1 pl-5">{[...r.skipped, ...r.kept].map((s) => <li key={s.path}><span class="mono">{s.path}</span>: {s.reason}</li>)}</ul>
      )}
    </div>
  );
}

function InstallBox({ pack, onDone }: { pack: PackDetail; onDone: () => void }) {
  const releases = pack.releases.filter((r) => r.status === 'published' && !r.yankedAt);
  const folders = useFetch<{ items: { id: string; name: string }[] }>('/brain/folders');
  const [version, setVersion] = useState(releases[0]?.version ?? pack.latest?.version ?? '');
  const [folder, setFolder] = useState('');
  const [plan, setPlan] = useState<PackPlan | null>(null);
  const [result, setResult] = useState<InstallResult | null>(null);
  const [busy, setBusy] = useState<'preview' | 'install' | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!folder && folders.data?.items[0]) setFolder(pack.installs[0]?.folderId ?? folders.data.items[0].id);
  }, [folders.data]);
  useEffect(() => { setPlan(null); setResult(null); setError(''); }, [version, folder]);

  const installed = pack.installs.find((i) => i.folderId === folder);
  async function preview() {
    setBusy('preview'); setError(''); setResult(null);
    try { setPlan(await previewPack(pack.id, version, folder)); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  async function install() {
    if (!plan) return;
    setBusy('install'); setError('');
    try {
      const r = await installPack(pack.id, plan.version, plan.folderId, plan.planId);
      setResult(r); setPlan(null);
      pushToast({ tone: 'success', title: plan.from ? `Đã cập nhật ${pack.name} lên ${plan.version}` : `Đã cài ${pack.name}`, description: `${r.written.length} ghi chú vào ${plan.folderId}` });
      invalidateFetchCache('/packs');
      onDone();
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  const nothing = plan && plan.counts.create + plan.counts.update + plan.counts.delete === 0;
  return (
    <div class="card card-pad flex flex-col gap-2">
      <div class="font-medium">{installed ? 'Cập nhật gói' : 'Cài gói'}</div>
      <div class="flex flex-wrap items-end gap-2 text-[12.5px]">
        <label class="flex flex-col gap-1">Bản
          <select class="field" value={version} onChange={(e) => setVersion((e.target as HTMLSelectElement).value)}>
            {(releases.length ? releases.map((r) => r.version) : [version]).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label class="flex flex-col gap-1">Vào thư mục brain
          <select class="field" value={folder} onChange={(e) => setFolder((e.target as HTMLSelectElement).value)}>
            {(folders.data?.items ?? []).map((f) => <option key={f.id} value={f.id}>{f.name || f.id}</option>)}
          </select>
        </label>
        <button type="button" class="control-button" disabled={!version || !folder || !!busy} onClick={() => void preview()}>{busy === 'preview' ? 'Đang tải và kiểm gói…' : 'Xem trước'}</button>
      </div>
      {installed && <div class="hint">Thư mục này đang có bản {installed.version}.</div>}
      {plan && <PlanView plan={plan} />}
      {plan && (
        <div>
          <button type="button" class="control-button control-accent" disabled={!!busy || !!nothing} onClick={() => void install()}>
            {busy === 'install' ? 'Đang cài…' : nothing ? 'Không có gì để ghi' : plan.from ? `Cập nhật lên ${plan.version}` : 'Cài vào brain'}
          </button>
        </div>
      )}
      {result && <ResultView r={result} />}
      {error && <p role="alert" class="m-0 break-words text-[12.5px] text-[var(--color-status-failed)]">{error}</p>}
    </div>
  );
}

function UninstallButton({ packId, folderId, onDone }: { packId: string; folderId: string; onDone: () => void }) {
  const [plan, setPlan] = useState<PackPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function open() {
    setBusy(true); setError('');
    try { setPlan(await previewUninstall(packId, folderId)); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function confirm() {
    if (!plan) return;
    setBusy(true); setError('');
    try {
      const r = await uninstallPack(packId, folderId, plan.planId);
      pushToast({ tone: 'success', title: 'Đã gỡ gói', description: `${r.deleted.length} ghi chú đã xoá, ${r.kept.length} giữ lại` });
      setPlan(null);
      invalidateFetchCache('/packs');
      onDone();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <>
      <button type="button" class="control-button control-sm text-[var(--color-status-failed)]" disabled={busy} onClick={() => void open()}>Gỡ</button>
      {error && !plan && <span role="alert" class="text-[12px] text-[var(--color-status-failed)]">{error}</span>}
      <Modal open={!!plan} onClose={() => setPlan(null)} closeDisabled={busy} title={`Gỡ gói khỏi ${folderId}?`} width={620}
        footer={<>
          <button type="button" class="control-button" disabled={busy} onClick={() => setPlan(null)}>Giữ lại</button>
          <button type="button" class="control-button control-accent ml-auto" disabled={busy} onClick={() => void confirm()}>{busy ? 'Đang gỡ…' : 'Gỡ gói'}</button>
        </>}>
        {plan && <div class="flex flex-col gap-2"><p class="m-0 text-[12.5px]">Chỉ xoá ghi chú bạn chưa sửa. Ghi chú bạn đã sửa được giữ lại như ghi chú của bạn. Cả lần gỡ là một commit, hoàn tác được.</p><PlanView plan={plan} />{error && <p role="alert" class="m-0 text-[12.5px] text-[var(--color-status-failed)]">{error}</p>}</div>}
      </Modal>
    </>
  );
}

function PackDetailView({ id }: { id: string }) {
  const f = useFetch<PackDetail>(`/packs/${encodeURIComponent(id)}`);
  const [showFiles, setShowFiles] = useState(false);
  const p = f.data;
  const latest = p?.latest?.version;
  return (
    <>
      <PageHeader title={p?.name ?? id} breadcrumb="Kho dữ liệu" actions={<Link href="/packs" class="control-button inline-flex items-center gap-1 no-underline"><ArrowLeft size={13} /> Về kho</Link>} />
      <PageState loading={f.loading && !p} error={f.error} />
      {p && (
        <div class="flex flex-col gap-3">
          <div class="card card-pad flex flex-col gap-1.5 text-[12.5px]">
            {p.summary && <div>{p.summary}</div>}
            <div class="flex flex-wrap gap-1.5">
              <Pill tone="neutral">{PACK_MODULE_LABEL[p.module] ?? p.module}</Pill>
              {p.industry && <Pill tone="neutral">{p.industry}</Pill>}
              {latest && <Pill tone="neutral">Bản mới nhất {latest}</Pill>}
            </div>
            <div class="hint">Giấy phép: {p.license ?? '—'} · Tác giả: {p.author ?? '—'} · Mã gói: <span class="mono">{p.id}</span></div>
            {p.files.length > 0 && (
              <div>
                <button type="button" class="control-button control-sm" onClick={() => setShowFiles(!showFiles)}>{showFiles ? 'Ẩn' : 'Xem'} danh sách file ({p.files.length})</button>
                {showFiles && <ul class="m-0 mt-1 pl-5">{p.files.map((x) => <li key={x.path}><span class="mono">{x.path}</span>{x.loai ? <span class="hint"> · {x.loai}</span> : null}</li>)}</ul>}
              </div>
            )}
          </div>

          {p.installs.length > 0 && (
            <div class="card overflow-x-auto">
              <table class="table">
                <thead><tr><th>Thư mục</th><th>Bản</th><th>Cập nhật lúc</th><th>Ghi chú</th><th /></tr></thead>
                <tbody>
                  {p.installs.map((i) => {
                    const edited = i.fileStatus.filter((s) => s.status === 'edited').length;
                    const newer = latest && latest !== i.version;
                    return (
                      <tr key={i.folderId}>
                        <td>{i.folderId}</td>
                        <td class="mono">{i.version} {newer && <Pill tone="info">Có bản mới {latest}</Pill>}</td>
                        <td>{formatDateTime(i.updatedAt)}</td>
                        <td>{i.files} {edited > 0 && <span class="hint">· {edited} {FILE_STATUS_LABEL.edited.toLowerCase()}</span>}</td>
                        <td><UninstallButton packId={p.id} folderId={i.folderId} onDone={f.refresh} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <InstallBox key={p.id} pack={p} onDone={f.refresh} />
        </div>
      )}
    </>
  );
}

export default function PacksPage({ id }: { id?: string }) {
  const status = useFetch<CloudStatus>('/cloud/status');
  const s = status.data;
  const body = useMemo(() => {
    if (!s) return null;
    if (!s.connected) return <CloudSignInPanel status={s} onDone={() => { invalidateFetchCache('/packs'); status.refresh(); }} />;
    return id ? <PackDetailView id={id} /> : <StoreList status={s} refreshStatus={status.refresh} />;
  }, [s, id]);
  return (
    <div class="page">
      {!s?.connected && <PageHeader title="Kho dữ liệu" />}
      <PageState loading={status.loading && !s} error={status.error} />
      {body}
    </div>
  );
}
