import type { Stage } from './types';

export const STAGE_ORDER: readonly Stage[] = ['new', 'consulting', 'quoted', 'deposit', 'won', 'lost'];

export const STAGE_LABEL: Record<Stage, string> = {
  new: 'Mới',
  consulting: 'Đang tư vấn',
  quoted: 'Đã báo giá',
  deposit: 'Đặt cọc',
  won: 'Đã chốt',
  lost: 'Mất',
};

/** chip colours (CSS variables of the app theme) */
export const STAGE_CHIP: Record<Stage, string> = {
  new: 'bg-[rgba(255,255,255,0.07)] text-[var(--color-control-text)]',
  consulting: 'bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]',
  quoted: 'bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]',
  deposit: 'bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]',
  won: 'bg-[rgba(70,194,138,0.16)] text-[var(--color-status-done)]',
  lost: 'bg-[rgba(240,100,122,0.14)] text-[var(--color-danger)]',
};

export const isStage = (v: unknown): v is Stage => typeof v === 'string' && (STAGE_ORDER as readonly string[]).includes(v);
