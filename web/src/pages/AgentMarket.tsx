import { Search, Store } from 'lucide-preact';
import { useMemo, useState } from 'preact/hooks';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { MarketInstallDialog } from '@/components/teams/MarketInstallDialog';
import { TeamInstallDialog } from '@/components/teams/TeamInstallDialog';
import type { MarketCatalog, MarketTemplate, TeamSummary } from '@/lib/teams';
import { useFetch } from '@/lib/useFetch';

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');

export default function AgentMarketPage() {
  const f = useFetch<MarketCatalog>('/agent-market');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');
  const [tpl, setTpl] = useState<MarketTemplate | null>(null);
  const [team, setTeam] = useState<TeamSummary | null>(null);
  const templates = f.data?.templates ?? [];
  const teams = f.data?.teams ?? [];
  const cats = useMemo(() => [...new Set(templates.map((t) => t.category))], [templates]);
  const match = (...parts: string[]) => !q.trim() || norm(parts.join(' ')).includes(norm(q));
  const shownT = templates.filter((t) => (cat === 'all' || t.category === cat) && match(t.name, t.description, t.category));
  const shownP = cat === 'all' || cat === 'team' ? teams.filter((t) => match(t.name, t.description)) : [];

  return (
    <div class="page">
      <PageHeader title="Chợ Agent" />
      <p class="hint mb-3 max-w-2xl">Chọn một mẫu agent hoặc cả gói team, xem trước những gì sẽ được tạo, rồi “Cài vào đội”. Mẫu nào cũng chạy được trên Claude, Codex, Grok hoặc Hermes; bạn chọn lúc cài.</p>
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <div class="relative">
          <Search size={12} class="pointer-events-none absolute left-2 top-2 text-[var(--color-text-faint)]" />
          <input class="field pl-6" style={{ width: '220px' }} placeholder="Tìm mẫu agent…" aria-label="Tìm mẫu agent" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </div>
        {['all', ...cats, ...(teams.length ? ['team'] : [])].map((c) => (
          <button key={c} type="button" class={`control-button ${cat === c ? 'is-active' : ''}`} onClick={() => setCat(c)}>{c === 'all' ? 'Tất cả' : c === 'team' ? 'Gói team' : c}</button>
        ))}
      </div>
      <PageState loading={f.loading && !f.data} error={f.error} empty={!!f.data && shownT.length + shownP.length === 0} emptyTitle="Không có mẫu nào khớp" />
      <div class="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
        {shownT.map((t) => (
          <article key={t.id} class="card card-pad flex flex-col gap-2" data-template={t.id}>
            <div class="flex items-start justify-between gap-2"><h3 class="m-0 text-[13px] font-medium">{t.name}</h3><Pill>{t.category}</Pill></div>
            <p class="m-0 text-[12px] text-[var(--color-text-muted)]">{t.description}</p>
            <ul class="hint m-0 list-disc pl-4">{t.capabilities.slice(0, 4).map((c) => <li key={c}>{c}</li>)}</ul>
            <div class="mt-auto"><button type="button" class="control-button control-accent" onClick={() => setTpl(t)}><Store size={12} /> Cài vào đội</button></div>
          </article>
        ))}
        {shownP.map((t) => (
          <article key={t.slug} class="card card-pad flex flex-col gap-2" data-team={t.slug}>
            <div class="flex items-start justify-between gap-2"><h3 class="m-0 text-[13px] font-medium">{t.name}</h3><Pill tone="accent">gói {t.agents.length} agent</Pill></div>
            <p class="m-0 text-[12px] text-[var(--color-text-muted)]">{t.description}</p>
            <div class="flex flex-wrap gap-1">{t.agents.map((a) => <Pill key={a.id}>{a.name}</Pill>)}</div>
            <div class="mt-auto"><button type="button" class="control-button control-accent" onClick={() => setTeam(t)}><Store size={12} /> Xem và cài</button></div>
          </article>
        ))}
      </div>
      <MarketInstallDialog template={tpl} onClose={() => setTpl(null)} />
      <TeamInstallDialog team={team} onClose={() => setTeam(null)} />
    </div>
  );
}
