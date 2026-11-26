// "Vòng học · Chờ duyệt" (drawing Learn.dc.html): what waits for the owner — new lessons bots proposed, and state
// changes the machine proposes from the trial numbers. Nothing here happens until the owner presses a button.
import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { PageState } from '@/components/PageState';
import { apiPost, errorText } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import { pct, postHref } from '@modules/learn/web/lib/format';
import { loopChanged, LoopHeader, STATE_LABEL, StatePill, useLoopFetch, whenText, who } from '@modules/learn/web/lib/loop';
import type { ProposalView } from '@modules/learn/web/lib/types';

function heading(p: ProposalView): string {
  if (p.kind === 'new') return 'Bài học mới';
  if (p.to === 'da-kiem-chung') return 'Đề xuất kiểm chứng';
  if (p.to === 'bi-bac-bo') return 'Đề xuất bác bỏ';
  return `Đề xuất chuyển sang ${p.to ? STATE_LABEL[p.to] : '…'}`;
}

function acceptLabel(p: ProposalView): string {
  if (p.kind === 'new') return 'Giữ làm giả thuyết';
  if (p.to === 'da-kiem-chung') return 'Duyệt: đã kiểm chứng';
  if (p.to === 'bi-bac-bo') return 'Đồng ý bác bỏ';
  return 'Đồng ý';
}

function Item({ p }: { p: ProposalView }) {
  const [busy, setBusy] = useState('');
  const act = async (verb: 'accept' | 'dismiss') => {
    setBusy(verb);
    try {
      await apiPost(`/api/m/learn/pending/${p.id}/${verb}`);
      pushToast({ tone: 'success', title: verb === 'accept' ? 'Đã duyệt' : 'Đã bỏ qua' });
      loopChanged();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Chưa làm được', description: errorText(e) });
    } finally {
      setBusy('');
    }
  };
  const t = p.lesson?.trial;
  return (
    <li class="card card-pad flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-[14px] font-semibold">{heading(p)}</span>
        <span class="text-[12px] text-[var(--color-text-muted)]">{who(p.proposedBy)} · {whenText(p.createdAt)}</span>
        {p.from && <StatePill state={p.from} />}
        {p.to && p.kind === 'transition' && <><span aria-hidden="true">→</span><StatePill state={p.to} /></>}
      </div>
      <p class="m-0 text-[14px]">{p.title}</p>
      {p.reason && <p class="m-0 text-[12.5px] text-[var(--color-text-muted)]">{p.reason}</p>}
      {t && t.recent.length > 0 && (
        <ul class="m-0 list-none p-0 text-[12.5px]">
          {t.recent.map((r) => (
            <li key={r.path}><Link href={postHref(r.path)}>{r.title}</Link> · ER {pct(r.er)}{r.below === true ? ' · dưới trung vị' : r.below === false ? ' · trên trung vị' : ''}</li>
          ))}
        </ul>
      )}
      {p.kind === 'transition' && p.to === 'da-kiem-chung' && (
        <p class="m-0 text-[12px] text-[var(--color-text-faint)]">Duyệt xong, bot có tên trong <code>dung_boi</code> của bài học sẽ đọc nó trước khi viết. Vài bài thử chỉ là thăm dò, không phải bằng chứng chắc chắn.</p>
      )}
      <span class="text-[12px] text-[var(--color-text-faint)]">Ghi chú: <code>{p.path}</code></span>
      <div class="flex flex-wrap gap-2">
        <button type="button" class="control-button control-accent" disabled={!!busy} onClick={() => void act('accept')}>{busy === 'accept' ? 'Đang duyệt…' : acceptLabel(p)}</button>
        <button type="button" class="control-button" disabled={!!busy} onClick={() => void act('dismiss')}>{p.kind === 'new' ? 'Bỏ (chuyển sang bị bác bỏ)' : 'Bỏ qua'}</button>
      </div>
    </li>
  );
}

export function Pending() {
  const { data, loading, error } = useLoopFetch<{ items: ProposalView[] }>('/api/m/learn/pending', 60_000);
  const items = data?.items ?? [];
  return (
    <div class="flex flex-col gap-4">
      <LoopHeader title="Chờ duyệt" />
      <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Bạn quyết định điều gì được vào sổ bài học. Bot chỉ đề xuất; không bot nào tự đổi được trạng thái bài học.</p>
      <PageState loading={loading && !data} error={error} empty={!!data && items.length === 0} emptyTitle="Không có gì chờ duyệt" emptyDescription="Khi bot đề xuất bài học mới, hay máy thấy một bài học đang thử đã đủ bài để kết luận, nó sẽ hiện ở đây." />
      {items.length > 0 && (
        <ul class="m-0 flex list-none flex-col gap-3 p-0">
          {items.map((p) => <Item key={p.id} p={p} />)}
        </ul>
      )}
    </div>
  );
}
