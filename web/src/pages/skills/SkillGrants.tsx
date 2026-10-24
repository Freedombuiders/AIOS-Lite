import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { PageState } from '@/components/PageState';
import { apiPut, errorText } from '@/lib/api';
import type { AgentSummary, SkillView } from '@/lib/api-types';
import { pushToast } from '@/lib/toasts';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';

/** Matrix skills x agents. Saves one skill at a time through PUT /skills/:id/agents. */
export function SkillGrants({ skills, onChanged }: { skills: SkillView[]; onChanged: () => void }) {
  const agents = useFetch<{ items: AgentSummary[] }>('/agents');
  const [busy, setBusy] = useState<string | null>(null);
  const list = agents.data?.items ?? [];
  const allAgents = list.filter((a) => a.access.skills === 'all');

  async function toggle(skill: SkillView, agent: AgentSummary, on: boolean) {
    const manual = skill.usedBy.filter((id) => list.find((a) => a.id === id)?.access.skills !== 'all');
    const next = on ? [...manual, agent.id] : manual.filter((id) => id !== agent.id);
    setBusy(`${skill.id}:${agent.id}`);
    try {
      await apiPut(`/skills/${skill.id}/agents`, { agentIds: next });
      invalidateFetchCache('/agents');
      agents.refresh();
      onChanged();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không lưu được phân quyền', description: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  if (!agents.data) return <PageState loading={agents.loading} error={agents.error} />;
  return (
    <div class="flex flex-col gap-2">
      <p class="hint m-0">Đánh dấu agent nào được dùng skill nào. Thay đổi lưu ngay và áp dụng từ lượt chạy tiếp theo.</p>
      {allAgents.length > 0 && (
        <div class="rounded-[var(--radius-md)] bg-[var(--color-elevated)] px-3 py-2 text-[12px]">
          {allAgents.map((a) => a.name).join(', ')}: đang để “dùng tất cả skill” nên mọi ô đều được chọn và không đổi được ở đây. Đổi trong tab Quyền của agent:{' '}
          {allAgents.map((a) => <Link key={a.id} href={`/agents/${a.id}?tab=access`} class="mr-2">{a.name}</Link>)}
        </div>
      )}
      <div class="card overflow-x-auto">
        <table class="table" aria-label="Phân quyền skill cho agent">
          <thead>
            <tr>
              <th class="min-w-56">Skill</th>
              {list.map((a) => (
                <th key={a.id} class="text-center" title={a.access.skills === 'all' ? 'Dùng tất cả skill' : a.id}>
                  <Link href={`/agents/${a.id}?tab=access`} class="no-underline">{a.name}</Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {skills.map((s) => (
              <tr key={s.id}>
                <td>
                  <div class="text-[12.5px] font-medium">{s.name}</div>
                  <div class="hint mono">{s.id}</div>
                </td>
                {list.map((a) => {
                  const isAll = a.access.skills === 'all';
                  const checked = isAll || s.usedBy.includes(a.id);
                  return (
                    <td key={a.id} class="text-center">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isAll || busy === `${s.id}:${a.id}`}
                        aria-label={`${a.name} dùng skill ${s.name}`}
                        onChange={(e) => void toggle(s, a, (e.target as HTMLInputElement).checked)}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
