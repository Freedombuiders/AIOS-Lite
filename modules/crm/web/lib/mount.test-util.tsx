import { render } from 'preact';
import type { ComponentChild } from 'preact';
import { act } from 'preact/test-utils';
import { Router } from 'wouter-preact';
import { memoryLocation } from 'wouter-preact/memory-location';

/** Mounts under an in-memory router and waits for the first loads to settle. */
export async function mount(ui: ComponentChild, path = '/') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const loc = memoryLocation({ path, record: true });
  await act(async () => { render(<Router hook={loc.hook}>{ui}</Router>, host); });
  await settle();
  return { host, loc, unmount: () => { render(null, host); host.remove(); } };
}

export const settle = async (n = 4) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 5)); }); };

export const q = <T extends Element = HTMLElement>(host: ParentNode, sel: string) => host.querySelector<T>(sel);
export const qa = <T extends Element = HTMLElement>(host: ParentNode, sel: string) => [...host.querySelectorAll<T>(sel)];

/** a bubbling DOM event with a minimal dataTransfer, which is all the board reads */
export function fire(el: Element, type: string, extra: Record<string, unknown> = {}) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, { dataTransfer: { setData() {}, getData: () => '', effectAllowed: '' }, ...extra });
  return act(async () => { el.dispatchEvent(ev); });
}
