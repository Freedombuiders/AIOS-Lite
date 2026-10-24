import type { ComponentChildren } from 'preact';
import type { Tone } from '@/lib/labels';

export type { Tone };

const PILL: Record<Tone, string> = {
  neutral: '',
  accent: 'pill-accent',
  success: 'pill-success',
  done: 'pill-success',
  good: 'pill-success',
  error: 'pill-error',
  failed: 'pill-error',
  bad: 'pill-error',
  warn: 'pill-warn',
  review: 'pill-warn',
  info: 'pill-info',
  running: 'pill-info',
  waiting: 'pill-waiting',
  queued: '',
  cancelled: '',
  high: 'pill-error',
  medium: 'pill-warn',
  low: '',
};

const DOT: Record<Tone, string> = {
  neutral: '',
  accent: 'dot-info',
  success: 'dot-success',
  done: 'dot-success',
  good: 'dot-success',
  error: 'dot-error',
  failed: 'dot-error',
  bad: 'dot-error',
  warn: 'dot-warn',
  review: 'dot-warn',
  info: 'dot-info',
  running: 'dot-info dot-pulse',
  waiting: 'dot-warn',
  queued: '',
  cancelled: '',
  high: 'dot-error',
  medium: 'dot-warn',
  low: '',
};

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ComponentChildren }) {
  return <span class={`pill ${PILL[tone]}`}>{children}</span>;
}

export function StatusDot({ tone }: { tone: Tone }) {
  return <span class={`dot ${DOT[tone]}`} aria-hidden="true" />;
}
