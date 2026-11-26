import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CareAccountDto } from '@modules/care/web/lib/care/dto';
import { parseUsage } from '@modules/care/web/lib/care/useZaloUsage';
import { NickPicker, connectionOf, usageText } from './NickPicker';

const host = document.createElement('div'); document.body.append(host);
afterEach(() => { act(() => render(null, host)); });

const acct = (over: Partial<CareAccountDto> = {}): CareAccountDto => ({
  id: 'a1', channel: 'zalo', connectorKind: 'zalo-zca', nativeAccountId: 'n1', label: 'Nick Trà Sen Việt', desiredState: 'active', healthStatus: 'healthy', syncEnabled: true,
  sendEnabled: true, aiEnabled: true, writeOwner: 'core', ownerEpoch: 1, updatedAtMs: 0, signature: null, ...over,
});

describe('nick picker', () => {
  it('shows the nick, its connection state and today\'s sent against the cap', () => {
    act(() => render(<NickPicker accounts={[acct()]} value="a1" usage={{ sentToday: 46, cap: 200 }} onChange={() => undefined} />, host));
    expect(host.querySelector('.care-nick-name')?.textContent).toBe('Nick Trà Sen Việt');
    expect(host.querySelector('[data-testid="care-nick-sub"]')?.textContent).toBe('Đang kết nối · hôm nay đã gửi 46/200 tin');
  });

  it('says so when the usage is unknown or has no cap, and picks another nick through the select', () => {
    const onChange = vi.fn();
    act(() => render(<NickPicker accounts={[acct(), acct({ id: 'a2', label: 'Nick Hai' })]} value="a1" usage={null} onChange={onChange} />, host));
    expect(host.querySelector('[data-testid="care-nick-sub"]')?.textContent).toBe('Đang kết nối');
    const sel = host.querySelector('select') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(['Tất cả nick', 'Nick Trà Sen Việt', 'Nick Hai']);
    act(() => { sel.value = 'a2'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onChange).toHaveBeenCalledWith('a2');
    expect(usageText({ sentToday: 3, cap: null })).toBe('hôm nay đã gửi 3 tin');
  });

  it('reads the usage answer of the zalo module and ignores anything else', () => {
    expect(parseUsage({ accountId: 'a1', day: '2026-11-26', sentToday: 12, cap: 200, burst: {}, warmup: {} })).toEqual({ sentToday: 12, cap: 200 });
    expect(parseUsage({ sentToday: 4, cap: null })).toEqual({ sentToday: 4, cap: null });
    expect(parseUsage({ error: 'x' })).toBeNull();
    expect(parseUsage(null)).toBeNull();
  });

  it('names a degraded, failing or stopped connection', () => {
    expect(connectionOf(acct({ healthStatus: 'degraded' })).text).toBe('Kết nối chập chờn');
    expect(connectionOf(acct({ healthStatus: 'error' })).text).toBe('Mất kết nối');
    expect(connectionOf(acct({ desiredState: 'paused' })).text).toBe('Tạm dừng');
    expect(connectionOf(acct({ desiredState: 'disconnected' })).text).toBe('Đã ngắt');
  });
});
