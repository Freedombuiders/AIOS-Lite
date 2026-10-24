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
