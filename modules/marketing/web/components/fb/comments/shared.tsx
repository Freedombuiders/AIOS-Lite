// Pieces shared by the comment log and the comment rules screens.

import { signal } from '@preact/signals';
import { Link, useRoute } from 'wouter-preact';
import type { FbPageDto } from '@modules/marketing/web/lib/fbstudio';

/** Page picked in Bình luận AI; survives moving between Nhật ký and Cấu hình. */
export const commentsPageId = signal('');

/** The selected Page, falling back to the first enabled one (then the first at all). */
export function pickCommentsPage(pages: FbPageDto[]): FbPageDto | null {
  return pages.find((p) => p.id === commentsPageId.value)
    ?? pages.find((p) => p.enabled)
    ?? pages[0]
    ?? null;
}

/** Nhật ký / Cấu hình tab strip under the page header. */
export function CommentsTabs() {
  const [onRules] = useRoute('/m/marketing/comment-rules');
  const tab = (href: string, label: string, active: boolean) => (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      class={`px-3.5 py-2 -mb-px border-b-2 text-[13px] whitespace-nowrap ${
        active
          ? 'border-[var(--color-accent)] text-[var(--color-text)] font-semibold'
          : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
      }`}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Bình luận AI" class="flex gap-1">
      {tab('/m/marketing/comments', 'Nhật ký', !onRules)}
      {tab('/m/marketing/comment-rules', 'Cấu hình', onRules)}
    </nav>
  );
}

/** Colours per pipeline step: blue = template, orange = agent, green = everything else. */
export const STEP_COLOR = {
  template: '#3987e5',
  agent: '#d95926',
  other: '#199e70',
} as const;

export function stepColor(step: string): string {
  return step === 'template' ? STEP_COLOR.template : step === 'agent' ? STEP_COLOR.agent : STEP_COLOR.other;
}
