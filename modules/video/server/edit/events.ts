import { EventEmitter } from 'node:events';
import { moduleCtx } from '../host.js';
import type { VideoEditEvent } from './types.js';

const hub = new EventEmitter();
hub.setMaxListeners(0);

/** Slim copy of the events other screens care about (long renders, steps); streamed text stays on the project SSE. */
function mirror(projectId: string, evt: VideoEditEvent): void {
  const ctx = moduleCtx();
  if (!ctx) return;
  if (evt.type === 'job') {
    const { id, kind, status, progress, message } = evt.job as unknown as Record<string, unknown>;
    ctx.events.emit('job', { projectId, id, kind, status, progress, message });
  } else if (evt.type === 'step') {
    ctx.events.emit('step', { projectId, step: evt.step });
  }
}

export function emitVideoEvent(projectId: string, evt: VideoEditEvent): void {
  hub.emit(projectId, evt);
  try { mirror(projectId, evt); } catch { /* the bus must never break a render */ }
}

export function subscribeVideoEvents(projectId: string, fn: (evt: VideoEditEvent) => void): () => void {
  hub.on(projectId, fn);
  return () => hub.off(projectId, fn);
}

export { subscribeVideoEvents as subscribe };
