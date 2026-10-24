import { signal, effect } from '@preact/signals';

// Right-hand agent chat dock. Open state and width are per-browser layout
// preferences (like the theme), so they live in localStorage rather than
// the server-side personalization settings.

const OPEN_KEY = 'claudeclaw.chatDock';
const WIDTH_KEY = 'claudeclaw.chatDockWidth';

export const CHAT_DOCK_MIN_WIDTH = 320;
export const CHAT_DOCK_MAX_WIDTH = 720;
const DEFAULT_WIDTH = 400;

function isDesktop(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches;
}

function loadOpen(): boolean {
  // On phones the dock is a full-screen overlay; never restore it open
  // there or every page load would start covered.
  if (!isDesktop()) return false;
  let stored: string | null = null;
  try { stored = localStorage.getItem(OPEN_KEY); } catch {}
  if (stored === 'open') return true;
  if (stored === 'closed') return false;
  // Keep the workspace focused; the assistant is one click away.
  return false;
}

function loadWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(n) && n > 0) return clampWidth(n);
  } catch {}
  return DEFAULT_WIDTH;
}

export function clampWidth(px: number): number {
  return Math.max(CHAT_DOCK_MIN_WIDTH, Math.min(CHAT_DOCK_MAX_WIDTH, Math.round(px)));
}

export const chatDockOpen = signal<boolean>(loadOpen());
export const chatDockWidth = signal<number>(loadWidth());
/** True while the dock panel is actually on screen (open and not hidden
 *  by the /chat page). The chat stream reads it to skip unread bumps. */
export const chatDockVisible = signal(false);

/** Bumped on every user-initiated open so the panel focuses its composer
 *  then, but not when it's simply restored open on page load. */
export const chatDockFocusNonce = signal(0);

/** The /chat page shows the same conversation, so the dock hides there. */
export function isChatRoute(pathname: string): boolean {
  return pathname === '/chat' || pathname.startsWith('/chat/');
}

/** Pages that render their own docked chat panel (same open/width state,
 *  page-specific context), so the generic dock stays out of the way. */
export function hasPageChatPanel(pathname: string, search = ''): boolean {
  return pathname === '/social' && new URLSearchParams(search).get('tab') === 'library';
}

/** The last page outside /chat, so "Dock chat" can put the conversation beside it again. */
export const lastWorkspaceRoute = signal('/dashboard');
export function rememberWorkspaceRoute(pathname: string, search = ''): void {
  if (isChatRoute(pathname) || pathname === '/jarvis' || pathname === '/setup') return;
  lastWorkspaceRoute.value = `${pathname}${search ? `?${search.replace(/^\?/, '')}` : ''}`;
}

/** Open the dock with the user's focus (the /chat page hands its conversation over to it). */
export function openChatDock(): void {
  chatDockFocusNonce.value += 1;
  chatDockOpen.value = true;
}

export function toggleChatDock(): void {
  const next = !chatDockOpen.value;
  if (next) chatDockFocusNonce.value += 1;
  chatDockOpen.value = next;
}
export function closeChatDock(): void { chatDockOpen.value = false; }
export function setChatDockWidth(px: number): void { chatDockWidth.value = clampWidth(px); }

effect(() => {
  const open = chatDockOpen.value;
  // Only desktop toggles count as a preference; closing the phone overlay
  // shouldn't flip the desktop layout.
  if (!isDesktop()) return;
  try { localStorage.setItem(OPEN_KEY, open ? 'open' : 'closed'); } catch {}
});

effect(() => {
  const width = chatDockWidth.value;
  try { localStorage.setItem(WIDTH_KEY, String(width)); } catch {}
});

/** Explicit page action: append a reference to the composer, never send it. */
export const chatDockPrefill = signal<string | null>(null);
export function prefillChatDock(text: string): void {
  chatDockPrefill.value = text;
  chatDockOpen.value = true;
  chatDockFocusNonce.value += 1;
}
