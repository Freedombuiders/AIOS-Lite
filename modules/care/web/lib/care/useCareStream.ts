// Preact binding for the Care event stream: one EventSource per mounted inbox page.

import { useEffect, useReducer, useRef } from 'preact/hooks';
import { tokenizedSseUrl } from '@/lib/api';
import { EVENTS_PATH } from './client';
import { initialStreamState, startCareStream, streamReducer, type StreamDriver, type StreamState } from './stream';

export function useCareStream(enabled = true): { state: StreamState; retry: () => void } {
  const [state, dispatch] = useReducer(streamReducer, undefined, initialStreamState);
  const seqRef = useRef<number | null>(null);
  seqRef.current = state.lastSeq;
  const driverRef = useRef<StreamDriver | null>(null);

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const driver = startCareStream({
      // First connect has no cursor (snapshot). A manual reopen resumes after the last seq; the
      // browser's own retries send Last-Event-ID, which the server prefers over ?after=.
      buildUrl: (after) => tokenizedSseUrl(after === null ? EVENTS_PATH : `${EVENTS_PATH}?after=${after}`),
      create: (url) => new EventSource(url),
      dispatch,
      getLastSeq: () => seqRef.current,
    });
    driverRef.current = driver;
    return () => {
      driver.close();
      driverRef.current = null;
    };
  }, [enabled]);

  return { state, retry: () => driverRef.current?.retry() };
}
