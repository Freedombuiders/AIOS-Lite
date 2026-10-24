import type { Task, TaskStatus } from '@core/types';
import { STATUS_LABEL, STATUS_TONE } from '@/lib/labels';
import { Pill } from './Pill';

export function StatusPill({ status }: { status: TaskStatus }) {
  return <Pill tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Pill>;
}

export function isModuleTask(t: Pick<Task, 'source'>): boolean {
  return t.source.startsWith('module:');
}
