// Header of the Dream 100 pages: title, the two sections, and the setup bar (notes folder, labelling agent, tools).
import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { apiPut, errorText } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import { useFetch, type FetchState } from '@/lib/useFetch';
import type { Overview } from './lib';

const SEG = 'inline-flex items-center min-h-[36px] px-3 rounded-md text-[13px] font-semibold no-underline';
const SEG_ON = 'bg-[var(--color-accent)] text-[var(--color-on-accent)]';
const SEG_OFF = 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]';
const SELECT =
  'h-9 px-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[13px] text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none min-w-0';

export function useOverview(): FetchState<Overview> {
  return useFetch<Overview>('/api/m/dream/overview');
}

export function DreamHeader({ active, overview, aside }: { active: 'channels' | 'videos'; overview: FetchState<Overview>; aside?: string }) {
  return (
    <header class="mb-4 flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-3">
        <h1 class="m-0 text-[20px] font-bold">Dream 100</h1>
        <nav aria-label="Các phần của Dream 100" class="flex flex-wrap gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-1">
          <Link href="/m/dream" class={`${SEG} ${active === 'channels' ? SEG_ON : SEG_OFF}`} aria-current={active === 'channels' ? 'page' : undefined}>Kênh theo dõi</Link>
          <Link href="/m/dream/videos" class={`${SEG} ${active === 'videos' ? SEG_ON : SEG_OFF}`} aria-current={active === 'videos' ? 'page' : undefined}>Video đã phân tích</Link>
        </nav>
        {aside && <span class="text-[13px] text-[var(--color-text-muted)]">{aside}</span>}
      </div>
      <SetupBar overview={overview} />
    </header>
  );
}

function SetupBar({ overview }: { overview: FetchState<Overview> }) {
  const folders = useFetch<{ items: { id: string; name: string }[] }>('/api/brain/folders');
  const [saving, setSaving] = useState(false);
  const o = overview.data;
  if (!o) return null;

  async function save(patch: { brainFolder?: string; analystAgent?: string }) {
    setSaving(true);
    try {
      await apiPut('/api/m/dream/settings', patch);
      overview.refresh();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Chưa lưu được', description: errorText(e) });
    } finally {
      setSaving(false);
    }
  }

  const missing = o.tools.filter((t) => !t.path);
  const installs = [...new Set(missing.map((t) => t.fix).filter(Boolean))] as string[];
  return (
    <div class="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3 text-[13px]">
      <div class="flex flex-wrap items-center gap-x-5 gap-y-2">
        <label class="flex flex-wrap items-center gap-2">
          <span class="text-[var(--color-text-muted)]">Ghi chú vào thư mục</span>
          <select class={SELECT} value={o.folder ?? ''} disabled={saving} onChange={(e) => void save({ brainFolder: (e.target as HTMLSelectElement).value })}>
            <option value="">Chọn thư mục Second Brain…</option>
            {(folders.data?.items ?? []).map((f) => <option key={f.id} value={f.id}>{f.name || f.id}</option>)}
          </select>
          {o.folder && <code class="text-[12px] text-[var(--color-text-faint)]">{o.folder}/dream-100/</code>}
        </label>
        <label class="flex flex-wrap items-center gap-2">
          <span class="text-[var(--color-text-muted)]">Agent gắn nhãn</span>
          <select class={SELECT} value={o.agent?.id ?? ''} disabled={saving} onChange={(e) => void save({ analystAgent: (e.target as HTMLSelectElement).value })}>
            {o.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      </div>
      {o.folderError && <p class="m-0 text-[var(--color-status-failed)]">{o.folderError}</p>}
      {o.agent && !o.agent.images && (
        <p class="m-0 text-[var(--color-text-muted)]">Agent này không nhận ảnh (ví dụ agent chạy trên GenBot), nên chỉ phân tích bằng phụ đề. Video không có phụ đề sẽ ghi "thiếu dữ liệu".</p>
      )}
      {missing.length > 0 && (
        <p class="m-0 text-[var(--color-status-review,#f0b24a)]">
          Máy chưa có {missing.map((t) => t.tool).join(', ')}: chưa phân tích được video. Mở Terminal và chạy{' '}
          {installs.map((c, i) => <span key={c}>{i > 0 && ' và '}<code>{c}</code></span>)}.
        </p>
      )}
    </div>
  );
}
