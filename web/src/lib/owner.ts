// Owner sign-in state. Owner routes answer 401/403 with the `x-aios-owner` header (src/api/owner.ts); every fetch of
// the app (core pages and module UIs alike) passes through the guard below, which opens the sign-in screen.
import { signal } from '@preact/signals';

export type OwnerPrompt = null | 'required' | 'cross-site' | 'pair-failed';

export const ownerPrompt = signal<OwnerPrompt>(null);

const HEADER = 'x-aios-owner';

/** Reads the owner refusal header of an API response; null when the response is not an owner refusal. */
export function ownerRefusal(res: Pick<Response, 'status' | 'headers'>): OwnerPrompt {
  if (res.status !== 401 && res.status !== 403) return null;
  const v = res.headers.get(HEADER);
  return v === 'required' ? 'required' : v === 'cross-site' ? 'cross-site' : null;
}

let installed = false;

/** Wrap window.fetch once so any owner refusal opens the sign-in screen. */
export function installOwnerFetchGuard(target: { fetch: typeof fetch } = window): void {
  if (installed && target === window) return;
  if (target === window) installed = true;
  const original = target.fetch.bind(target);
  target.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await original(...args);
    const refusal = ownerRefusal(res);
    if (refusal) ownerPrompt.value = refusal;
    return res;
  };
  // the terminal link redirects here with ?owner=pair-failed when its code was wrong, used or expired
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('owner') === 'pair-failed') {
      ownerPrompt.value = 'pair-failed';
      params.delete('owner');
      const qs = params.toString();
      history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
    }
  } catch {
    /* no location in tests */
  }
}

async function post(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    credentials: 'same-origin',
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

/** Exchange the code printed on the server terminal for an owner session cookie. */
export async function pairWithCode(code: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const r = await post('/api/owner/pair', { code: code.trim() });
    if (r.ok) return { ok: true };
    const message = (r.data.error as { message?: string } | undefined)?.message;
    return { ok: false, message: message ?? 'Không đăng nhập được, thử lại.' };
  } catch {
    return { ok: false, message: 'Không kết nối được máy chủ AIOS-Lite.' };
  }
}

/** Ask the server to print a fresh code on its terminal (the code is never sent back to the browser). */
export async function requestNewCode(): Promise<{ printed: boolean; retryInSec?: number }> {
  try {
    const r = await post('/api/owner/pair/request');
    return { printed: r.data.printed === true, retryInSec: typeof r.data.retryInSec === 'number' ? r.data.retryInSec : undefined };
  } catch {
    return { printed: false };
  }
}
