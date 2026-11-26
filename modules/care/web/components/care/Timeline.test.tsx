import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyWindow } from '@modules/care/web/lib/care/cursor';
import { msg } from '@modules/care/web/lib/care/fixtures.test-util';
import { Timeline } from './Timeline';

const host = document.createElement('div'); document.body.append(host);
afterEach(() => { act(() => render(null, host)); });

function show(over: { olderCursor: string | null; loadingOlder?: boolean }, onLoadOlder = vi.fn()) {
  const w = { ...emptyWindow(), items: [msg({ id: 'm2', senderRole: 'operator', direction: 'out', text: 'Dạ em chào chị' }), msg({ id: 'm1' })], olderCursor: over.olderCursor };
  act(() => render(
    <Timeline window={w} channel="zalo" notes={[]} busyNote={null} onDeleteNote={() => undefined} hitId={null} tracked={[]} busyIntent={null}
      loadingOlder={over.loadingOlder ?? false} loadingNewer={false} onLoadOlder={onLoadOlder} onLoadNewer={() => undefined} onCancel={() => undefined} onReconcile={() => undefined} />, host));
  return onLoadOlder;
}
const scroller = () => host.querySelector('[data-testid="care-timeline"]') as HTMLElement;

describe('timeline history', () => {
  it('loads the older page when the reader scrolls up to the top', () => {
    const onLoadOlder = show({ olderCursor: 'c1' });
    act(() => { scroller().scrollTop = 0; scroller().dispatchEvent(new Event('scroll')); });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing when there is no older page, or one is already loading', () => {
    let fn = show({ olderCursor: null });
    act(() => { scroller().dispatchEvent(new Event('scroll')); });
    expect(fn).not.toHaveBeenCalled();
    fn = show({ olderCursor: 'c1', loadingOlder: true });
    act(() => { scroller().dispatchEvent(new Event('scroll')); });
    expect(fn).not.toHaveBeenCalled();
  });

  it('keeps the four sender roles apart: the owner from the phone is marked "gửi ngoài app", the dashboard and the bot are not', () => {
    const w = { ...emptyWindow(), items: [
      msg({ id: 'a', senderRole: 'agent', direction: 'out', text: 'bot nói' }),
      msg({ id: 'b', senderRole: 'operator', direction: 'out', text: 'nhân viên nói' }),
      msg({ id: 'c', senderRole: 'self', direction: 'out', text: 'chủ nói trên điện thoại' }),
      msg({ id: 'd', senderRole: 'customer', text: 'khách nói' }),
    ] };
    act(() => render(
      <Timeline window={w} channel="zalo" notes={[]} busyNote={null} onDeleteNote={() => undefined} hitId={null} tracked={[]} busyIntent={null}
        loadingOlder={false} loadingNewer={false} onLoadOlder={() => undefined} onLoadNewer={() => undefined} onCancel={() => undefined} onReconcile={() => undefined} />, host));
    const roles = [...host.querySelectorAll('[data-sender-role]')].map((e) => e.getAttribute('data-sender-role'));
    expect(new Set(roles)).toEqual(new Set(['agent', 'operator', 'self', 'customer']));
    const marked = [...host.querySelectorAll('[data-testid="care-outside-app"]')];
    expect(marked).toHaveLength(1);
    expect(marked[0]!.closest('[data-sender-role]')?.getAttribute('data-sender-role')).toBe('self');
    expect(marked[0]!.textContent).toBe('gửi ngoài app');
    expect([...host.querySelectorAll('.care-msg.is-incoming')].map((e) => e.getAttribute('data-sender-role'))).toEqual(['customer']);
    expect(new Set([...host.querySelectorAll('.care-msg.is-outgoing')].map((e) => e.getAttribute('data-sender-role')))).toEqual(new Set(['agent', 'operator', 'self']));
  });
});
