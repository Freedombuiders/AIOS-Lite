// Mirror of AppEvent (src/core/events.ts) so the web bundle never pulls in node types.
import type { AttentionItem, AuditEntry, BoardEntry, Memory, Message, ModuleState, Run, RunEvent, Task } from '@core/types';

export type AppEvent =
  | { type: 'task'; task: Task }
  | { type: 'run'; run: Run }
  | { type: 'run-event'; runId: number; taskId: number; event: RunEvent }
  | { type: 'message'; message: Message }
  | { type: 'board'; entry: BoardEntry }
  | { type: 'memory'; memory: Memory; deleted?: boolean }
  | { type: 'attention'; item: AttentionItem; resolved?: boolean }
  | { type: 'audit'; entry: AuditEntry }
  | { type: 'module'; module: ModuleState }
  | { type: 'custom'; name: string; payload: unknown };

export type AppEventType = AppEvent['type'];
