import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import type { AuditEntry } from '@core/types';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { qs } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useDebouncedValue } from '@/lib/useDebounce';
import { useFetch } from '@/lib/useFetch';

function Row({ e }: { e: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const denied = e.action.includes('denied');
  return (
    <>
      <tr class="cursor-pointer hover:bg-[var(--color-control-hover)]" onClick={() => e.detail && setOpen(!open)}>
        <td class="whitespace-nowrap">{formatDateTime(e.ts)}</td>
        <td>{e.actor}</td>
        <td><Pill tone={denied ? 'error' : 'neutral'}>{e.action}</Pill></td>
        <td class="mono max-w-xs truncate">{e.target ?? '—'}</td>
        <td>{e.runId ? <Link href={`/runs/${e.runId}`} onClick={(ev) => ev.stopPropagation()}>#{e.runId}</Link> : <span class="hint">—</span>}</td>
        <td class="hint">{e.detail ? (open ? 'thu gọn' : 'chi tiết') : ''}</td>
      </tr>
      {open && e.detail && <tr><td colSpan={6} class="bg-[var(--color-bg)]"><pre class="mono m-0 text-[11px] whitespace-pre-wrap">{JSON.stringify(e.detail, null, 2)}</pre></td></tr>}
    </>
  );
}

export default function AuditPage() {
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [since, setSince] = useState('');
  const dActor = useDebouncedValue(actor.trim(), 300);
  const dAction = useDebouncedValue(action.trim(), 300);
  const f = useFetch<{ items: AuditEntry[] }>(`/audit${qs({ actor: dActor, action: dAction, since: since ? new Date(since).toISOString() : '', limit: 200 })}`);
  const items = f.data?.items ?? [];
  const filtered = !!(dActor || dAction || since);
  return (
    <div class="page">
      <PageHeader title="Nhật ký" />
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <input class="field" style={{ width: 180 }} placeholder="Người làm (user, agent:main…)" value={actor} onInput={(e) => setActor((e.target as HTMLInputElement).value)} aria-label="Lọc theo người làm" />
        <input class="field" style={{ width: 180 }} placeholder="Hành động (brain.write…)" value={action} onInput={(e) => setAction((e.target as HTMLInputElement).value)} aria-label="Lọc theo hành động" />
        <label class="flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">Từ ngày <input class="field" style={{ width: 150 }} type="date" value={since} onInput={(e) => setSince((e.target as HTMLInputElement).value)} /></label>
        {filtered && <button type="button" class="control-button control-sm" onClick={() => { setActor(''); setAction(''); setSince(''); }}>Xoá bộ lọc</button>}
      </div>
      <PageState loading={f.loading && !f.data} error={f.error} empty={!!f.data && items.length === 0} emptyTitle={filtered ? 'Không có bản ghi khớp bộ lọc' : 'Nhật ký còn trống'} emptyDescription="Mọi thao tác nhạy cảm (đọc/ghi brain, bị chặn quyền, thêm module…) sẽ được ghi lại ở đây." />
      {items.length > 0 && (
        <div class="card overflow-x-auto">
          <table class="table">
            <thead><tr><th>Thời gian</th><th>Người làm</th><th>Hành động</th><th>Đối tượng</th><th>Lượt</th><th /></tr></thead>
            <tbody>{items.map((e) => <Row key={e.id} e={e} />)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
