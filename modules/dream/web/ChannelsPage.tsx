// Kênh theo dõi: the reference channels the owner wants to learn from (up to 100). No automatic scanning.
import { useState } from 'preact/hooks';
import { PageState } from '@/components/PageState';
import { apiDelete, apiPatch, apiPost, errorText } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';
import { DreamHeader, useOverview } from './DreamHeader';
import { PLATFORM_LABEL, type Channel } from './lib';

const INPUT =
  'px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[13px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none min-w-0';
const BTN_PRIMARY =
  'inline-flex items-center justify-center min-h-[40px] px-4 rounded-md bg-[var(--color-accent)] text-[13px] font-semibold text-[var(--color-on-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40 border-0 cursor-pointer';
const BTN_SM =
  'inline-flex items-center justify-center h-8 px-2.5 rounded-md border border-[var(--color-border-strong)] bg-transparent text-[12px] text-[var(--color-text)] hover:bg-[var(--color-control-hover)] disabled:opacity-40 cursor-pointer';

interface AddResult {
  added: Channel[];
  skipped: { input: string; reason: string }[];
}

export function ChannelsPage() {
  const overview = useOverview();
  const list = useFetch<{ items: Channel[]; max: number }>('/api/m/dream/channels');
  const [text, setText] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState<AddResult['skipped']>([]);

  const items = list.data?.items ?? [];
  const max = list.data?.max ?? 100;
  const byPlatform = Object.entries(items.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.platform]: (acc[c.platform] ?? 0) + 1 }), {}))
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${PLATFORM_LABEL[p] ?? p} ${n}`)
    .join(' · ');

  async function add() {
    setBusy(true);
    setSkipped([]);
    try {
      const r = await apiPost<AddResult>('/api/m/dream/channels', { text, why });
      setSkipped(r.skipped);
      if (r.added.length) {
        pushToast({ tone: 'success', title: `Đã thêm ${r.added.length} kênh` });
        setText('');
        setWhy('');
      }
      list.refresh();
      overview.refresh();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Chưa thêm được kênh', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="flex flex-col gap-4">
      <DreamHeader active="channels" overview={overview} />
      <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Những kênh bạn muốn học theo. Bản này chưa tự quét kênh: khi thấy một video đáng học, dán link ở trang Video đã phân tích.</p>

      <section class="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-4">
        <div class="flex flex-wrap items-baseline gap-3">
          <span class="text-[28px] font-bold leading-none">{items.length}</span>
          <span class="text-[var(--color-text-muted)]">/ {max} kênh</span>
          {byPlatform && <span class="text-[13px] text-[var(--color-text-muted)]">{byPlatform}</span>}
        </div>
        <label class="flex flex-col gap-1">
          <span class="text-[12px] text-[var(--color-text-muted)]">Dán link kênh, hoặc dán cả danh sách mỗi dòng một link</span>
          <textarea class={`${INPUT} min-h-[72px] resize-y`} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} placeholder="https://www.tiktok.com/@kenh-mau" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[12px] text-[var(--color-text-muted)]">Học gì ở kênh này</span>
          <input class={`${INPUT} h-10`} value={why} onInput={(e) => setWhy((e.target as HTMLInputElement).value)} placeholder="Ví dụ: cách mở đầu bằng câu hỏi, nhịp cắt nhanh" />
        </label>
        <div class="flex flex-wrap items-center gap-3">
          <button type="button" class={BTN_PRIMARY} disabled={busy || !text.trim() || items.length >= max} onClick={() => void add()}>Thêm kênh</button>
          {items.length >= max && <span class="text-[13px] text-[var(--color-text-muted)]">Đã đủ {max} kênh. Xoá bớt kênh cũ để thêm kênh mới.</span>}
        </div>
        {skipped.length > 0 && (
          <ul class="m-0 flex flex-col gap-1 pl-4 text-[12.5px] text-[var(--color-text-muted)]">
            {skipped.map((s) => <li key={s.input}><code>{s.input}</code>: {s.reason}</li>)}
          </ul>
        )}
      </section>

      <section class="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-4">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="m-0 text-[15px] font-semibold">Kênh đang theo dõi</h2>
          {overview.data?.folder && <code class="text-[12px] text-[var(--color-text-faint)]">{overview.data.folder}/dream-100/kenh/</code>}
        </div>
        {(list.loading || list.error || items.length === 0) && (
          <PageState loading={list.loading} error={list.error} empty={!list.loading && !list.error && items.length === 0} emptyTitle="Chưa có kênh nào" emptyDescription="Dán link kênh muốn học theo ở ô bên trên." />
        )}
        {items.length > 0 && (
          <div class="overflow-x-auto">
            <table class="w-full min-w-[640px] border-collapse text-[13px]">
              <thead>
                <tr class="text-left text-[12px] text-[var(--color-text-muted)]">
                  <th class="py-2 pr-3 font-medium">Kênh</th>
                  <th class="py-2 pr-3 font-medium">Nền tảng</th>
                  <th class="py-2 pr-3 font-medium">Học gì ở kênh này</th>
                  <th class="py-2 pr-3 font-medium">Video đã phân tích</th>
                  <th class="py-2 font-medium"><span class="sr-only">Thao tác</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => <ChannelRow key={c.id} c={c} onChange={() => { list.refresh(); overview.refresh(); }} />)}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p class="m-0 text-[12.5px] text-[var(--color-text-muted)]">Chỉ đọc video công khai. Bot học cấu trúc và nhịp, không chép lời, hình hay nhạc của kênh khác.</p>
    </div>
  );
}

function ChannelRow({ c, onChange }: { c: Channel; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [why, setWhy] = useState(c.why ?? '');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await apiPatch(`/api/m/dream/channels/${c.id}`, { why });
      setEditing(false);
      onChange();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Chưa lưu được', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await apiDelete(`/api/m/dream/channels/${c.id}`);
      pushToast({ tone: 'info', title: `Đã bỏ theo dõi ${c.handle}`, description: 'Ghi chú của kênh vẫn còn trong Second Brain.' });
      onChange();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Chưa xoá được', description: errorText(e) });
      setBusy(false);
    }
  }

  return (
    <tr class="border-t border-[var(--color-border)] align-top">
      <td class="py-2.5 pr-3">
        <a href={c.url} target="_blank" rel="noreferrer noopener" class="font-semibold">{c.handle}</a>
        {c.note_path && <div class="text-[11.5px] text-[var(--color-text-faint)]">{c.note_path}</div>}
      </td>
      <td class="py-2.5 pr-3">{PLATFORM_LABEL[c.platform] ?? c.platform}</td>
      <td class="py-2.5 pr-3">
        {editing ? (
          <div class="flex flex-wrap gap-2">
            <input class={`${INPUT} h-8 flex-1`} value={why} aria-label={`Học gì ở kênh ${c.handle}`} onInput={(e) => setWhy((e.target as HTMLInputElement).value)} />
            <button type="button" class={BTN_SM} disabled={busy} onClick={() => void save()}>Lưu</button>
          </div>
        ) : (
          <button type="button" class="cursor-pointer border-0 bg-transparent p-0 text-left text-[13px] text-[var(--color-text)]" onClick={() => setEditing(true)} title="Bấm để sửa">
            {c.why || <span class="text-[var(--color-text-faint)]">(chưa ghi, bấm để thêm)</span>}
          </button>
        )}
      </td>
      <td class="py-2.5 pr-3">{c.videos}</td>
      <td class="py-2.5 text-right">
        <button type="button" class={BTN_SM} disabled={busy} onClick={() => void remove()}>Bỏ theo dõi</button>
      </td>
    </tr>
  );
}
