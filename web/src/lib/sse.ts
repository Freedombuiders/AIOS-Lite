// One shared EventSource for the whole app. Auto-reconnects; consumers refetch on reconnect.
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { AppEvent, AppEventType } from './events';
import { tokenizedSseUrl } from './api';
import { mockEnabled, mockSubscribe } from './mock';

export const sseConnected = signal(false);

type Handler = (e: AppEvent) => void;
const handlers = new Set<Handler>();
const reconnectHandlers = new Set<() => void>();
const EVENT_TYPES: AppEventType[] = ['task', 'run', 'run-event', 'message', 'board', 'memory', 'attention', 'audit', 'module', 'custom'];

let es: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryMs = 1000;
let everConnected = false;
let started = false;

function dispatch(e: AppEvent) {
  for (const h of handlers) {
    try {
      h(e);
    } catch (err) {
      console.error('sse handler', err);
    }
  }
}

function connect() {
  if (typeof EventSource === 'undefined') return;
  es = new EventSource(tokenizedSseUrl('/api/events'));
  es.onopen = () => {
    sseConnected.value = true;
    retryMs = 1000;
    if (everConnected) for (const h of reconnectHandlers) h();
    everConnected = true;
  };
  for (const type of EVENT_TYPES) {
    es.addEventListener(type, (ev) => {
      try {
        dispatch(JSON.parse((ev as MessageEvent).data) as AppEvent);
      } catch {
        /* malformed event */
      }
    });
  }
  es.onerror = () => {
    sseConnected.value = false;
    es?.close();
    es = null;
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, 15000);
  };
}

export function startSse(): void {
  if (started) return;
  started = true;
  if (mockEnabled()) {
    sseConnected.value = true;
    mockSubscribe(dispatch);
    return;
  }
  connect();
}

export function stopSse(): void {
  started = false;
  es?.close();
  es = null;
  sseConnected.value = false;
}

export function subscribeEvents(h: Handler): () => void {
  handlers.add(h);
  return () => handlers.delete(h);
}

export function onSseReconnect(h: () => void): () => void {
  reconnectHandlers.add(h);
  return () => reconnectHandlers.delete(h);
}

/** Run `fn` for events of the given types for as long as the component is mounted. */
export function useEvents(types: AppEventType[] | '*', fn: (e: AppEvent) => void): void {
  useEffect(
    () =>
      subscribeEvents((e) => {
        if (types === '*' || types.includes(e.type)) fn(e);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fn, Array.isArray(types) ? types.join(',') : types],
  );
}
