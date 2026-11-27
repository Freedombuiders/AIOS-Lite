import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Router } from 'wouter-preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiPost = vi.hoisted(() => vi.fn(async () => ({})));
const createConversation = vi.hoisted(() => vi.fn(async (agentId: string) => ({ id: '42', agentId })));
const pushToast = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({ apiPost, errorText: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));
vi.mock('@/lib/chat-conversations', () => ({ createConversation }));
vi.mock('@/lib/toasts', () => ({ pushToast }));
const agentList = vi.hoisted(() => ({ override: null as null | unknown[] }));
vi.mock('@/lib/agents', () => ({
  useAgents: () => ({
    agents: agentList.override ?? [
      { id: 'bot-tro-ly', name: 'Trợ lý chính', enabled: true, runtime: 'genbot', genbotKey: { hasKey: true, last4: 'abcd' } },
      { id: 'cskh', name: 'Bot CSKH', enabled: true, runtime: 'genbot', genbotKey: { hasKey: true, last4: 'efgh' } },
      { id: 'old', name: 'Bot cũ', enabled: false, runtime: 'genbot', genbotKey: { hasKey: true, last4: 'ijkl' } },
      // GenBot only: an agent left on claude and a bot without a key are never offered
      { id: 'legacy', name: 'Agent Claude cũ', enabled: true, runtime: 'claude' },
      { id: 'nokey', name: 'Bot chưa nối', enabled: true, runtime: 'genbot', genbotKey: { hasKey: false, last4: '' } },
    ],
    loading: false, error: null, loadErrors: [], refresh() {},
  }),
}));

import { CommandBar } from './CommandBar';

// Some Node versions ship their own localStorage that shadows jsdom's; use a plain in-memory one.
const store = new Map<string, string>();
const memoryStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() };

async function mount() {
  history.replaceState(null, '', '/');
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(() => render(<Router><CommandBar /></Router>, el));
  return el;
}

function type(el: HTMLElement, value: string) {
  const input = el.querySelector('input[type="text"]') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const send = (el: HTMLElement) => act(async () => {
  (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
});

describe('CommandBar', () => {
  beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage); apiPost.mockClear(); createConversation.mockClear(); pushToast.mockClear(); store.clear(); });
  afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); agentList.override = null; });

  it('with no bot that has a key, points at Đội AI · Bot instead of failing on send', async () => {
    agentList.override = [{ id: 'nokey', name: 'Bot chưa nối', enabled: true, runtime: 'genbot', genbotKey: { hasKey: false, last4: '' } }];
    const el = await mount();
    const link = el.querySelector('[data-testid="cmdbar-no-bot"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/bots');
    expect(link.title).toMatch(/Đội AI · Bot/);
    expect((el.querySelector('input[type="text"]') as HTMLInputElement).placeholder).toMatch(/Đội AI · Bot/);
    type(el, 'xin chào');
    expect((el.querySelector('button[aria-label="Gửi"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows no how-to when a bot has a key', async () => {
    const el = await mount();
    expect(el.querySelector('[data-testid="cmdbar-no-bot"]')).toBeNull();
  });

  it('offers only enabled GenBot bots that have a key, with the mic disabled and explained', async () => {
    const el = await mount();
    const options = [...el.querySelectorAll('select option')].map((o) => o.textContent);
    expect(options).toEqual(['Trợ lý chính', 'Bot CSKH']);
    const mic = el.querySelector('button[aria-label^="Nói thay vì gõ"]') as HTMLButtonElement;
    expect(mic.disabled).toBe(true);
    expect(mic.title).toMatch(/sắp có/);
    expect(el.querySelector('button[aria-label="Đính kèm tệp"]')).not.toBeNull();
  });

  it('keeps the send button off until there is something to send', async () => {
    const el = await mount();
    const btn = el.querySelector('button[aria-label="Gửi"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await act(() => type(el, 'xin chào'));
    expect(btn.disabled).toBe(false);
  });

  it('opens a conversation with the chosen bot, sends the line, and goes to /chat/<id>', async () => {
    const el = await mount();
    const select = el.querySelector('select') as HTMLSelectElement;
    await act(() => { select.value = 'cskh'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(() => type(el, 'Viết bài Tết cho tôi'));
    await send(el);
    expect(createConversation).toHaveBeenCalledWith('cskh');
    expect(apiPost).toHaveBeenCalledWith('/conversations/42/messages', { content: 'Viết bài Tết cho tôi' });
    expect(location.pathname).toBe('/chat/42');
    expect(store.get('aios.commandbar.agent')).toBe('cskh');
    expect((el.querySelector('input[type="text"]') as HTMLInputElement).value).toBe('');
  });

  it('stays put and keeps the text when sending fails', async () => {
    apiPost.mockRejectedValueOnce(new Error('Máy chủ không phản hồi'));
    const el = await mount();
    await act(() => type(el, 'Gửi thử'));
    await send(el);
    expect(location.pathname).toBe('/');
    expect((el.querySelector('input[type="text"]') as HTMLInputElement).value).toBe('Gửi thử');
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error', description: 'Máy chủ không phản hồi' }));
  });

  it('does not send an empty line', async () => {
    const el = await mount();
    await send(el);
    expect(createConversation).not.toHaveBeenCalled();
  });
});
