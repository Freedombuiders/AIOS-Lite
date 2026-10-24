import { Download, PackageOpen, Upload, Users } from 'lucide-preact';
import { useRef, useState } from 'preact/hooks';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { ExportTeamDialog } from '@/components/teams/ExportTeamDialog';
import { TeamInstallDialog } from '@/components/teams/TeamInstallDialog';
import { apiDelete, apiPost, errorText } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { fileToBase64, type TeamSummary, type TeamsList } from '@/lib/teams';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';

function TeamCard({ team, onInstall, onDrop }: { team: TeamSummary; onInstall: () => void; onDrop?: () => void }) {
  return (
    <article class="card card-pad flex flex-col gap-2" data-team={team.slug}>
      <div class="flex items-start justify-between gap-2">
        <h3 class="m-0 text-[13px] font-medium">{team.name}</h3>
        <Pill tone={team.source.kind === 'import' ? 'warn' : 'accent'}>{team.source.kind === 'import' ? 'đã nhập' : 'có sẵn'}</Pill>
      </div>
      <p class="m-0 text-[12px] text-[var(--color-text-muted)]">{team.description}</p>
      <div class="flex flex-wrap gap-1">
        {team.agents.map((a) => <Pill key={a.id}>{a.name}</Pill>)}
      </div>
      <div class="hint">{team.agents.length} agent · {team.schedules.length} lịch · {team.inputs.length} ô cần điền</div>
      <div class="mt-auto flex gap-2">
        <button type="button" class="control-button control-accent" onClick={onInstall}><PackageOpen size={12} /> Xem và cài</button>
        {onDrop && <button type="button" class="control-button" onClick={onDrop}>Bỏ gói nhập</button>}
      </div>
    </article>
  );
}

export default function TeamsPage() {
  const f = useFetch<TeamsList>('/teams');
  const fileInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<TeamSummary | null>(null);
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const data = f.data;

  async function onFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const r = await apiPost<{ id: string; team: TeamSummary }>('/teams/import', { base64: await fileToBase64(file) });
      f.refresh();
      setSelected(r.team);
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không nhập được gói', description: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  async function drop(t: TeamSummary) {
    try {
      await apiDelete(`/teams/import/${t.source.id}`);
      f.refresh();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không bỏ được gói', description: errorText(err) });
    }
  }

  const all = [...(data?.items ?? []), ...(data?.imported ?? [])];
  return (
    <div class="page">
      <PageHeader
        title="Gói Team"
        actions={
          <>
            <input ref={fileInput} type="file" accept=".zip,application/zip" class="hidden" onChange={(e) => void onFile(e)} />
            <button type="button" class="control-button" disabled={busy} onClick={() => fileInput.current?.click()}><Upload size={12} /> Nhập gói zip</button>
            <button type="button" class="control-button control-accent" onClick={() => setExporting(true)}><Download size={12} /> Xuất team của tôi</button>
          </>
        }
      />
      <p class="hint mb-3 max-w-2xl">Gói team là một nhóm agent dựng sẵn (persona, skill, lịch). Xem trước những gì sẽ được tạo rồi mới cài. Gói không bao giờ chứa khoá hay token.</p>
      <PageState loading={f.loading && !data} error={f.error} empty={!!data && all.length === 0} emptyTitle="Chưa có gói nào" emptyDescription="Đặt gói vào thư mục teams/ hoặc nhập file zip." />
      {all.length > 0 && (
        <div class="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {all.map((t) => <TeamCard key={`${t.source.kind}:${t.source.id}`} team={t} onInstall={() => setSelected(t)} onDrop={t.source.kind === 'import' ? () => void drop(t) : undefined} />)}
        </div>
      )}
      {data && data.problems.length > 0 && (
        <div class="card card-pad mt-4 text-[12px]">
          <div class="section-title mb-1">Gói lỗi, không hiển thị</div>
          {data.problems.map((p) => <div key={p.name}><span class="mono">{p.name}</span>: {p.errors[0]}</div>)}
        </div>
      )}
      {data && data.history.length > 0 && (
        <section class="mt-5">
          <div class="section-title mb-2 flex items-center gap-1"><Users size={12} /> Đã cài gần đây</div>
          <div class="card overflow-x-auto">
            <table class="table">
              <thead><tr><th>Gói</th><th>Agent đã tạo</th><th>Lịch</th><th>Khi nào</th></tr></thead>
              <tbody>
                {data.history.map((h) => (
                  <tr key={h.at + h.slug}><td>{h.name}</td><td class="mono">{h.agents.join(', ')}</td><td>{h.schedules}</td><td>{formatRelativeTime(h.at)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <TeamInstallDialog team={selected} onClose={() => setSelected(null)} onInstalled={() => f.refresh()} />
      <ExportTeamDialog open={exporting} onClose={() => setExporting(false)} />
    </div>
  );
}
