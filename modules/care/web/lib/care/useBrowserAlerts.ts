// Browser sound + notification on new customer messages, and the "(N) Hộp thư chung" tab title.

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  ALERT_STORAGE_KEY, detectNewCustomerMessages, loadAlertSettings, notificationPermission, playBeep, requestNotificationPermission, saveAlertSettings,
  seedSeen, shouldAlert, showCustomerNotification, type AlertSettings, type SeenMap,
} from './browserAlerts';
import type { CareConversationDto } from './dto';

interface CareOwnerAlertPrefsDto { browserSound: boolean; browserNotify: boolean }
import { ct } from './i18n';
import { documentTitle } from './inboxView';
import { pushToast } from '@/lib/toasts';

function storage(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

function hasStoredChoice(): boolean {
  try { return storage()?.getItem(ALERT_STORAGE_KEY) != null; } catch { return false; }
}

/** `(N) Hộp thư chung` while N conversations need the owner; the previous title comes back when the page is left. */
export function useInboxTitle(base: string, needsMe: number | null): void {
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (previous.current === null) previous.current = document.title;
    document.title = documentTitle(base, needsMe);
  }, [base, needsMe]);
  useEffect(() => () => { if (previous.current !== null) document.title = previous.current; }, []);
}

export function useBrowserAlerts(args: {
  items: CareConversationDto[];
  loading: boolean;
  /** Changes with the filter set: the next list is a different slice, not "new messages". */
  resetKey: string;
  openId: string | null;
  prefs: Pick<CareOwnerAlertPrefsDto, 'browserSound' | 'browserNotify'> | null;
  titleOf: (c: CareConversationDto) => string;
  onOpen: (id: string) => void;
}) {
  const { items, loading, resetKey, openId, prefs } = args;
  const [settings, setSettings] = useState<AlertSettings>(() => loadAlertSettings(storage(), null));
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const seen = useRef<SeenMap | null>(null);
  const seenKey = useRef<string | null>(null);
  const since = useRef(Date.now());
  const latest = useRef(args);
  latest.current = args;

  // No choice made in this browser yet: the account defaults apply.
  useEffect(() => {
    if (prefs && !hasStoredChoice()) setSettings(loadAlertSettings(null, { sound: prefs.browserSound, notify: prefs.browserNotify }));
  }, [prefs?.browserSound, prefs?.browserNotify]);

  useEffect(() => {
    if (loading) return;
    if (seen.current === null || seenKey.current !== resetKey) {
      seen.current = seedSeen(items);
      seenKey.current = resetKey;
      return;
    }
    const fresh = detectNewCustomerMessages(seen.current, items, since.current);
    const focused = typeof document !== 'undefined' && document.hasFocus() && !document.hidden;
    const worth = fresh.filter((c) => shouldAlert(c, openId, focused));
    if (worth.length === 0) return;
    const s = settingsRef.current;
    if (s.sound) playBeep();
    if (s.notify) {
      for (const c of worth.slice(0, 3)) {
        showCustomerNotification(ct('inbox2.alerts.notifyTitle'), `${latest.current.titleOf(c)} · ${ct(`channel.${c.channel}`)}`, `care-${c.id}`, () => latest.current.onOpen(c.id));
      }
    }
  }, [items, loading, resetKey, openId]);

  const update = useCallback((next: AlertSettings) => {
    setSettings(next);
    saveAlertSettings(storage(), next);
  }, []);

  const toggleSound = useCallback(() => {
    const on = !settingsRef.current.sound;
    if (on) playBeep(); // also unlocks audio, which browsers allow only after a click
    update({ ...settingsRef.current, sound: on });
  }, [update]);

  const toggleNotify = useCallback(async () => {
    if (settingsRef.current.notify) { update({ ...settingsRef.current, notify: false }); return; }
    const perm = notificationPermission() === 'granted' ? 'granted' : await requestNotificationPermission();
    if (perm !== 'granted') {
      pushToast({ tone: 'warn', title: perm === 'unsupported' ? ct('inbox2.alerts.unsupported') : ct('inbox2.alerts.denied') });
      return;
    }
    update({ ...settingsRef.current, notify: true });
  }, [update]);

  return { settings, toggleSound, toggleNotify, permission: notificationPermission() };
}
