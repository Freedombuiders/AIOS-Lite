/** Marketing › KOL Studio: KOL list (+ new-KOL wizard), shared library, templates, settings. */
import { useMemo, useState } from 'preact/hooks';
import { Link, useLocation, useSearch } from 'wouter-preact';
import { Bot, Plus, Sparkles } from 'lucide-preact';
import { PageHeader, Tab } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { BTN_PRIMARY, Checkbox } from '@modules/kol/web/components/shared/ops-shared';
import { NewKolWizard } from '@modules/kol/web/components/NewKolWizard';
import { StudioReadiness } from '@modules/kol/web/components/Readiness';
import { Avatar, EmptyHint, PersonaStatusPill, PlatformIcons, useKolStatus } from '@modules/kol/web/components/ui';
import { useFetch } from '@/lib/useFetch';
import { KOL, fmtCompact, fmtUsd, fmtInt, type KolStatusDto, type PersonaSummaryDto } from '@modules/kol/web/lib/kol';
import { KolLibraryTab } from './KolLibraryTab';
import { KolTemplatesTab } from './KolTemplatesTab';
import { KolSettingsTab } from './KolSettingsTab';

type TabKey = 'kol' | 'library' | 'templates' | 'settings';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'kol', label: 'KOL' },
  { key: 'library', label: 'Thư viện' },
  { key: 'templates', label: 'Mẫu tái tạo' },
  { key: 'settings', label: 'Cài đặt' },
];

export function KolHome() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const raw = new URLSearchParams(search).get('tab');
  const tab: TabKey = raw === 'library' || raw === 'templates' || raw === 'settings' ? raw : 'kol';
  const status = useKolStatus();
  const [wizard, setWizard] = useState(false);

  const setTab = (next: TabKey) => navigate(next === 'kol' ? '/m/kol' : `/m/kol?tab=${next}`, { replace: true });

  return (
    <div class="flex flex-col h-full min-h-0">
      <PageHeader
        title="KOL Studio"
        compact
        tabs={TABS.map((t) => <Tab key={t.key} label={t.label} active={tab === t.key} onClick={() => setTab(t.key)} />)}
        actions={tab === 'kol' && (
          <button type="button" class={BTN_PRIMARY} onClick={() => setWizard(true)}><Plus size={14} />Tạo KOL mới</button>
        )}
      />
      {tab === 'kol' && <KolListTab status={status.data} onNew={() => setWizard(true)} />}
      {tab === 'library' && <KolLibraryTab />}
      {tab === 'templates' && <KolTemplatesTab />}
      {tab === 'settings' && <KolSettingsTab status={status.data} onChanged={status.refresh} />}
      {wizard && <NewKolWizard onClose={() => setWizard(false)} />}
    </div>
  );
}

function KolListTab({ status, onNew }: { status: KolStatusDto | null; onNew: () => void }) {
  const list = useFetch<{ personas: PersonaSummaryDto[] }>(KOL.personas, 60_000);
  const [showArchived, setShowArchived] = useState(false);
  const all = list.data?.personas ?? [];
  const archived = all.filter((p) => p.status === 'archived').length;
  const personas = useMemo(
    () => all.filter((p) => showArchived || p.status !== 'archived').sort((a, b) => b.updatedAt - a.updatedAt),
    [all, showArchived],
  );

  return (
    <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4 flex flex-col gap-3">
      <StudioReadiness status={status} />
      {!list.data && <PageState loading={list.loading} error={list.error} />}
      {list.data && all.length === 0 && (
        <EmptyHint
          icon={<Sparkles size={20} />}
          title="Chưa có KOL nào"
          action={<button type="button" class={BTN_PRIMARY} onClick={onNew}><Plus size={14} />Tạo KOL đầu tiên</button>}
        >
          Một KOL ảo gồm hồ sơ (ngoại hình, tính cách, giọng văn), bộ ảnh khuôn mặt để giữ nhận diện, và các kênh để đăng bài.
          Bắt đầu bằng 4 bước: thông tin, ngoại hình, tính cách, khuôn mặt.
        </EmptyHint>
      )}
      {list.data && all.length > 0 && (
        <>
          <div class="flex flex-wrap items-center gap-3 text-[12.5px] text-[var(--color-text-muted)]">
            <span>{personas.length} KOL</span>
            {archived > 0 && (
              <Checkbox checked={showArchived} onChange={setShowArchived}>Hiện KOL đã lưu trữ ({archived})</Checkbox>
            )}
          </div>
          <ul class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 list-none m-0 p-0">
            {personas.map((p) => <li key={p.id} class="min-w-0"><PersonaCard p={p} /></li>)}
          </ul>
        </>
      )}
    </div>
  );
}

function PersonaCard({ p }: { p: PersonaSummaryDto }) {
  return (
    <Link
      href={`/m/kol/${encodeURIComponent(p.id)}`}
      class={`block rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4 hover:border-[var(--color-border-strong)] hover:bg-[var(--color-control-hover)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] min-w-0 ${p.status === 'archived' ? 'opacity-60' : ''}`}
    >
      <div class="flex items-start gap-3 min-w-0">
        <Avatar url={p.avatarUrl} name={p.name} size={56} />
        <div class="flex-1 min-w-0">
          <div class="flex flex-wrap items-center gap-1.5 min-w-0">
            <span class="text-[15px] font-semibold text-[var(--color-text)] truncate">{p.name}</span>
            <PersonaStatusPill status={p.status} />
            {p.autopilot && (
              <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                <Bot size={11} aria-hidden="true" />Autopilot
              </span>
            )}
          </div>
          {p.handle && <div class="text-[12.5px] text-[var(--color-text-muted)] truncate">@{p.handle}</div>}
          {(p.niche || p.tagline) && <div class="mt-1 text-[12.5px] text-[var(--color-text)] line-clamp-2">{p.niche || p.tagline}</div>}
        </div>
      </div>
      <div class="mt-3 flex items-center justify-between gap-2 min-w-0">
        {p.platforms.length > 0
          ? <PlatformIcons platforms={p.platforms} size={20} />
          : <span class="text-[12px] text-[var(--color-text-faint)]">Chưa liên kết kênh</span>}
        <span class="text-[12px] text-[var(--color-text-muted)] tabular-nums">{p.refCount} ảnh mặt · {fmtInt(p.assetCount)} media</span>
      </div>
      <dl class="mt-3 grid grid-cols-3 sm:grid-cols-5 gap-2 text-center">
        <Stat label="Theo dõi" title="Tổng người theo dõi" value={fmtCompact(p.followers)} />
        <Stat label="Chờ đăng" title="Bài đã lên lịch" value={fmtInt(p.postsScheduled)} />
        <Stat label="30 ngày" title="Bài đã đăng trong 30 ngày" value={fmtInt(p.postsPublished30d)} />
        <Stat label="Chi tháng" title="Chi tiêu tháng này" value={fmtUsd(p.spendMonthUsd)} />
        <Stat label="Giống mặt" title="Điểm giống khuôn mặt trung bình" value={p.avgConsistency === null ? '–' : String(Math.round(p.avgConsistency))} />
      </dl>
    </Link>
  );
}

function Stat({ label, title, value }: { label: string; title: string; value: string }) {
  return (
    <div class="rounded-md bg-[var(--color-elevated)] px-1.5 py-1.5 min-w-0" title={title}>
      <dt class="text-[10.5px] text-[var(--color-text-muted)] truncate">{label}</dt>
      <dd class="text-[13px] font-semibold tabular-nums text-[var(--color-text)] truncate">{value}</dd>
    </div>
  );
}
