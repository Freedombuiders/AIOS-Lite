import { EventEmitter } from 'node:events';
import type {
  AttentionItem,
  AuditEntry,
  BoardEntry,
  Memory,
  Message,
  ModuleState,
  Run,
  RunEvent,
  Task,
} from './types.js';

/** Everything that can be pushed to the UI over SSE. */
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
  /** module-defined events, namespaced: name = '<moduleId>:<event>' */
  | { type: 'custom'; name: string; payload: unknown };

export type AppEventType = AppEvent['type'];

export interface EventBus {
  emit(event: AppEvent): void;
  /** Subscribe to one type, or '*' for all. Returns an unsubscribe function. */
  on<T extends AppEventType | '*'>(type: T, handler: (event: T extends AppEventType ? Extract<AppEvent, { type: T }> : AppEvent) => void): () => void;
}

export function createEventBus(): EventBus {
  const ee = new EventEmitter();
  ee.setMaxListeners(0);
  return {
    emit(event) {
      ee.emit(event.type, event);
      ee.emit('*', event);
    },
    on(type, handler) {
      const h = handler as (e: AppEvent) => void;
      ee.on(type, h);
      return () => ee.off(type, h);
    },
  };
}
