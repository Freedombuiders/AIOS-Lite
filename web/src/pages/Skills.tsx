import { Search } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { Markdown } from '@/components/ui';
import type { SkillView } from '@/lib/api-types';
import { fold, resolveAgentName } from '@/lib/format';
import { renderMarkdown } from '@/lib/markdown';
import { useFetch } from '@/lib/useFetch';

/** Drop a leading YAML front matter block so the viewer shows the readable part. */
function stripFrontMatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

function SkillBody({ id }: { id: string }) {
  const f = useFetch<{ skill: SkillView; content: string }>(`/skills/${id}`);
  if (!f.data) return <PageState loading={f.loading} error={f.error} />;
  return <Markdown html={renderMarkdown(stripFrontMatter(f.data.content))} />;
}

export default function SkillsPage() {
  const f = useFetch<{ items: SkillView[] }>('/skills');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const needle = fold(q);
  const items = (f.data?.items ?? []).filter((s) => !needle || fold(`${s.name} ${s.description}`).includes(needle));
  const current = (f.data?.items ?? []).find((s) => s.id === sel) ?? items[0];

  return (
    <div class="page page-wide">
      <PageHeader title="Skills" actions={<div class="relative"><Search size={12} class="absolute top-2 left-2 text-[var(--color-text-faint)]" /><input class="field" style={{ width: 220, paddingLeft: 24 }} placeholder="Tìm skill…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} /></div>} />
      <PageState loading={f.loading && !f.data} error={f.error} empty={!!f.data && f.data.items.length === 0} emptyTitle="Chưa có skill nào" emptyDescription="Skill là thư mục skills/<mã>/SKILL.md. Thêm vào thư viện, rồi cấp cho agent ở tab Quyền." />
      {(f.data?.items.length ?? 0) > 0 && (
        <div class="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
          <div class="flex flex-col gap-1.5">
            {items.length === 0 && <div class="hint">Không có skill khớp “{q}”.</div>}
            {items.map((s) => (
              <button key={s.id} type="button" onClick={() => setSel(s.id)} class={`card card-pad text-left cursor-pointer ${current?.id === s.id ? 'border-[var(--color-accent)]' : ''}`}>
                <div class="flex items-center gap-1.5"><span class="text-[12.5px] font-semibold">{s.name}</span>{s.source !== 'library' && <Pill tone="info">{s.source}</Pill>}</div>
                <div class="hint mt-0.5 line-clamp-2">{s.description}</div>
                <div class="mt-1.5 text-[11px] text-[var(--color-text-faint)]">{s.usedBy.length ? `Dùng bởi ${s.usedBy.length} agent` : 'Chưa agent nào dùng'}</div>
              </button>
            ))}
          </div>
          <div class="card card-pad min-w-0">
            {current ? (
              <>
                <div class="mb-1 flex flex-wrap items-center gap-2"><h2 class="m-0 text-[15px] font-semibold">{current.name}</h2><span class="hint mono">{current.id}</span></div>
                <div class="mb-3 flex flex-wrap items-center gap-1.5 text-[12px]">
                  <span class="hint">Agent đang dùng:</span>
                  {current.usedBy.length === 0 && <span class="hint">chưa có (cấp ở tab Quyền của agent)</span>}
                  {current.usedBy.map((a) => <Link key={a} href={`/agents/${a}`} class="pill pill-accent no-underline">{resolveAgentName(a)}</Link>)}
                </div>
                <div class="hint mono mb-3">{current.path}</div>
                <SkillBody key={current.id} id={current.id} />
              </>
            ) : <div class="hint">Chọn một skill để xem SKILL.md.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
