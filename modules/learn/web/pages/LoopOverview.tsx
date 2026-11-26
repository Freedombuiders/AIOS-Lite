// "Vòng học · Tổng quan" (drawing Loop.dc.html): the four steps of the loop, the two weekly measures, lessons
// that changed state this week and lessons on trial. Every number comes from /api/m/learn/loop.
import { Link } from 'wouter-preact';
import { PageState } from '@/components/PageState';
import { pct } from '@modules/learn/web/lib/format';
import { LoopHeader, NoFolder, StatePill, useLoopFetch, who } from '@modules/learn/web/lib/loop';
import type { LoopDto, WeekPoint } from '@modules/learn/web/lib/types';

function Step({ n, title, big, text, last }: { n: number; title: string; big: string; text: string; last?: boolean }) {
  return (
    <>
      <div class="card card-pad flex min-w-0 flex-[1_1_200px] flex-col gap-1">
        <span class="text-[11.5px] font-semibold tracking-wide text-[var(--color-text-muted)]">{n} · {title}</span>
        <span class="text-[18px] font-semibold">{big}</span>
        <span class="text-[12.5px] text-[var(--color-text-muted)]">{text}</span>
      </div>
      {!last && <span aria-hidden="true" class="hidden self-center text-[var(--color-text-faint)] md:inline">›</span>}
    </>
  );
}

function WeekBars({ title, sub, weeks, value, fmt, empty }: {
  title: string;
  sub: string;
  weeks: WeekPoint[];
  value: (w: WeekPoint) => number | null;
  fmt: (v: number) => string;
  empty: string;
}) {
  const vals = weeks.map(value);
  const known = vals.filter((v): v is number => v !== null);
  const max = Math.max(...known, 0);
  const first = known[0];
  const last = known.at(-1);
  return (
    <section class="card card-pad flex min-w-0 flex-[1_1_320px] flex-col gap-2">
      <div>
        <h2 class="m-0 text-[15px] font-semibold">{title}</h2>
        <span class="text-[12.5px] text-[var(--color-text-muted)]">{sub}</span>
      </div>
      {known.length === 0 ? (
        <p class="m-0 py-6 text-center text-[12.5px] text-[var(--color-text-faint)]">{empty}</p>
      ) : (
        <>
          <div class="flex h-[110px] items-end gap-1.5" role="img" aria-label={`${title}: ${weeks.map((w, i) => `tuần ${w.week} ${vals[i] === null ? 'chưa có' : fmt(vals[i]!)}`).join(', ')}`}>
            {weeks.map((w, i) => {
              const v = vals[i];
              const h = v === null || max <= 0 ? 0 : Math.max(4, Math.round((v / max) * 92));
              const edge = i === 0 || i === weeks.length - 1;
              return (
                <div key={`${w.year}-${w.week}`} class="flex min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`Tuần ${w.week}: ${v === null ? 'chưa có số' : fmt(v)}`}>
                  {edge && v !== null && <span class="text-[11px] text-[var(--color-text-muted)]">{fmt(v)}</span>}
                  <div
                    class="w-full rounded-t"
                    style={{ height: `${h}px`, background: v === null ? 'transparent' : w.running ? 'color-mix(in srgb, var(--color-accent) 55%, transparent)' : 'var(--color-accent)', border: v === null ? '1px dashed var(--color-border)' : 'none', minHeight: v === null ? '8px' : undefined }}
                  />
                </div>
              );
            })}
          </div>
          <div class="flex justify-between text-[11.5px] text-[var(--color-text-faint)]">
            <span>Tuần {weeks[0]!.week}</span>
            <span>Tuần {weeks.at(-1)!.week} (đang chạy)</span>
          </div>
          {first !== undefined && last !== undefined && known.length > 1 && (
            <p class="m-0 text-[12.5px] text-[var(--color-text-muted)]">Từ {fmt(first)} đến {fmt(last)}. Số tuần chỉ cho thấy xu hướng, không nói vì sao.</p>
          )}
        </>
      )}
    </section>
  );
}

export function LoopOverview() {
  const { data, loading, error } = useLoopFetch<LoopDto>('/api/m/learn/loop', 60_000);
  const c = data?.counts;
  return (
    <div class="flex flex-col gap-4">
      <LoopHeader title="Vòng học" />
      <PageState loading={loading && !data} error={error} />
      {data && !data.folder && <NoFolder />}
      {data && data.folder && c && (
        <>
          <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Đội AI có đang giỏi lên không, và giỏi lên nhờ đâu.</p>
          <div class="flex flex-wrap items-stretch gap-2">
            <Step n={1} title="LÀM" big={`${data.posts} bài`} text="Bài Facebook đã đăng qua Kho nội dung, mỗi bài là một ghi chú." />
            <Step n={2} title="ĐO" big={`${data.measuredPosts} bài đã có số đo`} text="Số liệu tự về ở các mốc 1 giờ, 24 giờ, 7 ngày…" />
            <Step
              n={3}
              title="RÚT BÀI HỌC"
              big={`${data.lessons} bài học`}
              text={`${c['da-kiem-chung']} đã kiểm chứng, ${c['dang-thu']} đang thử, ${c['gia-thuyet']} giả thuyết, ${c['bi-bac-bo']} bị bác bỏ.`}
            />
            <Step n={4} title="ÁP DỤNG" big={`${data.inUse} bài học đang dùng`} text="Bot đọc bài học bạn đã duyệt trước khi viết và trả lời." last />
          </div>
          <div class="flex flex-wrap gap-4">
            <WeekBars
              title="Bài đăng có tốt lên không"
              sub={`ER trung vị của bài đăng theo tuần, mốc ${data.mocLabel}, 8 tuần gần nhất`}
              weeks={data.weeks}
              value={(w) => w.medianEr}
              fmt={(v) => pct(v)}
              empty="Chưa có bài nào đo ở mốc này trong 8 tuần."
            />
            <WeekBars
              title="Bot trả lời khách có đúng ý bạn hơn không"
              sub="Tỷ lệ tin nháp của bot bạn gửi nguyên, không sửa, theo tuần"
              weeks={data.weeks}
              value={(w) => (w.drafts?.unchangedRate === null || w.drafts?.unchangedRate === undefined ? null : Math.round(w.drafts.unchangedRate * 100))}
              fmt={(v) => `${v}%`}
              empty={data.careEnabled ? 'Chưa có tin nháp nào của bot được gửi hay bỏ.' : 'Module Chăm sóc khách hàng đang tắt.'}
            />
          </div>
          <div class="flex flex-wrap items-start gap-4">
            <section class="card card-pad flex min-w-0 flex-[1.4_1_360px] flex-col gap-2" aria-labelledby="doi-trang-thai">
              <div class="flex items-center justify-between gap-2">
                <h2 id="doi-trang-thai" class="m-0 text-[15px] font-semibold">Bài học đổi trạng thái 7 ngày qua</h2>
                <Link href="/m/learn/playbook" class="text-[12.5px]">Mở sổ bài học</Link>
              </div>
              {data.changes.length === 0 ? (
                <p class="m-0 text-[12.5px] text-[var(--color-text-faint)]">Chưa có thay đổi nào.</p>
              ) : (
                <ul class="m-0 flex list-none flex-col gap-2 p-0">
                  {data.changes.map((ch) => (
                    <li key={`${ch.path}-${ch.at}`} class="flex items-start gap-2 text-[13px]">
                      <StatePill state={ch.to} />
                      <span class="min-w-0">
                        <span class="font-medium">{ch.title}</span>
                        <span class="block text-[12px] text-[var(--color-text-muted)]">{who(ch.actor)}{ch.reason ? ` · ${ch.reason}` : ''}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section class="card card-pad flex min-w-0 flex-[1_1_280px] flex-col gap-2" aria-labelledby="dang-thu">
              <h2 id="dang-thu" class="m-0 text-[15px] font-semibold">Bot đang thử</h2>
              {data.testing.length === 0 ? (
                <p class="m-0 text-[12.5px] text-[var(--color-text-faint)]">Chưa có bài học nào đang thử.</p>
              ) : (
                <ul class="m-0 flex list-none flex-col gap-2.5 p-0">
                  {data.testing.map((t) => (
                    <li key={t.path} class="flex flex-col gap-1 text-[13px]">
                      <span>{t.title}</span>
                      <div class="h-1.5 overflow-hidden rounded-full bg-[var(--color-border)]" role="progressbar" aria-valuemin={0} aria-valuemax={t.threshold} aria-valuenow={Math.min(t.measured, t.threshold)}>
                        <div class="h-full bg-[var(--color-accent)]" style={{ width: `${t.threshold ? Math.min(100, Math.round((t.measured / t.threshold) * 100)) : 0}%` }} />
                      </div>
                      <span class="text-[12px] text-[var(--color-text-muted)]">{t.measured}/{t.threshold} bài đã đo{t.label && t.measured ? ` · ${t.label}` : ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
