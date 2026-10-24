import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { ROUTES, SECTION_LABEL } from './routes';

// What the owner has on screen, sent with every message from the right chat
// dock so the agent can answer "khách này hỏi gì?" without being told which
// account or conversation. The browser sends ids only; the server reads the
// conversation itself and checks the agent's data access (screen-context.ts).

export interface PageFocus {
  zaloAccountId?: string;
  zaloThreadId?: number;
  emailAccountId?: string;
  emailThreadId?: number;
  /** Facebook analytics screens: the Page, post or ad account on screen and its range. */
  fbPageId?: string;
  fbPostId?: string;
  fbAdAccountId?: string;
  days?: number;
  milestone?: string;
  /** Shown in the dock's context chip, e.g. the open chat's name. */
  label?: string;
}

export interface ScreenContextPayload {
  path: string;
  query?: string;
  title?: string;
  focus?: PageFocus;
  /** Visible text of the page, for screens the server has no reader for. */
  snapshot?: string;
}

const pageFocus = signal<{ path: string; focus: PageFocus } | null>(null);

/** Off for this tab when the owner dismisses the dock's context chip. */
export const screenContextEnabled = signal(true);

/** Pages call this with what is selected; it clears when the page unmounts. */
export function usePageFocus(focus: PageFocus): void {
  const key = JSON.stringify(focus);
  useEffect(() => {
    pageFocus.value = { path: window.location.pathname, focus: JSON.parse(key) as PageFocus };
  }, [key]);
  useEffect(() => () => { pageFocus.value = null; }, []);
}

/** "Zalo › Chat" for a route, or the closest parent route for nested paths. */
export function screenTitle(pathname: string): string | undefined {
  const route = ROUTES
    .filter((r) => pathname === r.path || pathname.startsWith(`${r.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!route) return undefined;
  const section = SECTION_LABEL[route.section];
  return route.section === 'workspace' ? route.label : `${section} › ${route.label}`;
}

/** Payload for the current screen. Reads the page focus signal, so components rerender when it changes. */
export function currentScreenContext(pathname: string, search = ''): ScreenContextPayload {
  const own = pageFocus.value;
  const focus = own && own.path === pathname ? own.focus : undefined;
  // Never forward the dashboard token if the URL still carries it.
  const params = new URLSearchParams(search);
  params.delete('token');
  const query = Array.from(params, ([k, v]) => `${k}=${v}`).join('&').slice(0, 500);
  return {
    path: pathname,
    ...(query ? { query } : {}),
    ...(screenTitle(pathname) ? { title: screenTitle(pathname) } : {}),
    ...(focus && Object.values(focus).some((v) => v !== undefined && v !== '') ? { focus } : {}),
  };
}

const SNAPSHOT_CAP = 12000;
// Screens whose text is private (the chat itself, customer data shown by a module) are never snapshotted.
// Modules register their own prefixes; the core only knows the chat.
const blockedPrefixes: string[] = ['/chat'];

/** A module calls this for screens showing customer data, e.g. blockSnapshotFor('/m/care'). */
export function blockSnapshotFor(prefix: string): void {
  if (!blockedPrefixes.includes(prefix)) blockedPrefixes.push(prefix);
}

export function snapshotBlocked(pathname: string): boolean {
  return blockedPrefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * The page's visible text (the main column only, never the dock), so the
 * agent can read any screen the server has no structured reader for.
 * Read once at send time: innerText forces a layout.
 */
export function captureScreenText(pathname: string): string | undefined {
  if (snapshotBlocked(pathname)) return undefined;
  const main = document.querySelector('main');
  if (!main) return undefined;
  const text = main.innerText.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return undefined;
  return text.length > SNAPSHOT_CAP ? `${text.slice(0, SNAPSHOT_CAP)}…` : text;
}
