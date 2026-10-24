import { useState } from 'preact/hooks';
import { useFetch } from '@/lib/useFetch';
import { fmtInt, fmtMoney, fmtPct, fmtSlot, type AdAccountDto, type AdsBreakdownsDto } from '@modules/ads/web/lib/fbstudio';
import { Card } from '../common';
import { BAD, GOOD, TRACK, finite } from '@/components/fb/charts/chart-utils';
import { DashError, DashLoading } from '@modules/ads/web/components/fb/DashStates';
import { DailyBars } from '@/components/fb/charts/DailyBars';
import { Legend } from '@/components/fb/charts/Legend';
import { RESULT_META } from './adsMeta';

/** Categorical slots 1 and 2 of the chart palette (dark steps), fixed per gender. */
const GENDER = {
  female: { label: 'Nữ', color: '#d95926' },
  male: { label: 'Nam', color: '#3987e5' },
  unknown: { label: 'Không rõ', color: 'var(--color-text-faint)' },
} as const;
type GenderKey = keyof typeof GENDER;
const genderOf = (g: string): GenderKey => (g === 'female' || g === 'male' ? g : 'unknown');

/** Min results for a segment's cost per result to count as a signal. */
const MIN_RESULTS = 3;

type Cell = AdsBreakdownsDto['ageGender'][number];

function AgeGender({ dto, account }: { dto: AdsBreakdownsDto; account: AdAccountDto }) {
  const cur = account.currency;
  const r = RESULT_META[account.resultType];
  const total = dto.ageGender.reduce((s, c) => s + c.spend, 0);
  // Meta's "unknown" gender and age buckets are noise unless they carry real spend.
  const minor = (c: Cell) => (genderOf(c.gender) === 'unknown' || c.age.toLowerCase() === 'unknown') && c.results < MIN_RESULTS && (total <= 0 || c.spend / total < 0.02);
  const cellsAll = dto.ageGender.filter((c) => !minor(c));
  const ages = [...new Set(cellsAll.map((c) => c.age))].sort();
  const maxAge = Math.max(1, ...ages.map((a) => cellsAll.filter((c) => c.age === a).reduce((s, c) => s + c.spend, 0)));
  const gendersShown = (['female', 'male', 'unknown'] as GenderKey[]).filter((g) => cellsAll.some((c) => genderOf(c.gender) === g && c.spend > 0));

  const signal = dto.ageGender.filter((c) => c.results >= MIN_RESULTS && finite(c.cpa));
  const best = [...signal].sort((a, b) => (a.cpa as number) - (b.cpa as number))[0];
  const worst = [...signal].sort((a, b) => (b.cpa as number) - (a.cpa as number))[0];
  const burning = dto.ageGender.filter((c) => c.results === 0 && total > 0 && c.spend / total >= 0.05).sort((a, b) => b.spend - a.spend)[0];
  const name = (c: Cell) => `${GENDER[genderOf(c.gender)].label} ${c.age}`;

  if (!dto.ageGender.length) return <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Chưa có chi tiêu trong khoảng này.</p>;
  return (
    <div class="flex flex-col gap-3">
      <ul class="list-none m-0 p-0 flex flex-col gap-2" aria-label="Chi tiêu và giá mỗi kết quả theo độ tuổi và giới tính">
        {ages.map((age) => {
          const cells = gendersShown.map((g) => cellsAll.find((c) => c.age === age && genderOf(c.gender) === g)).filter((c): c is Cell => Boolean(c));
          const ageSpend = cells.reduce((s, c) => s + c.spend, 0);
          return (
            <li key={age} class="grid items-center gap-2.5 text-[12.5px]" style={{ gridTemplateColumns: '52px minmax(0, 1fr) minmax(190px, auto)' }}>
              <span class="tabular-nums text-[var(--color-text)]">{age}</span>
              <span class="flex h-3.5 rounded-r overflow-hidden" style={{ background: TRACK }} aria-hidden="true">
                <span class="flex h-full gap-[2px]" style={{ width: `${Math.max(1, (ageSpend / maxAge) * 100)}%` }}>
                  {cells.filter((c) => c.spend > 0).map((c) => (
                    <span key={c.gender} class="h-full" style={{ flex: `${c.spend} 0 0`, background: GENDER[genderOf(c.gender)].color }} />
                  ))}
                </span>
              </span>
              <span class="flex justify-end gap-3 tabular-nums whitespace-nowrap">
                {cells.map((c) => (
                  <span key={c.gender} title={`${name(c)}: chi ${fmtMoney(c.spend, cur)}, ${fmtInt(c.results)} ${r.noun}, CTR ${fmtPct(c.ctr, 2)}`}>
                    <span class="text-[var(--color-text-muted)]">{GENDER[genderOf(c.gender)].label} </span>
                    <strong class="font-semibold" style={{ color: best && c === best ? GOOD : worst && c === worst && worst !== best ? BAD : 'var(--color-text)' }}>
                      {finite(c.cpa) ? fmtMoney(c.cpa, cur) : c.spend > 0 ? '0 KQ' : '–'}
                    </strong>
                    <span class="text-[var(--color-text-muted)]"> · {fmtInt(c.results)}</span>
                  </span>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
      <Legend items={gendersShown.map((g) => ({ label: `${GENDER[g].label} (độ dài thanh = chi tiêu)`, color: GENDER[g].color }))} />
      <ul class="list-none m-0 p-0 flex flex-col gap-1 text-[12.5px] text-[var(--color-text-muted)]">
        {best && <li><span style={{ color: GOOD }}>●</span> Rẻ nhất: <strong class="text-[var(--color-text)]">{name(best)}</strong>, {r.cpa} {fmtMoney(best.cpa, cur)} trên {fmtInt(best.results)} {r.noun} ({fmtPct(total ? (best.spend / total) * 100 : null, 0)} chi tiêu). Dồn thêm ngân sách hoặc tách nhóm riêng cho tệp này.</li>}
        {worst && worst !== best && <li><span style={{ color: BAD }}>●</span> Đắt nhất: <strong class="text-[var(--color-text)]">{name(worst)}</strong>, {r.cpa} {fmtMoney(worst.cpa, cur)}, gấp {((worst.cpa as number) / (best?.cpa as number)).toFixed(1).replace('.', ',')} lần nhóm rẻ nhất.</li>}
        {burning && <li><span style={{ color: BAD }}>●</span> <strong class="text-[var(--color-text)]">{name(burning)}</strong> đã chi {fmtMoney(burning.spend, cur)} ({fmtPct((burning.spend / total) * 100, 0)}) mà chưa có {r.noun}: cân nhắc loại khỏi target.</li>}
        {!best && <li>Chưa nhóm nào đủ {MIN_RESULTS} {r.noun} để so giá.</li>}
      </ul>
    </div>
  );
}

function Hours({ dto, account }: { dto: AdsBreakdownsDto; account: AdAccountDto }) {
  const [hd, setHd] = useState<number | null>(null);
  const cur = account.currency;
  const r = RESULT_META[account.resultType];
  const hours = dto.hours;
  const totalResults = hours.reduce((s, h) => s + h.results, 0);
  const totalSpend = hours.reduce((s, h) => s + h.spend, 0);
  const avgCpa = totalResults > 0 ? totalSpend / totalResults : null;

  // Cheapest and dearest three-hour blocks with enough results to judge.
  const blocks = Array.from({ length: 22 }, (_, i) => {
    const hs = hours.slice(i, i + 3);
    const res = hs.reduce((s, h) => s + h.results, 0);
    const sp = hs.reduce((s, h) => s + h.spend, 0);
    return { from: i, results: res, spend: sp, cpa: res > 0 ? sp / res : null };
  }).filter((b) => b.results >= MIN_RESULTS && finite(b.cpa));
  const best = [...blocks].sort((a, b) => (a.cpa as number) - (b.cpa as number))[0];
  const worst = [...blocks].sort((a, b) => (b.cpa as number) - (a.cpa as number))[0];
  const span = (b: { from: number }) => `${b.from}h–${b.from + 3}h`;

  if (totalSpend <= 0) return <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Chưa có chi tiêu trong khoảng này.</p>;
  return (
    <div class="flex flex-col gap-2">
      <DailyBars
        groupLabel={`Số ${r.noun} theo giờ trong ngày`}
        height={150}
        values={hours.map((h) => h.results)}
        labels={hours.map((h) => `${h.hour}h`)}
        active={hd}
        onActive={setHd}
        formatAxis={(v) => fmtInt(v)}
        ariaOf={(i) => `${i} giờ: ${fmtInt(hours[i].results)} ${r.noun}, chi ${fmtMoney(hours[i].spend, cur)}, ${r.cpa} ${finite(hours[i].cpa) ? fmtMoney(hours[i].cpa, cur) : 'chưa có'}`}
        tooltip={(i) => (
          <div class="flex flex-col gap-0.5 tabular-nums">
            <strong class="text-[var(--color-text)]">{i}h–{i + 1}h</strong>
            <span class="text-[var(--color-text-muted)]">{fmtInt(hours[i].results)} {r.noun} · chi {fmtMoney(hours[i].spend, cur)}</span>
            <span class="text-[var(--color-text-muted)]">{r.cpa} <span class="text-[var(--color-text)]">{finite(hours[i].cpa) ? fmtMoney(hours[i].cpa, cur) : '–'}</span>{finite(hours[i].cpa) && finite(avgCpa) ? ` (${hours[i].cpa! <= avgCpa ? 'rẻ hơn' : 'đắt hơn'} TB)` : ''}</span>
          </div>
        )}
      />
      <ul class="list-none m-0 p-0 flex flex-col gap-1 text-[12.5px] text-[var(--color-text-muted)]">
        {best && <li><span style={{ color: GOOD }}>●</span> Khung rẻ nhất <strong class="text-[var(--color-text)]">{span(best)}</strong>: {r.cpa} {fmtMoney(best.cpa, cur)} ({fmtInt(best.results)} {r.noun}){finite(avgCpa) ? `, trung bình cả ngày ${fmtMoney(avgCpa, cur)}` : ''}.</li>}
        {worst && worst !== best && <li><span style={{ color: BAD }}>●</span> Khung đắt nhất <strong class="text-[var(--color-text)]">{span(worst)}</strong>: {r.cpa} {fmtMoney(worst.cpa, cur)}. Nếu chạy ngân sách trọn đời, có thể lên lịch tránh khung này.</li>}
        <li>Giờ theo múi giờ của tài khoản quảng cáo.</li>
      </ul>
    </div>
  );
}

/** Live age × gender and hour-of-day split for the account on screen. */
export function AudienceSection({ account, days }: { account: AdAccountDto; days: number }) {
  const res = useFetch<AdsBreakdownsDto>(`/api/m/ads/breakdowns?account=${encodeURIComponent(account.id)}&days=${days}`);
  const dto = res.data;
  const aside = dto ? `${days} ngày · đọc lúc ${fmtSlot(dto.fetchedAt)}` : `${days} ngày`;
  return (
    <div class="flex flex-wrap gap-4">
      <Card class="flex-[1_1_480px]" title="Ai ra kết quả rẻ: độ tuổi × giới tính" aside={aside}>
        {res.loading && !dto ? <DashLoading label="Đang đọc phân tích đối tượng từ Meta…" /> : res.error && !dto ? <DashError error={res.error} onRetry={res.refresh} /> : dto ? <AgeGender dto={dto} account={account} /> : null}
      </Card>
      <Card class="flex-[1_1_420px]" title={`${RESULT_META[account.resultType].name} theo giờ trong ngày`} aside={aside}>
        {res.loading && !dto ? <DashLoading label="Đang đọc theo giờ…" /> : res.error && !dto ? <DashError error={res.error} onRetry={res.refresh} /> : dto ? <Hours dto={dto} account={account} /> : null}
      </Card>
    </div>
  );
}
