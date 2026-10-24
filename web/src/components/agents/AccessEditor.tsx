import { useMemo, useState } from 'preact/hooks';
import type { AgentAccessConfig, FolderGrant } from '@core/types';
import { Pill } from '@/components/Pill';
import { Toggle } from '@/components/Toggle';
import { Card } from '@/components/ui';
import { apiPut, errorText } from '@/lib/api';
import type { AccessEnforcement, AgentAccessResponse, BrainFolderView, ConnectionView, Enforcement, SkillView } from '@/lib/api-types';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';
import { moduleInfos, scopeLabels } from '@/module-host/host';

const ENF_LABEL: Record<Enforcement, string> = { hard: 'Chặn cứng', soft: 'Chỉ dặn trong prompt', none: 'Không chặn' };
const ENF_TONE: Record<Enforcement, 'success' | 'warn' | 'error'> = { hard: 'success', soft: 'warn', none: 'error' };

export function EnforcementBadge({ level }: { level: Enforcement }) {
  return <Pill tone={ENF_TONE[level]}>{ENF_LABEL[level]}</Pill>;
}

export function EnforcementPanel({ enforcement, runtimeLabel }: { enforcement: AccessEnforcement; runtimeLabel: string }) {
  const rows: [string, Enforcement, string][] = [
    ['Bộ nhớ, brain, dữ liệu module', enforcement.context, 'AIOS-Lite quyết định phần nào được đưa vào prompt.'],
    ['Công cụ kết nối (MCP)', enforcement.mcp, 'Chỉ cấp các kết nối đã chọn.'],
    ['Đọc file', enforcement.fileRead, 'Thư mục brain ngoài quyền đọc.'],
    ['Ghi file', enforcement.fileWrite, 'Thư mục brain ngoài quyền ghi.'],
    ['Chạy lệnh shell', enforcement.shell, 'Lệnh chạy trong thư mục làm việc.'],
  ];
  return (
    <Card title={`Mức ràng buộc thực tế của ${runtimeLabel}`}>
      <table class="table">
        <tbody>
          {rows.map(([label, level, help]) => (
            <tr key={label}>
              <td class="w-56">{label}</td>
              <td class="w-44"><EnforcementBadge level={level} /></td>
              <td class="hint">{help}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {enforcement.note && <div class="mt-2 rounded-[var(--radius-md)] bg-[var(--color-elevated)] px-3 py-2 text-[12px]">{enforcement.note}</div>}
      <div class="hint mt-2">
        <b>Chặn cứng</b>: hệ thống thật sự ngăn agent. <b>Chỉ dặn trong prompt</b>: AIOS-Lite ghi quy tắc vào prompt nhưng CLI không ép được, nên đừng xem đó là rào bảo mật.
      </div>
    </Card>
  );
}

const globs = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

function normalize(a: AgentAccessConfig): AgentAccessConfig {
  return { ...a, brain: a.brain ?? {}, memory: a.memory ?? { team: false, private: false }, skills: a.skills ?? [], connections: a.connections ?? {}, modules: a.modules ?? {} };
}

export function AccessEditor({ agentId, access, runtimeLabel, onSaved }: { agentId: string; access: AgentAccessConfig; runtimeLabel: string; onSaved: () => void }) {
  const [draft, setDraft] = useState<AgentAccessConfig>(() => normalize(access));
  const [busy, setBusy] = useState(false);
  const folders = useFetch<{ items: BrainFolderView[] }>('/brain/folders');
  const skills = useFetch<{ items: SkillView[] }>('/skills');
  const conns = useFetch<{ items: ConnectionView[] }>('/connections');
  const enf = useFetch<AgentAccessResponse>(`/agents/${agentId}/access`);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(normalize(access)), [draft, access]);
  const enabledModules = moduleInfos.value.filter((m) => m.state.enabled);

  const patch = (p: Partial<AgentAccessConfig>) => setDraft((d) => ({ ...d, ...p }));

  function setFolder(id: string, g: FolderGrant | null) {
    const brain = { ...draft.brain };
    if (g) brain[id] = g;
    else delete brain[id];
    patch({ brain });
  }

  async function save() {
    setBusy(true);
    try {
      await apiPut(`/agents/${agentId}`, { access: draft });
      pushToast({ tone: 'success', title: 'Đã lưu quyền', description: 'Áp dụng từ lượt chạy tiếp theo.' });
      enf.refresh();
      onSaved();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không lưu được quyền', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const skillList = skills.data?.items ?? [];
  const allSkills = draft.skills === 'all';
  const chosenSkills = Array.isArray(draft.skills) ? draft.skills : [];

  return (
    <div class="flex flex-col gap-3">
      {enf.data && <EnforcementPanel enforcement={enf.data.enforcement} runtimeLabel={runtimeLabel} />}

      <Card title="Second Brain (thư mục và quyền)">
        {folders.data?.items.length === 0 && <div class="hint">Chưa khai báo thư mục brain nào (config/brain.yaml).</div>}
        <div class="flex flex-col gap-2">
          {(folders.data?.items ?? []).map((f) => {
            const g = draft.brain[f.id];
            return (
              <div key={f.id} class="rounded-[var(--radius-md)] border border-[var(--color-border)] p-2.5">
                <label class="flex items-center gap-2">
                  <Toggle size="sm" on={!!g} onChange={() => setFolder(f.id, g ? null : { read: ['**'], write: [] })} ariaLabel={`Cấp thư mục ${f.name}`} />
                  <span class="text-[12.5px] font-medium">{f.name}</span>
                  <span class="hint mono">{f.id}</span>
                  {!f.exists && <Pill tone="warn">chưa tồn tại</Pill>}
                </label>
                {g && (
                  <div class="mt-2 grid gap-2 sm:grid-cols-2">
                    <label class="block">
                      <span class="label">Được đọc (glob, phân cách bằng dấu phẩy)</span>
                      <input class="field mono" value={g.read.join(', ')} placeholder="** hoặc Ban-hang/**" onChange={(e) => setFolder(f.id, { ...g, read: globs((e.target as HTMLInputElement).value) })} />
                    </label>
                    <label class="block">
                      <span class="label">Được ghi (để trống = chỉ đọc)</span>
                      <input class="field mono" value={g.write.join(', ')} placeholder="Ghi-chu/**" onChange={(e) => setFolder(f.id, { ...g, write: globs((e.target as HTMLInputElement).value) })} />
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Bộ nhớ">
        <div class="flex flex-wrap gap-x-8 gap-y-2">
          <label class="flex items-center gap-2 text-[12px]">
            <Toggle size="sm" on={draft.memory.team} onChange={() => patch({ memory: { ...draft.memory, team: !draft.memory.team } })} ariaLabel="Bộ nhớ chung của đội" /> Bộ nhớ chung của đội
          </label>
          <label class="flex items-center gap-2 text-[12px]">
            <Toggle size="sm" on={draft.memory.private} onChange={() => patch({ memory: { ...draft.memory, private: !draft.memory.private } })} ariaLabel="Bộ nhớ riêng" /> Bộ nhớ riêng của agent
          </label>
        </div>
      </Card>

      <Card title="Skills">
        <label class="mb-2 flex items-center gap-2 text-[12px]">
          <Toggle size="sm" on={allSkills} onChange={() => patch({ skills: allSkills ? [] : 'all' })} ariaLabel="Tất cả skill" /> Dùng tất cả skill
        </label>
        {!allSkills && (
          <div class="grid gap-1 sm:grid-cols-2">
            {skillList.length === 0 && <div class="hint">Chưa có skill nào trong thư viện.</div>}
            {skillList.map((s) => (
              <label key={s.id} class="flex items-start gap-2 text-[12px]">
                <input
                  type="checkbox"
                  class="mt-0.5"
                  checked={chosenSkills.includes(s.id)}
                  onChange={(e) => patch({ skills: (e.target as HTMLInputElement).checked ? [...chosenSkills, s.id] : chosenSkills.filter((x) => x !== s.id) })}
                />
                <span>
                  {s.name} <span class="hint">{s.source !== 'library' ? s.source : ''}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </Card>

      <Card title="Kết nối">
        {conns.data?.items.length === 0 && <div class="hint">Chưa có kết nối nào (config/connections.yaml).</div>}
        <div class="flex flex-col gap-2">
          {(conns.data?.items ?? []).map((c) => {
            const grant = draft.connections[c.id];
            const on = grant !== undefined;
            const patterns = Array.isArray(grant) ? grant.join(', ') : '';
            return (
              <div key={c.id} class="flex flex-wrap items-center gap-2">
                <Toggle size="sm" on={on} onChange={() => { const next = { ...draft.connections }; if (on) delete next[c.id]; else next[c.id] = true; patch({ connections: next }); }} ariaLabel={`Cấp kết nối ${c.id}`} />
                <span class="w-36 text-[12.5px] font-medium">{c.id}</span>
                <Pill>{c.type}</Pill>
                {!c.ready && <Pill tone="warn">chưa sẵn sàng</Pill>}
                {on && c.type === 'mcp' && (
                  <input
                    class="field mono"
                    style={{ flex: 1, minWidth: 200 }}
                    placeholder="Mẫu tên công cụ, ví dụ search_*  (trống = mọi công cụ)"
                    value={patterns}
                    onChange={(e) => { const list = globs((e.target as HTMLInputElement).value); patch({ connections: { ...draft.connections, [c.id]: list.length ? list : true } }); }}
                  />
                )}
                {on && c.type !== 'mcp' && <span class="hint">cấp toàn bộ</span>}
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Module (quyền theo module đang bật)">
        {enabledModules.length === 0 && <div class="hint">Chưa bật module nào. Vào trang Module để thêm.</div>}
        <div class="flex flex-col gap-2.5">
          {enabledModules.map((m) => {
            const scopes = scopeLabels(m);
            if (!scopes.length) return null;
            const have = draft.modules[m.manifest.id] ?? [];
            return (
              <div key={m.manifest.id}>
                <div class="mb-1 text-[12.5px] font-medium">{m.manifest.name}</div>
                <div class="grid gap-1 sm:grid-cols-2">
                  {scopes.map((s) => (
                    <label key={s.scope} class="flex items-start gap-2 text-[12px]" title={s.description}>
                      <input
                        type="checkbox"
                        class="mt-0.5"
                        checked={have.includes(s.scope)}
                        onChange={(e) => {
                          const next = (e.target as HTMLInputElement).checked ? [...have, s.scope] : have.filter((x) => x !== s.scope);
                          const modules = { ...draft.modules };
                          if (next.length) modules[m.manifest.id] = next;
                          else delete modules[m.manifest.id];
                          patch({ modules });
                        }}
                      />
                      <span>{s.label} <span class="hint mono">{s.scope}</span></span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <div class="sticky bottom-0 flex items-center justify-end gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg)] py-2">
        {dirty && <span class="hint mr-auto">Có thay đổi chưa lưu</span>}
        <button type="button" class="control-button" disabled={!dirty || busy} onClick={() => setDraft(normalize(access))}>Hoàn tác</button>
        <button type="button" class="control-button control-accent" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Đang lưu…' : 'Lưu quyền'}</button>
      </div>
    </div>
  );
}
