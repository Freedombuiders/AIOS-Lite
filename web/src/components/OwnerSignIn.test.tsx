import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installOwnerFetchGuard, ownerPrompt, ownerRefusal } from '@/lib/owner';
import { OwnerSignIn } from './OwnerSignIn';

let root: HTMLElement | undefined;
afterEach(() => {
  if (root) render(null, root);
  root?.remove();
  root = undefined;
  ownerPrompt.value = null;
  vi.unstubAllGlobals();
});

const res = (status: number, header?: string) => new Response('{}', { status, headers: header ? { 'x-aios-owner': header } : {} });

describe('owner refusal handling', () => {
  it('only an owner refusal header opens the screen', async () => {
    expect(ownerRefusal(res(401, 'required'))).toBe('required');
    expect(ownerRefusal(res(403, 'cross-site'))).toBe('cross-site');
    expect(ownerRefusal(res(401))).toBeNull(); // AIOS_TOKEN or run-token 401
    expect(ownerRefusal(res(200, 'required'))).toBeNull();

    const target = { fetch: vi.fn(async () => res(401, 'required')) as unknown as typeof fetch };
    installOwnerFetchGuard(target);
    await target.fetch('/api/m/care/drafts/1/approve', { method: 'POST' });
    expect(ownerPrompt.value).toBe('required');
  });

  it('shows the Vietnamese sign-in screen and pairs with the code from the terminal', async () => {
    root = document.createElement('div');
    document.body.appendChild(root);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, owner: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    ownerPrompt.value = 'required';
    await act(async () => render(<OwnerSignIn />, root!));
    expect(root.textContent).toContain('Đăng nhập chủ');
    expect(root.textContent).toContain('terminal');
    const input = root.querySelector('input')!;
    await act(async () => {
      input.value = 'abcd-efgh-jkmn';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      root!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/owner/pair', expect.objectContaining({ method: 'POST', body: JSON.stringify({ code: 'abcd-efgh-jkmn' }) }));
    expect(ownerPrompt.value).toBeNull();
  });
});
