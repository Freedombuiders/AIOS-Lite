// Tiny helper for tests: run a hook once inside a Router and return its value.
import { h, render } from 'preact';
import { Router } from 'wouter-preact';

export function renderHook<T>(useIt: () => T): T {
  let out: T | undefined;
  const Probe = () => {
    out = useIt();
    return null;
  };
  const el = document.createElement('div');
  render(h(Router, null, h(Probe, null)), el);
  render(null, el);
  return out as T;
}
