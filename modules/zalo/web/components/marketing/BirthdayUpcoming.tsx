import { useState } from 'preact/hooks';
import { Cake, Send, SkipForward } from 'lucide-preact';
import { Pill } from '@/components/Pill';
import { apiPost } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import {
  BTN, OCCASION_LABEL, STATE_LABEL, STATE_TONE, daysUntilLabel, errMsg, reasonLabel, shortDate,
  type UpcomingBirthday, type UpcomingOccasion,
} from './BirthdayShared';

/** Next birthdays with the state of each planned greeting. Actions work on queued rows and create one on demand. */
export function BirthdayUpcoming({ items, enabled, onChanged }: {
  items: UpcomingBirthday[];
  enabled: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  async function act(u: UpcomingBirthday, o: UpcomingOccasion, action: 'send-now' | 'skip') {
    const key = `${u.threadId}:${o.occasion}:${u.birthdayOn}`;
    setBusy(key);
    try {
      if (o.greetingId !== null) {
        await apiPost(`/api/m/zalo/birthday/greetings/${o.greetingId}/${action}`);
      } else {
        await apiPost(`/api/m/zalo/birthday/greetings/by-key/${action}`, {
          threadId: u.threadId, occasion: o.occasion, birthdayOn: u.birthdayOn,
        });
      }
      pushToast({
        tone: 'success',
        title: action === 'send-now' ? 'Đã đưa vào hàng gửi' : 'Đã bỏ qua lời chúc',
        description: action === 'send-now' ? 'Sẽ gửi trong vòng khoảng 1 phút nếu nick sẵn sàng.' : undefined,
      });
      onChanged();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không thực hiện được', description: errMsg(err) });
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) {
    return (
      <div class="rounded-lg border border-[var(--color-border)] px-4 py-5 text-[12px] text-[var(--color-text-faint)] w-full min-w-0">
        Không có sinh nhật nào trong 14 ngày tới. Ngày sinh được lấy từ hồ sơ Zalo của khách; bạn cũng có thể nhập tay bằng nút “Đặt ngày sinh”.
      </div>
    );
  }

  return (
    <div class="rounded-lg border border-[var(--color-border)] overflow-x-auto w-full min-w-0">
      <table class="w-full text-[12px]">
        <thead>
          <tr class="text-left text-[11px] text-[var(--color-text-faint)] border-b border-[var(--color-border)] bg-[var(--color-card)]">
            <th class="px-3 py-2 font-medium">Khách</th>
            <th class="px-3 py-2 font-medium">Sinh nhật</th>
            <th class="px-3 py-2 font-medium">Dịp chúc</th>
            <th class="px-3 py-2 font-medium">Trạng thái</th>
            <th class="px-3 py-2 w-[170px]" />
          </tr>
        </thead>
        <tbody>
          {items.flatMap((u) => u.occasions.map((o, i) => {
            const key = `${u.threadId}:${o.occasion}:${u.birthdayOn}`;
            const canSend = enabled && o.state !== 'sent' && o.state !== 'inactive';
            const canSkip = o.state === 'pending' || o.state === 'planned';
            return (
              <tr key={key} class="border-b last:border-b-0 border-[var(--color-border)] align-top">
                <td class="px-3 py-2">
                  {i === 0 ? (
                    <>
                      <span class="text-[var(--color-text)]">{u.name || 'Không tên'}</span>
                      <div class="text-[10.5px] text-[var(--color-text-faint)]">
                        {u.accountLabel}{u.age !== null ? ` · tròn ${u.age} tuổi` : ''}
                      </div>
                    </>
                  ) : null}
                </td>
                <td class="px-3 py-2 whitespace-nowrap">
                  {i === 0 ? (
                    <>
                      <span class="inline-flex items-center gap-1 text-[var(--color-text)]"><Cake size={12} /> {shortDate(u.birthdayOn)}</span>
                      <div class="text-[10.5px] text-[var(--color-text-faint)]">{daysUntilLabel(u.daysUntil)}</div>
                    </>
                  ) : null}
                </td>
                <td class="px-3 py-2 text-[var(--color-text-muted)]">
                  {OCCASION_LABEL[o.occasion]}
                  <div class="text-[10.5px] text-[var(--color-text-faint)]">gửi {shortDate(o.sendOn)}</div>
                </td>
                <td class="px-3 py-2">
                  <Pill tone={STATE_TONE[o.state]}>{STATE_LABEL[o.state]}</Pill>
                  {o.skipReason && <div class="text-[10.5px] text-[var(--color-text-faint)] mt-0.5">{reasonLabel(o.skipReason)}</div>}
                </td>
                <td class="px-3 py-2 text-right whitespace-nowrap">
                  {canSend && (
                    <button type="button" class={BTN} disabled={busy === key} onClick={() => void act(u, o, 'send-now')}>
                      <Send size={12} /> Gửi ngay
                    </button>
                  )}
                  {canSkip && (
                    <button type="button" class={`${BTN} ml-1`} disabled={busy === key} onClick={() => void act(u, o, 'skip')}>
                      <SkipForward size={12} /> Bỏ qua
                    </button>
                  )}
                </td>
              </tr>
            );
          }))}
        </tbody>
      </table>
    </div>
  );
}
