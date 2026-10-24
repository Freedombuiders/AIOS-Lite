import { describe, expect, it } from 'vitest';
import { ALERT_STORAGE_KEY, detectNewCustomerMessages, loadAlertSettings, saveAlertSettings, seedSeen, shouldAlert, type StorageLike } from './browserAlerts';
import { conv } from './fixtures.test-util';
import type { CareConversationDto } from './dto';

function memory(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } };
}

const inbound = (id: string, lastMessageId: string, activity = 2000): CareConversationDto => conv({
  id, lastMessageId, lastActivityMs: activity,
  lastMessagePreview: { messageId: lastMessageId, text: 'hi', truncated: false, direction: 'in', senderRole: 'customer', sentAtMs: activity },
});
const outbound = (id: string, lastMessageId: string): CareConversationDto => conv({
  id, lastMessageId, lastActivityMs: 3000,
  lastMessagePreview: { messageId: lastMessageId, text: 'ok', truncated: false, direction: 'out', senderRole: 'operator', sentAtMs: 3000 },
});

describe('alert settings (per browser, seeded from the account defaults)', () => {
  it('before any choice the account defaults apply; both off when nothing is known', () => {
    expect(loadAlertSettings(memory(), { sound: true, notify: false })).toEqual({ sound: true, notify: false });
    expect(loadAlertSettings(memory(), null)).toEqual({ sound: false, notify: false });
    expect(loadAlertSettings(null, { sound: true })).toEqual({ sound: true, notify: false });
  });
  it('a stored choice wins over the defaults, including "off"', () => {
    const s = memory();
    saveAlertSettings(s, { sound: false, notify: true });
    expect(s.map.has(ALERT_STORAGE_KEY)).toBe(true);
    expect(loadAlertSettings(s, { sound: true, notify: false })).toEqual({ sound: false, notify: true });
  });
  it('unreadable storage falls back to the defaults', () => {
    const s = memory();
    s.map.set(ALERT_STORAGE_KEY, '{nope');
    expect(loadAlertSettings(s, { sound: true })).toEqual({ sound: true, notify: false });
  });
});

describe('detecting new customer messages', () => {
  it('rings for a known conversation whose newest message is a new customer message', () => {
    const seen = seedSeen([inbound('a', 'm1'), inbound('b', 'm1')]);
    const fresh = detectNewCustomerMessages(seen, [inbound('a', 'm2'), inbound('b', 'm1')], 1000);
    expect(fresh.map((c) => c.id)).toEqual(['a']);
    // the same list again: nothing new
    expect(detectNewCustomerMessages(seen, [inbound('a', 'm2'), inbound('b', 'm1')], 1000)).toEqual([]);
  });
  it('never rings for our own reply or for a changed row that is not a customer message', () => {
    const seen = seedSeen([inbound('a', 'm1')]);
    expect(detectNewCustomerMessages(seen, [outbound('a', 'm2')], 1000)).toEqual([]);
  });
  it('a row that was not in the list rings only when its activity is newer than the page open time', () => {
    const seen = seedSeen([]);
    expect(detectNewCustomerMessages(seen, [inbound('old', 'm1', 500)], 1000)).toEqual([]);
    expect(detectNewCustomerMessages(seen, [inbound('new', 'm1', 1500)], 1000).map((c) => c.id)).toEqual(['new']);
  });
  it('seeding from the first load does not ring', () => {
    const items = [inbound('a', 'm1'), inbound('b', 'm1')];
    expect(detectNewCustomerMessages(seedSeen(items), items, 0)).toEqual([]);
  });
});

describe('who gets an alert', () => {
  it('not the conversation that is open in a focused tab', () => {
    expect(shouldAlert({ id: 'a' }, 'a', true)).toBe(false);
    expect(shouldAlert({ id: 'a' }, 'a', false)).toBe(true); // tab in the background: ring
    expect(shouldAlert({ id: 'b' }, 'a', true)).toBe(true);
    expect(shouldAlert({ id: 'a' }, null, true)).toBe(true);
  });
});
