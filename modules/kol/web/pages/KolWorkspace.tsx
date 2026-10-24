/** /kol/:id — one KOL: overview, profile, studio, gallery, video, content, channels, growth (?tab=). */
import { useState } from 'preact/hooks';
import { Link, useLocation, useRoute, useSearch } from 'wouter-preact';
import { Archive, ArrowLeft, Bot, Pause, Play, Plus, Wand2 } from 'lucide-preact';
import { PageHeader, Tab } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { ConfirmModal } from '@/components/ConfirmModal';
import { BTN, BTN_PRIMARY } from '@modules/kol/web/components/shared/ops-shared';
import { Avatar, PersonaStatusPill, toastError, useKolStatus } from '@modules/kol/web/components/ui';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import { KOL, kolApi, personaAvatar, type PersonaDto, type PersonaStatus } from '@modules/kol/web/lib/kol';
import type { WorkspaceTabProps, WorkspaceTab } from './workspace-types';
import { KolOverviewTab } from './KolOverviewTab';
import { KolProfileTab } from './KolProfileTab';
import { KolStudioTab } from './KolStudioTab';
import { KolGalleryTab } from './KolGalleryTab';
import { KolVideoTab } from './KolVideoTab';
import { KolContentTab } from './KolContentTab';
import { KolChannelsTab } from './KolChannelsTab';
import { KolGrowthTab } from './KolGrowthTab';

const TABS: { key: WorkspaceTab; label: string }[] = [
  { key: 'overview', label: 'Tổng quan' },
  { key: 'profile', label: 'Hồ sơ' },
  { key: 'studio', label: 'Studio' },
  { key: 'gallery', label: 'Thư viện ảnh' },
  { key: 'video', label: 'Video' },
  { key: 'content', label: 'Nội dung' },
  { key: 'channels', label: 'Kênh' },
  { key: 'growth', label: 'Tăng trưởng' },
];
const TAB_KEYS = new Set<string>(TABS.map((t) => t.key));

export function KolWorkspace() {
  const [, params] = useRoute<{ id: string }>('/m/kol/:id');
  const id = params?.id ? decodeURIComponent(params.id) : '';
  const search = useSearch();
  const [, navigate] = useLocation();
  const query = new URLSearchParams(search);
  const rawTab = query.get('tab') ?? '';
  const tab: WorkspaceTab = TAB_KEYS.has(rawTab) ? (rawTab as WorkspaceTab) : 'overview';

  const res = useFetch<{ persona: PersonaDto }>(id ? KOL.persona(id) : null);
  const status = useKolStatus();
  const persona = res.data?.persona ?? null;

  const base = `/m/kol/${encodeURIComponent(id)}`;
  /** Switch tab; extra params pre-fill the target tab (e.g. asset=… for Video). */
  function go(next: WorkspaceTab, extra: Record<string, string> = {}, replace = false) {
    const q = new URLSearchParams(extra);
    if (next !== 'overview') q.set('tab', next);
    const s = q.toString();
    navigate(s ? `${base}?${s}` : base, { replace });
  }

  function refreshPersona() {
    invalidateFetchCache(KOL.persona(id));
    invalidateFetchCache(KOL.personas);
  }

  if (!persona) {
    return (
      <div class="flex flex-col h-full min-h-0">
        <PageHeader title="KOL" compact tabs={<Link href="/m/kol" class={`${BTN} h-8`}><ArrowLeft size={14} />KOL Studio</Link>} />
        <div class="flex-1 min-h-0 overflow-y-auto"><PageState loading={res.loading} error={res.error} /></div>
      </div>
    );
  }

  const props: WorkspaceTabProps = { persona, status: status.data, refreshPersona, go, query };

  return (
    <div class="flex flex-col h-full min-h-0">
      <PersonaStrip persona={persona} onChanged={refreshPersona} go={go} tab={tab} />
      <PageHeader
        title={`${persona.name} · ${TABS.find((t) => t.key === tab)?.label ?? ''}`}
        compact
        tabs={TABS.map((t) => <Tab key={t.key} label={t.label} active={tab === t.key} onClick={() => go(t.key, {}, true)} />)}
      />
      {tab === 'overview' && <KolOverviewTab {...props} />}
      {tab === 'profile' && <KolProfileTab {...props} />}
      {tab === 'studio' && <KolStudioTab {...props} />}
      {tab === 'gallery' && <KolGalleryTab {...props} />}
      {tab === 'video' && <KolVideoTab {...props} />}
      {tab === 'content' && <KolContentTab {...props} />}
      {tab === 'channels' && <KolChannelsTab {...props} />}
      {tab === 'growth' && <KolGrowthTab {...props} />}
    </div>
  );
}

function PersonaStrip({ persona: p, onChanged, go, tab }: { persona: PersonaDto; onChanged: () => void; go: WorkspaceTabProps['go']; tab: WorkspaceTab }) {
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [, navigate] = useLocation();

  async function setStatus(status: PersonaStatus) {
    setBusy(true);
    try {
      await kolApi.updatePersona(p.id, { status });
      pushToast({ tone: 'success', title: status === 'active' ? `${p.name} đã hoạt động` : status === 'paused' ? `Đã tạm dừng ${p.name}` : 'Đã cập nhật' });
      onChanged();
    } catch (err) {
      toastError('Không đổi được trạng thái', err);
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    setBusy(true);
    try {
      await kolApi.archivePersona(p.id);
      invalidateFetchCache(KOL.personas);
      pushToast({ tone: 'success', title: `Đã lưu trữ ${p.name}`, description: 'File và bài đã đăng được giữ nguyên.' });
      navigate('/m/kol');
    } catch (err) {
      toastError('Không lưu trữ được', err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-2 px-4 md:px-6 py-2.5 border-b border-[var(--color-border)] bg-[var(--color-card)] min-w-0">
      <Link href="/m/kol" class="inline-flex items-center gap-1 text-[12.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]" aria-label="Về danh sách KOL">
        <ArrowLeft size={14} /><span class="hidden sm:inline">KOL</span>
      </Link>
      <Avatar url={personaAvatar(p)} name={p.name} size={36} />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-1.5 min-w-0">
          <span class="text-[15px] font-semibold text-[var(--color-text)] truncate">{p.name}</span>
          <PersonaStatusPill status={p.status} />
          {p.autopilot.enabled && (
            <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--color-accent-soft)] text-[var(--color-accent)]"><Bot size={11} aria-hidden="true" />Autopilot</span>
          )}
        </div>
        <div class="text-[12px] text-[var(--color-text-muted)] truncate">{p.handle ? `@${p.handle}` : 'Chưa có handle'}{p.niche ? ` · ${p.niche}` : ''}</div>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        {tab !== 'studio' && <button type="button" class={BTN_PRIMARY} onClick={() => go('studio')}><Wand2 size={14} />Tạo ảnh</button>}
        <button type="button" class={BTN} aria-label="Bài mới" onClick={() => go('content', { new: '1' })}><Plus size={14} /><span class="hidden sm:inline">Bài mới</span></button>
        {(p.status === 'draft' || p.status === 'paused' || p.status === 'archived') && (
          <button type="button" class={BTN} disabled={busy} onClick={() => { void setStatus('active'); }} title="Cần dòng công bố AI và khuôn mặt chính trong Hồ sơ" aria-label="Kích hoạt"><Play size={14} /><span class="hidden sm:inline">Kích hoạt</span></button>
        )}
        {p.status === 'active' && <button type="button" class={BTN} disabled={busy} onClick={() => { void setStatus('paused'); }} aria-label="Tạm dừng"><Pause size={14} /><span class="hidden sm:inline">Tạm dừng</span></button>}
        {p.status !== 'archived' && (
          <button type="button" class={`${BTN} px-2`} disabled={busy} aria-label="Lưu trữ KOL" title="Lưu trữ" onClick={() => setConfirmArchive(true)}><Archive size={14} /></button>
        )}
      </div>
      <ConfirmModal
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        onConfirm={() => { void archive(); }}
        title={`Lưu trữ ${p.name}?`}
        body="KOL chuyển sang Lưu trữ: không tạo ảnh, không đăng bài, autopilot dừng. Ảnh, video và bài đã đăng được giữ nguyên. Có thể kích hoạt lại sau."
        confirmLabel="Lưu trữ"
        cancelLabel="Huỷ"
        destructive
      />
    </div>
  );
}
