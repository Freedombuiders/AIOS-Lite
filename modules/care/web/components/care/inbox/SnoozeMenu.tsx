import { Clock } from 'lucide-preact';
import { PopoverMenu } from './PopoverMenu';
import { ct } from '@modules/care/web/lib/care/i18n';
import { snoozeOptions } from '@modules/care/web/lib/care/snooze';

/** Hoãn: 1 giờ nữa / 17:00 hôm nay / 9:00 sáng mai / thứ Hai 9:00 (Asia/Ho_Chi_Minh). */
export function SnoozeMenu({ busy, onPick }: { busy: boolean; onPick: (untilMs: number) => void }) {
  return (
    <PopoverMenu
      label={ct('inbox2.snooze.label')}
      className="care-ctl"
      testId="care-snooze"
      disabled={busy}
      menuLabel={ct('inbox2.snooze.menu')}
      content={<><Clock size={13} aria-hidden="true" /> {ct('inbox2.snooze.button')}</>}
    >
      {(close) => (
        // Computed when the menu opens, so "1 giờ nữa" is an hour from the click, not from page load.
        snoozeOptions(Date.now()).map((o) => (
          <button key={o.id} type="button" role="menuitem" class="care-menu-item" data-testid={`care-snooze-${o.id}`} onClick={() => { close(); onPick(o.untilMs); }}>
            <span class="care-menu-label">{ct(`inbox2.snooze.${o.id}`)}</span>
          </button>
        ))
      )}
    </PopoverMenu>
  );
}
