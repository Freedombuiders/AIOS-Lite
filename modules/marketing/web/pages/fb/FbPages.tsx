import { useEffect, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { Plus, RefreshCw, X } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Toggle } from '@/components/Toggle';
import { Card } from '@modules/marketing/web/components/fb/common';
import {
  apiFail, BTN, BTN_PRIMARY, BTN_SM, ConnDot, Field, FetchError, FbReadiness, INPUT, LABEL_CAPS, TEXTAREA, useFbPages,
} from '@modules/marketing/web/components/fb/ops-shared';
import { apiPatch, apiPost } from '@/lib/api';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import {
  fmtCompact, fmtInt, fmtPct,
  type FbPageDto, type FbPageUpdate, type FbPillar, type FbStatusDto,
} from '@modules/marketing/web/lib/fbstudio';

interface AgentOption { id: string; name: string }

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(-2).map((w) => w[0]!.toUpperCase()).join('') || 'FB';

export function FbPages() {
  const { pages, loading, error, refresh } = useFbPages();
  const status = useFetch<FbStatusDto>('/api/m/marketing/status', 120_000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const selected = pages.find((p) => p.id === selectedId) ?? pages[0] ?? null;

  async function patch(page: FbPageDto, body: FbPageUpdate, okTitle?: string) {
    setBusyId(page.id);
    try {
      await apiPatch<FbPageDto>(`/api/m/marketing/pages/${encodeURIComponent(page.id)}`, body);
      invalidateFetchCache('/api/m/marketing/');
      refresh();
      if (okTitle) pushToast({ tone: 'success', title: okTitle });
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không lưu được', description: apiFail(err).message });
    } finally {
      setBusyId(null);
    }
  }

  async function sync() {
    setSyncing(true);
    try {
      const res = await apiPost<{ pages: FbPageDto[] }>('/api/m/marketing/pages/sync');
      invalidateFetchCache('/api/m/marketing/');
      refresh();
      status.refresh();
      pushToast({ tone: 'success', title: `Đã đồng bộ ${res.pages.length} Page` });
    } catch (err) {
      const { status: code, message } = apiFail(err);
      pushToast({
        tone: 'error',
        title: code === 503 ? 'Composio chưa sẵn sàng' : 'Không đồng bộ được',
        description: code === 503 ? 'Nhập Composio API key ở Kết nối › Composio.' : message,
      });
    } finally {
      setSyncing(false);
    }
  }

  const conn = status.data?.composio;

  return (
    <div class="flex flex-col h-full min-h-0">
      <PageHeader
        breadcrumb="Marketing · Facebook"
        title="Cài đặt Page"
        actions={
          <>
            <button type="button" class={BTN} onClick={() => void sync()} disabled={syncing}>
              <RefreshCw size={13} class={syncing ? 'animate-spin' : ''} /> {syncing ? 'Đang đồng bộ…' : 'Đồng bộ danh sách Page'}
            </button>
            <a class={BTN_PRIMARY} href="https://app.composio.dev/" target="_blank" rel="noopener noreferrer">
              <Plus size={13} /> Kết nối tài khoản
            </a>
          </>
        }
      />
      <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-5 flex flex-col gap-4">
        <p class="text-[13px] text-[var(--color-text-muted)] -mb-1">
          Page lấy từ kết nối Composio. Mỗi Page có luật đăng và chế độ duyệt riêng.
        </p>
        <FbReadiness />

        <section
          aria-label="Kết nối Composio"
          class="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] text-[13px]"
        >
          {conn ? (
            <>
              <span class="inline-flex items-center gap-2">
                <ConnDot status={conn.facebook} /><strong class="font-semibold">Facebook</strong> {conn.facebook}
                {conn.facebook === 'ACTIVE' && ` · ${pages.length} Page`}
                {(conn.facebook === 'EXPIRED' || conn.facebook === 'MISSING') && (
                  <>
                    {' · '}
                    <a class="text-[var(--color-accent)] underline" href="https://app.composio.dev/" target="_blank" rel="noopener noreferrer">Kết nối lại</a>
                  </>
                )}
              </span>
              <span class="ml-auto text-[13px] text-[var(--color-text-faint)]">
                {conn.checkedAt ? `Kiểm tra lần cuối ${new Date(conn.checkedAt * 1000).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}` : 'Chưa kiểm tra'}
              </span>
            </>
          ) : status.error ? (
            <span class="text-[var(--color-text-muted)]">Chưa kiểm tra được kết nối Composio ({status.error}).</span>
          ) : (
            <span class="text-[var(--color-text-faint)]">Đang kiểm tra kết nối…</span>
          )}
        </section>

        {loading && pages.length === 0 && <PageState loading />}
        {error && pages.length === 0 && <FetchError error={error} onRetry={refresh} />}
        {!loading && !error && pages.length === 0 && (
          <PageState
            empty
            emptyTitle="Chưa có Page nào"
            emptyDescription="Bấm “Đồng bộ danh sách Page” để lấy Page từ các tài khoản Facebook đã kết nối với Composio. Page mới luôn ở trạng thái tắt cho đến khi bạn bật."
          />
        )}

        {pages.length > 0 && (
          <div class="flex flex-wrap gap-4 items-start">
            <section aria-label="Danh sách Page" class="flex-1 basis-[380px] min-w-0 flex flex-col gap-2.5">
              {pages.map((p) => (
                <PageCard
                  key={p.id}
                  page={p}
                  selected={selected?.id === p.id}
                  busy={busyId === p.id}
                  onSelect={() => setSelectedId(p.id)}
                  onEnabled={(v) => void patch(p, { enabled: v }, v ? `Đã bật ${p.name}` : `Đã tắt ${p.name}`)}
                  onApproval={(v) => void patch(p, { approvalRequired: v })}
                />
              ))}
            </section>
            {selected && (
              <PageForm key={selected.id} page={selected} saving={busyId === selected.id} onSave={(body) => patch(selected, body, 'Đã lưu cấu hình Page')} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PageCard({ page: p, selected, busy, onSelect, onEnabled, onApproval }: {
  page: FbPageDto; selected: boolean; busy: boolean;
  onSelect: () => void; onEnabled: (v: boolean) => void; onApproval: (v: boolean) => void;
}) {
  return (
    <article
      class={`rounded-lg border p-3.5 flex flex-col gap-3 ${
        selected ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-border)] bg-[var(--color-card)]'
      }`}
    >
      <div class="flex items-center gap-3">
        <button
          type="button"
          aria-pressed={selected}
          onClick={onSelect}
          class="flex items-center gap-3 min-w-0 flex-1 text-left rounded-md focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
        >
          {p.pictureUrl ? (
            <img src={p.pictureUrl} alt="" class="w-10 h-10 rounded-[10px] object-cover shrink-0 bg-[var(--color-elevated)]" />
          ) : (
            <span class="w-10 h-10 rounded-[10px] shrink-0 bg-[var(--color-elevated)] text-[13px] font-bold inline-flex items-center justify-center text-[var(--color-text)]">
              {initials(p.name)}
            </span>
          )}
          <span class="min-w-0">
            <span class="block text-[14px] font-semibold text-[var(--color-text)] truncate">{p.name}</span>
            <span class="flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
              <ConnDot status={p.status} />
              {p.followers !== null ? `${fmtCompact(p.followers)} người theo dõi` : 'Chưa có số người theo dõi'} · {p.status}
            </span>
          </span>
        </button>
        <label class="flex items-center gap-2 text-[13px] text-[var(--color-text-muted)] shrink-0">
          {p.enabled ? 'Đang bật' : 'Đang tắt'}
          <Toggle on={p.enabled} disabled={busy} ariaLabel={`Bật Page ${p.name}`} onChange={() => onEnabled(!p.enabled)} />
        </label>
      </div>

      {!p.enabled && (
        <div class="text-[13px] text-[var(--color-text-muted)]">
          Page chưa bật: Kho, Lịch và Bình luận AI chưa dùng Page này. Bật công tắc bên trên để bắt đầu.
        </div>
      )}
      {(p.status === 'EXPIRED' || p.status === 'MISSING') && (
        <div class="text-[13px] text-[var(--color-status-failed)]">Kết nối Composio của Page đã hết hạn. Kết nối lại tài khoản để tiếp tục đăng.</div>
      )}

      <div class="grid grid-cols-3 gap-2">
        <Stat label="Tuần này" value={`${fmtInt(p.stats.postsThisWeek)} / ${fmtInt(p.stats.scheduledThisWeek)}`} hint="đã đăng / đã xếp" />
        <Stat label="ER 28 ngày" value={fmtPct(p.stats.er28d)} />
        <Stat label="AI trả lời 24 giờ" value={fmtInt(p.stats.aiReplies24h)} />
      </div>

      <div class="flex items-center gap-3">
        <Toggle on={p.approvalRequired} disabled={busy} ariaLabel={`Bài do agent làm cần duyệt: ${p.name}`} onChange={() => onApproval(!p.approvalRequired)} />
        <div class="min-w-0">
          <div class="text-[13px] font-semibold text-[var(--color-text)]">{p.approvalRequired ? 'Cần duyệt trước khi đăng' : 'Tự đăng'}</div>
          <div class="text-[13px] text-[var(--color-text-muted)]">
            {p.approvalRequired ? 'Bài agent làm vào hàng chờ duyệt' : 'Agent làm xong là vào lịch'}
          </div>
        </div>
      </div>
    </article>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div class="px-2.5 py-2 rounded-md bg-[var(--color-bg)] min-w-0" title={hint}>
      <div class="text-[11.5px] text-[var(--color-text-muted)] truncate">{label}</div>
      <div class="text-[14px] font-semibold tabular-nums text-[var(--color-text)]">{value}</div>
    </div>
  );
}

function PageForm({ page, saving, onSave }: { page: FbPageDto; saving: boolean; onSave: (body: FbPageUpdate) => Promise<void> }) {
  const agents = useFetch<{ agents: AgentOption[] }>('/api/agents', 60_000);
  const agentList = agents.data?.agents ?? [];

  const [d, setD] = useState(() => fromPage(page));
  // Pick up server-side changes (toggle, sync) without clobbering edits in progress.
  useEffect(() => { setD(fromPage(page)); }, [page.syncedAt, page.maxPostsPerDay, page.minGapMinutes, page.windowStart, page.windowEnd, page.graceMinutes, page.brandVoice, page.writerAgent, page.videoAgent, page.role, page.mainKpi, JSON.stringify(page.pillars)]);

  const set = <K extends keyof typeof d>(k: K, v: (typeof d)[K]) => setD((prev) => ({ ...prev, [k]: v }));
  const pctTotal = d.pillars.reduce((a, p) => a + (Number(p.targetPct) || 0), 0);
  const valid = d.maxPostsPerDay >= 1 && d.minGapHours >= 0 && d.graceMinutes >= 0 && /^\d{2}:\d{2}$/.test(d.windowStart) && /^\d{2}:\d{2}$/.test(d.windowEnd) && d.windowStart < d.windowEnd;

  function submit(e: Event) {
    e.preventDefault();
    if (!valid) return;
    void onSave({
      maxPostsPerDay: d.maxPostsPerDay,
      minGapMinutes: Math.round(d.minGapHours * 60),
      windowStart: d.windowStart,
      windowEnd: d.windowEnd,
      graceMinutes: d.graceMinutes,
      brandVoice: d.brandVoice,
      role: d.role,
      mainKpi: d.mainKpi,
      pillars: d.pillars.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), targetPct: Number(p.targetPct) || 0 })),
      writerAgent: d.writerAgent,
      videoAgent: d.videoAgent,
    });
  }

  const agentSelect = (value: string, onChange: (v: string) => void, label: string) => {
    const ids = agentList.map((a) => a.id);
    if (value && !ids.includes(value)) ids.unshift(value);
    if (!ids.includes('main')) ids.push('main');
    return (
      <Field label={label}>
        <select class={INPUT} value={value || 'main'} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
          {ids.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </Field>
    );
  };

  return (
    <form
      onSubmit={submit}
      aria-label={`Cấu hình ${page.name}`}
      class="flex-[999_1_520px] basis-[520px] min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4 md:p-5 flex flex-col gap-5"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-[16px] font-semibold text-[var(--color-text)]">Cấu hình · {page.name}</h2>
        <span class="text-[13px] text-[var(--color-text-muted)]">Múi giờ {page.timezone || 'Asia/Ho_Chi_Minh'}</span>
      </div>

      <fieldset class="flex flex-col gap-2.5 border-0 p-0 m-0 min-w-0">
        <legend class={`${LABEL_CAPS} pb-2`}>Nhịp đăng</legend>
        <div class="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
          <Field label="Tối đa bài mỗi ngày">
            <input type="number" min={1} class={INPUT} value={d.maxPostsPerDay} onInput={(e) => set('maxPostsPerDay', Number((e.target as HTMLInputElement).value))} />
          </Field>
          <Field label="Cách nhau tối thiểu (giờ)">
            <input type="number" min={0} step={0.5} class={INPUT} value={d.minGapHours} onInput={(e) => set('minGapHours', Number((e.target as HTMLInputElement).value))} />
          </Field>
          <Field label="Được đăng từ">
            <input type="time" class={INPUT} value={d.windowStart} onInput={(e) => set('windowStart', (e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Đến">
            <input type="time" class={INPUT} value={d.windowEnd} onInput={(e) => set('windowEnd', (e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Ân hạn khi app tắt (phút)" hint="Quá hạn này bài chuyển “Lỡ giờ”, không đăng muộn.">
            <input type="number" min={0} class={INPUT} value={d.graceMinutes} onInput={(e) => set('graceMinutes', Number((e.target as HTMLInputElement).value))} />
          </Field>
        </div>
        {d.windowStart >= d.windowEnd && <div class="text-[13px] text-[var(--color-status-failed)]">Giờ bắt đầu phải sớm hơn giờ kết thúc.</div>}
      </fieldset>

      <div class="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
        <Field label="Vai trò của Page">
          <input class={INPUT} value={d.role} placeholder="Ví dụ: Thương hiệu, cá nhân, khóa học" onInput={(e) => set('role', (e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Chỉ số chính">
          <input class={INPUT} value={d.mainKpi} placeholder="Ví dụ: reach, ER, lead" onInput={(e) => set('mainKpi', (e.target as HTMLInputElement).value)} />
        </Field>
      </div>

      <label class="flex flex-col gap-1.5">
        <span class={LABEL_CAPS}>Giọng thương hiệu</span>
        <textarea rows={3} class={TEXTAREA} value={d.brandVoice} onInput={(e) => set('brandVoice', (e.target as HTMLTextAreaElement).value)} />
      </label>

      <fieldset class="flex flex-col gap-2 border-0 p-0 m-0 min-w-0">
        <legend class={`${LABEL_CAPS} pb-2`}>Trụ cột nội dung · tỷ lệ mục tiêu</legend>
        {d.pillars.length === 0 && <div class="text-[13px] text-[var(--color-text-faint)]">Chưa có trụ cột nào. Agent dùng trụ cột này để gắn nhãn và cân bằng nội dung.</div>}
        {d.pillars.map((p, i) => (
          <div key={i} class="grid grid-cols-[minmax(0,1fr)_minmax(60px,1fr)_72px_32px] sm:grid-cols-[150px_1fr_72px_32px] gap-2 items-center text-[13px]">
            <input
              class={INPUT}
              aria-label={`Tên trụ cột ${i + 1}`}
              value={p.name}
              onInput={(e) => set('pillars', d.pillars.map((x, j) => (j === i ? { ...x, name: (e.target as HTMLInputElement).value } : x)))}
            />
            <div class="h-1.5 rounded-full bg-[var(--color-border)]" aria-hidden="true">
              <div class="h-1.5 rounded-full bg-[var(--color-accent)]" style={{ width: `${Math.max(0, Math.min(100, p.targetPct))}%` }} />
            </div>
            <label class="flex items-center gap-1 text-[13px] text-[var(--color-text-muted)]">
              <input
                type="number"
                min={0}
                max={100}
                class={`${INPUT} w-14 h-8 px-1.5`}
                aria-label={`Tỷ lệ ${p.name || `trụ cột ${i + 1}`}`}
                value={p.targetPct}
                onInput={(e) => set('pillars', d.pillars.map((x, j) => (j === i ? { ...x, targetPct: Number((e.target as HTMLInputElement).value) } : x)))}
              />
              %
            </label>
            <button
              type="button"
              aria-label={`Xóa trụ cột ${p.name || i + 1}`}
              class="w-8 h-8 inline-flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-control-hover)] hover:text-[var(--color-text)]"
              onClick={() => set('pillars', d.pillars.filter((_, j) => j !== i))}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <div class="flex flex-wrap items-center gap-3">
          <button type="button" class={BTN_SM} onClick={() => set('pillars', [...d.pillars, { name: '', targetPct: 0 }])}>
            <Plus size={12} class="mr-1" /> Thêm trụ cột
          </button>
          {d.pillars.length > 0 && (
            <span class={`text-[13px] ${pctTotal === 100 ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-priority-medium)]'}`}>
              Tổng {pctTotal}%{pctTotal !== 100 && ' (nên bằng 100%)'}
            </span>
          )}
        </div>
      </fieldset>

      <fieldset class="flex flex-col gap-2 border-0 p-0 m-0 min-w-0">
        <legend class={`${LABEL_CAPS} pb-2`}>Agent phụ trách</legend>
        <div class="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
          {agentSelect(d.writerAgent, (v) => set('writerAgent', v), 'Viết bài')}
          {agentSelect(d.videoAgent, (v) => set('videoAgent', v), 'Video, Reels')}
        </div>
        <p class="m-0 text-[13px] text-[var(--color-text-faint)]">
          Agent chọn từ Workspace › Agents. Agent trả lời bình luận chọn ở{' '}
          <Link href="/m/marketing/comment-rules" class="text-[var(--color-accent)] underline">Bình luận AI › Cấu hình</Link>.
        </p>
      </fieldset>

      <Card title="Thu dữ liệu">
        <div class="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(220px,1fr))] text-[12.5px]">
          <div class="flex flex-col gap-1.5 text-[13px] text-[var(--color-text-muted)]">
            Bình luận
            <div class="min-h-9 flex items-center px-2.5 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[12.5px]">
              <Link href="/m/marketing/comment-rules" class="text-[var(--color-accent)] underline">Thu và tự trả lời: cấu hình ở Bình luận AI</Link>
            </div>
          </div>
          <div class="flex flex-col gap-1.5 text-[13px] text-[var(--color-text-muted)]">
            Thu số liệu
            <div class="min-h-9 flex items-center px-2.5 py-1.5 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-[12.5px]">
              02:00 hằng ngày + mốc 1 giờ, 6 giờ, 24 giờ, 3, 7, 28 ngày
            </div>
          </div>
        </div>
      </Card>

      <div class="flex flex-wrap justify-end gap-2">
        <button type="button" class={BTN} onClick={() => setD(fromPage(page))} disabled={saving}>Hủy thay đổi</button>
        <button type="submit" class={BTN_PRIMARY} disabled={saving || !valid}>{saving ? 'Đang lưu…' : 'Lưu thay đổi'}</button>
      </div>
    </form>
  );
}

function fromPage(p: FbPageDto) {
  return {
    maxPostsPerDay: p.maxPostsPerDay,
    minGapHours: Math.round((p.minGapMinutes / 60) * 100) / 100,
    windowStart: p.windowStart,
    windowEnd: p.windowEnd,
    graceMinutes: p.graceMinutes,
    brandVoice: p.brandVoice,
    role: p.role,
    mainKpi: p.mainKpi,
    pillars: p.pillars.map((x): FbPillar => ({ ...x })),
    writerAgent: p.writerAgent,
    videoAgent: p.videoAgent,
  };
}
