// Sound + desktop notification for new customer messages. The per-browser switches live in localStorage and are
// seeded from the owner's saved defaults (`/prefs`: browserSound / browserNotify). Detection is pure.

import type { CareConversationDto } from './dto';

export const ALERT_STORAGE_KEY = 'claudeclaw.care.browserAlerts.v1';

export interface AlertSettings { sound: boolean; notify: boolean }

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Stored choice wins; before the first choice the account defaults apply. Both off when nothing is known. */
export function loadAlertSettings(storage: StorageLike | null, defaults: Partial<AlertSettings> | null): AlertSettings {
  try {
    const raw = storage?.getItem(ALERT_STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Record<string, unknown>;
      return { sound: p.sound === true, notify: p.notify === true };
    }
  } catch {
    /* unreadable: fall through to the defaults */
  }
  return { sound: defaults?.sound === true, notify: defaults?.notify === true };
}

export function saveAlertSettings(storage: StorageLike | null, s: AlertSettings): void {
  try {
    storage?.setItem(ALERT_STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* blocked storage: the switch still works for this tab */
  }
}

/** `lastMessageId` seen per conversation; the notifier compares each refreshed list against it. */
export type SeenMap = Map<string, string | null>;

export function seedSeen(items: CareConversationDto[]): SeenMap {
  return new Map(items.map((c) => [c.id, c.lastMessageId]));
}

function isCustomerMessage(c: CareConversationDto): boolean {
  const p = c.lastMessagePreview;
  return p !== null && p.direction === 'in' && p.senderRole === 'customer';
}

/**
 * Conversations whose newest message is a customer message this browser has not seen yet. A row that was not in the
 * list before counts only when its activity is newer than `sinceMs` (the page was opened), so scrolling in older
 * rows never rings. `seen` is updated in place.
 */
export function detectNewCustomerMessages(seen: SeenMap, items: CareConversationDto[], sinceMs: number): CareConversationDto[] {
  const fresh: CareConversationDto[] = [];
  for (const c of items) {
    const known = seen.has(c.id);
    const changed = known ? seen.get(c.id) !== c.lastMessageId : c.lastActivityMs >= sinceMs;
    seen.set(c.id, c.lastMessageId);
    if (changed && isCustomerMessage(c)) fresh.push(c);
  }
  return fresh;
}

/** Never ring for the conversation that is open in a visible, focused tab: the owner is looking at it. */
export function shouldAlert(c: Pick<CareConversationDto, 'id'>, openId: string | null, focused: boolean): boolean {
  return !(focused && openId !== null && c.id === openId);
}

// ── effects (browser only) ────────────────────────────────────────────────────────────────────
let audio: AudioContext | null = null;

/** Two short sine tones; no audio asset. Browsers only allow it after a user gesture on the page: failures are silent. */
export function playBeep(): void {
  try {
    const Ctor = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audio = audio ?? new Ctor();
    const ctx = audio;
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime;
    for (const [i, freq] of [880, 1175].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + i * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.12, t0 + i * 0.16 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.16 + 0.14);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + i * 0.16);
      osc.stop(t0 + i * 0.16 + 0.15);
    }
  } catch {
    /* no audio device or autoplay policy */
  }
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** Customer name + channel only: message text never leaves the page through the OS notification centre. */
export function showCustomerNotification(title: string, body: string, tag: string, onClick: () => void): void {
  if (notificationPermission() !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => { try { window.focus(); } catch { /* ignore */ } onClick(); n.close(); };
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}
