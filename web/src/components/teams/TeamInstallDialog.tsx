import { useEffect, useMemo, useState } from 'preact/hooks';
import type { RuntimeId } from '@core/types';
import { Modal } from '@/components/Modal';
import { Pill } from '@/components/Pill';
import { Field } from '@/components/ui';
import { apiPost, errorText } from '@/lib/api';
import { invalidateFetchCache } from '@/lib/useFetch';
import type { InstallPlan, InstallResult, Strategy, TeamSummary } from '@/lib/teams';
import { pushToast } from '@/lib/toasts';
import { RuntimeSelect } from './RuntimeSelect';

/** Preview what a team package will create, then install it. */
export function TeamInstallDialog({ team, onClose, onInstalled }: { team: TeamSummary | null; onClose: () => void; onInstalled?: () => void }) {
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [strategy, setStrategy] = useState<Strategy>('rename');
  const [runtime, setRuntime] = useState<RuntimeId>('claude');
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InstallResult | null>(null);

  useEffect(() => {
    setInputs(Object.fromEntries((team?.inputs ?? []).map((i) => [i.key, i.defaultValue])));
    setStrategy('rename');
    setRuntime('claude');
    setPlan(null);
    setErr(null);
    setResult(null);
  }, [team?.source.id]);

  const body = useMemo(() => (team ? { source: team.source, inputs, strategy, defaultRuntime: runtime } : null), [team, inputs, strategy, runtime]);

  useEffect(() => {
    if (!body) return;
    let cancelled = false;
    const t = setTimeout(() => {
      apiPost<InstallPlan>('/teams/preview', body)
        .then((p) => !cancelled && (setPlan(p), setErr(null)))
        .catch((e) => !cancelled && setErr(errorText(e)));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [JSON.stringify(body)]);

  async function install() {
    if (!body) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await apiPost<InstallResult>('/teams/install', body);
      setResult(r);
      invalidateFetchCache('/agents');
      invalidateFetchCache('/teams');
      invalidateFetchCache('/schedules');
      pushToast({ tone: 'success', title: `Đã cài gói “${r.name}”`, description: `${r.agents.length} agent mới` });
      onInstalled?.();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={team !== null}
      onClose={onClose}
      title={team ? `Cài gói: ${team.name}` : ''}
      width={680}
      closeDisabled={busy}
      footer={
        result ? (
          <button type="button" class="control-button control-accent" onClick={onClose}>Xong</button>
        ) : (
          <>
            <button type="button" class="control-button" disabled={busy} onClick={onClose}>Huỷ</button>
            <button type="button" class="control-button control-accent" disabled={busy || !plan?.canInstall} onClick={() => void install()}>{busy ? 'Đang cài…' : 'Cài vào đội'}</button>
          </>
        )
      }
    >
      {team && result && (
        <div class="space-y-3 text-[12px]">
          <div class="font-medium">Đã tạo {result.agents.length} agent{result.schedules.length ? `, ${result.schedules.length} lịch (đang tắt)` : ''}{result.skills.length ? `, ${result.skills.length} skill` : ''}.</div>
          <ul class="m-0 list-disc pl-5">{result.agents.map((a) => <li key={a.id}><span class="mono">{a.id}</span> · {a.name}</li>)}</ul>
          {result.warnings.length > 0 && <ul class="hint m-0 list-disc pl-5">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          <div><div class="section-title mb-1">Việc cần làm tiếp</div><ul class="m-0 list-disc pl-5">{result.nextSteps.map((s) => <li key={s}>{s}</li>)}</ul></div>
        </div>
      )}
      {team && !result && (
        <div class="space-y-3 text-[12px]">
          <p class="m-0 text-[var(--color-text-muted)]">{team.description}</p>
          {team.inputs.map((i) => (
            <Field key={i.key} label={`${i.label}${i.required ? ' *' : ''}`} hint={i.kind === 'secret' ? 'Khoá bí mật: không được lưu, bạn điền thủ công sau khi cài.' : i.description}>
              <input class="field" type={i.kind === 'secret' ? 'password' : 'text'} disabled={i.kind === 'secret'} value={inputs[i.key] ?? ''} onInput={(e) => setInputs({ ...inputs, [i.key]: (e.target as HTMLInputElement).value })} />
            </Field>
          ))}
          <div class="grid grid-cols-2 gap-3">
            <Field label="Runtime mặc định"><RuntimeSelect value={runtime} onChange={setRuntime} /></Field>
            <Field label="Nếu trùng id agent">
              <select class="field" value={strategy} onChange={(e) => setStrategy((e.target as HTMLSelectElement).value as Strategy)}>
                <option value="rename">Đổi tên agent mới (thêm -2)</option>
                <option value="skip">Giữ agent đang có, bỏ qua</option>
              </select>
            </Field>
          </div>
          {err && <div class="text-[var(--color-status-failed)]">{err}</div>}
          {plan && (
            <>
              <div>
                <div class="section-title mb-1">Sẽ tạo</div>
                <table class="table">
                  <thead><tr><th>Agent</th><th>Id</th><th>Kết quả</th></tr></thead>
                  <tbody>
                    {plan.agents.map((a) => (
                      <tr key={a.pkgId}>
                        <td>{a.name}{a.pkgId === plan.team.manager && <> <Pill tone="accent">trưởng nhóm</Pill></>}</td>
                        <td class="mono">{a.finalId}</td>
                        <td>{a.action === 'skip' ? <Pill tone="warn">giữ nguyên</Pill> : a.collision ? <Pill tone="info">tạo, đã đổi id</Pill> : <Pill tone="success">tạo mới</Pill>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {plan.schedules.length > 0 && <div><div class="section-title mb-1">Lịch (tạo ở trạng thái tắt)</div><ul class="m-0 list-disc pl-5">{plan.schedules.map((s) => <li key={s.id}>{s.name} · <span class="mono">{s.cron}</span> · {s.tz}{s.skipReason && <span class="hint"> ({s.skipReason})</span>}</li>)}</ul></div>}
              {plan.skills.length > 0 && <div><div class="section-title mb-1">Skill</div><ul class="m-0 list-disc pl-5">{plan.skills.map((s) => <li key={s.id}><span class="mono">{s.id}</span> {s.exists ? '· đã có, giữ bản hiện tại' : s.bundled ? '· thêm vào thư viện' : '· thiếu trong thư viện'}</li>)}</ul></div>}
              <p class="hint m-0">Agent mới ở chế độ an toàn và chưa có quyền nào (Second Brain, kết nối, module). Không có khoá hay token nào được ghi.</p>
              {plan.warnings.map((w) => <div key={w} class="text-[var(--color-status-review)]">{w}</div>)}
              {plan.blockers.map((b) => <div key={b} class="text-[var(--color-status-failed)]">{b}</div>)}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
