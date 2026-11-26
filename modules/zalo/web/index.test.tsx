import { render } from 'preact';
import { describe, expect, it } from 'vitest';
import zaloWeb from './index';
import { ZaloChannelPanel } from './components/ZaloChannelPanel';

describe('zalo web module', () => {
  it('puts the account page under Sales and the four campaign pages under Marketing', () => {
    const nav = zaloWeb.nav ?? [];
    expect(nav.filter((n) => n.group === 'sales').map((n) => n.label)).toEqual(['Zalo · Tài khoản']);
    expect(nav.filter((n) => n.group === 'marketing').map((n) => n.label)).toEqual(['Mẫu tin Zalo', 'Gửi nhóm', 'Gửi 1-1', 'Sinh nhật']);
    const paths = new Set((zaloWeb.routes ?? []).map((r) => r.path));
    for (const n of nav) expect(paths.has(n.path), n.path).toBe(true);
    for (const r of zaloWeb.routes ?? []) expect(r.path.startsWith('/m/zalo')).toBe(true);
  });

  it('shows the marketing menu items and pages only while marketingEnabled is on (default off)', () => {
    const marketingNav = (zaloWeb.nav ?? []).filter((n) => n.group === 'marketing');
    expect(marketingNav).toHaveLength(4);
    for (const n of marketingNav) {
      expect(n.visible?.({}), n.label).toBe(false);
      expect(n.visible?.({ marketingEnabled: false }), n.label).toBe(false);
      expect(n.visible?.({ marketingEnabled: true }), n.label).toBe(true);
    }
    const accounts = (zaloWeb.nav ?? []).find((n) => n.group === 'sales')!;
    expect(accounts.visible).toBeUndefined();
    const marketingPaths = new Set(marketingNav.map((n) => n.path));
    const routes = zaloWeb.routes ?? [];
    for (const r of routes.filter((r) => marketingPaths.has(r.path))) expect(r.visible?.({}), r.path).toBe(false);
    expect(routes.find((r) => r.path === '/m/zalo')!.visible).toBeUndefined();
  });

  it('offers the care channel panel, which renders nothing for another channel', () => {
    expect(zaloWeb.provides?.['care.channelPanel']).toBe(ZaloChannelPanel);
    const host = document.createElement('div');
    render(<ZaloChannelPanel channel="email" accountId="a1" />, host);
    expect(host.innerHTML).toBe('');
  });

  it('declares labels for both agent scopes', () => {
    expect((zaloWeb.agentAccess ?? []).map((a) => a.scope).sort()).toEqual(['broadcast.manage', 'messages.read']);
  });
});
