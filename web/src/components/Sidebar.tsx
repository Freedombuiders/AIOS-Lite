import { ChevronsLeft, ChevronsRight, Puzzle, Search, X } from 'lucide-preact';
import type { LucideIcon } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { Link, useLocation } from 'wouter-preact';
import { BOTTOM_NAV, GROUP_LABEL, GROUP_ORDER, HOME_NAV, WORK_NAV, isActive } from '@/lib/nav';
import { modKeyLabel } from '@/lib/personalization';
import { navOpen, paletteOpen } from '@/lib/palette';
import type { CoreNavItem } from '@/lib/nav';
import { navItems, useBadge } from '@/module-host/host';
import type { HostNavItem } from '@/module-host/host';
import { sseConnected } from '@/lib/sse';

// Module groups reuse the owner's section colours (sidebar-section-* in main.css).
const GROUP_CLASS: Record<string, string> = { sales: 'care', marketing: 'marketing', ops: 'collaborate', other: 'intelligence' };

function NavLink({ item, collapsed, active, badge }: { item: CoreNavItem; collapsed: boolean; active: boolean; badge?: number }) {
  const Icon = item.icon;
  return (
    <Link href={item.path} title={collapsed ? item.label : undefined} class={`sidebar-nav-link${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined}>
      <span class="sidebar-route-icon"><Icon size={16} /></span>
      <span class="sidebar-label">{item.label}</span>
      {badge !== undefined && badge > 0 && <span class="sidebar-unread">{badge}</span>}
    </Link>
  );
}

function ModuleLink({ item, collapsed, active }: { item: HostNavItem; collapsed: boolean; active: boolean }) {
  const badge = useBadge(item);
  const icon = (item.icon as unknown as LucideIcon | undefined) ?? Puzzle;
  return <NavLink item={{ label: item.label, path: item.path, icon, match: item.match }} collapsed={collapsed} active={active} badge={badge} />;
}

export function Sidebar() {
  const [loc] = useLocation();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('aios.sidebar') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('aios.sidebar', collapsed ? '1' : '0');
    } catch {
      /* storage blocked */
    }
  }, [collapsed]);

  const items = navItems.value;
  const open = navOpen.value;
  // Mobile drawer closes on navigation.
  useEffect(() => {
    navOpen.value = false;
  }, [loc]);
  return (
    <aside class={`saas-sidebar${collapsed ? ' is-collapsed' : ''}${open ? ' is-open' : ''}`}>
      <div class="sidebar-header">
        <div class="sidebar-brand">
          <span class="sidebar-brand-mark">A</span>
          <span class="sidebar-brand-copy">
            <span class="sidebar-brand-name">AIOS-Lite</span>
            <span class="sidebar-brand-caption">Hệ điều hành agent</span>
          </span>
          <button type="button" class="sidebar-icon-button md:hidden" aria-label="Đóng menu" onClick={() => { navOpen.value = false; }}>
            <X size={16} />
          </button>
        </div>
        <div class="sidebar-header-controls">
          <button type="button" class="sidebar-icon-button sidebar-desktop-toggle" aria-label={collapsed ? 'Mở rộng thanh bên' : 'Thu gọn thanh bên'} onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
          </button>
        </div>
      </div>

      <div class="sidebar-tools">
        <button type="button" class="sidebar-tool sidebar-search" title="Tìm nhanh trang" onClick={() => { paletteOpen.value = true; }}>
          <Search size={16} />
          <span class="sidebar-label">Tìm nhanh…</span>
          <kbd class="sidebar-shortcut">{modKeyLabel()}K</kbd>
        </button>
      </div>

      <nav class="sidebar-navigation snav" aria-label="Điều hướng chính">
        <div class="sidebar-section sidebar-section-workspace" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
          <div class="sidebar-section-items">
            <NavLink item={HOME_NAV} collapsed={collapsed} active={isActive(loc, HOME_NAV)} />
          </div>
        </div>
        <div class="sidebar-section sidebar-section-workspace">
          <div class="snav-caption">WORKSPACE</div>
          <div class="sidebar-section-items">
            {WORK_NAV.map((i) => <NavLink key={i.path} item={i} collapsed={collapsed} active={isActive(loc, i)} />)}
          </div>
        </div>
        {GROUP_ORDER.map((g) => {
          const group = items.filter((i) => i.group === g);
          if (!group.length) return null;
          return (
            <div key={g} class={`sidebar-section sidebar-section-${GROUP_CLASS[g]}`}>
              <div class="snav-caption">{GROUP_LABEL[g].toUpperCase()}</div>
              <div class="sidebar-section-items">
                {group.map((i) => <ModuleLink key={i.path} item={i} collapsed={collapsed} active={isActive(loc, i)} />)}
              </div>
            </div>
          );
        })}
        <div class="sidebar-section sidebar-section-configure">
          <div class="snav-caption">HỆ THỐNG</div>
          <div class="sidebar-section-items">
            {BOTTOM_NAV.map((i) => <NavLink key={i.path} item={i} collapsed={collapsed} active={isActive(loc, i)} />)}
          </div>
        </div>
      </nav>

      <div class="sidebar-footer">
        <div class="sidebar-status-link" title={sseConnected.value ? 'Đang kết nối trực tiếp' : 'Mất kết nối, đang thử lại…'}>
          <div class="sidebar-status-summary">
            <span class={`dot ${sseConnected.value ? 'dot-success' : 'dot-error'}`} />
            <span class="sidebar-status-copy" style={{ fontSize: 12 }}>{sseConnected.value ? 'Đang kết nối trực tiếp' : 'Mất kết nối, đang thử lại…'}</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
