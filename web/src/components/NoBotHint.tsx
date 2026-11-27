import { Bot } from 'lucide-preact';
import { Link } from 'wouter-preact';
import { NO_BOT_HINT } from '@/lib/bots';

/** The how-to shown instead of an error when no GenBot bot has a key yet. */
export function NoBotHint({ compact }: { compact?: boolean }) {
  return (
    <p class={`m-0 flex flex-wrap items-center gap-2 text-[13px] text-[var(--color-text-muted)]${compact ? '' : ' rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-strong)] p-3'}`} data-testid="no-bot-hint">
      <span>{NO_BOT_HINT}</span>
      <Link href="/bots" class="control-button control-sm no-underline"><Bot size={12} /> Mở Đội AI · Bot</Link>
    </p>
  );
}
