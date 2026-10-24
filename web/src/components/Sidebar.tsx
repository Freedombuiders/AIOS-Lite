import { ChevronDown, ChevronsLeft, ChevronsRight, Puzzle, Search, X } from 'lucide-preact';
import type { LucideIcon } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { Link, useLocation } from 'wouter-preact';
import { AGENT_GROUPS, GROUP_ICON, GROUP_LABEL, GROUP_ORDER, HOME_NAV, SYSTEM_GROUP, WORK_GROUP, isActive } from '@/lib/nav';
import type { CoreNavItem, NavGroupDef } from '@/lib/nav';
import { modKeyLabel } from '@/lib/personalization';
import { navOpen, paletteOpen } from '@/lib/palette';
import { navItems, useBadge } from '@/module-host/host';
import type { HostNavItem } from '@/module-host/host';
import { sseConnected } from '@/lib/sse';

// Module groups reuse the owner's section colours (sidebar-section-* in main.css).
const GROUP_CLASS: Record<string, string> = { sales: 'care', marketing: 'marketing', ops: 'collaborate', other: 'intelligence' };
const OPEN_KEY = 'aios.nav.open';

type Item = CoreNavItem & { module?: HostNavItem };
type Group = Omit<NavGroupDef, 'items'> & { items: Item[] };

function readOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

function NavLink({ item, collapsed, active, badge, child }: { item: CoreNavItem; collapsed: boolean; active: boolean; badge?: number; child?: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.path}
      title={collapsed ? item.label : undefined}
      class={`sidebar-nav-link${child ? ' snav-child' : ''}${active ? ' is-active' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      <span class="sidebar-route-icon"><Icon size={child ? 14 : 16} /></span>
      <span class="sidebar-label">{item.label}</span>
      {badge !== undefined && badge > 0 && <span class="sidebar-unread">{badge}</span>}
    </Link>
  );
}

/** A module nav row: polls its own badge and reports it so a closed group can show the total. */
function ModuleLink({ item, collapsed, active, onBadge }: { item: Item; collapsed: boolean; active: boolean; onBadge: (path: string, n: number) => void }) {
  const badge = useBadge(item.module!);
  useEffect(() => onBadge(item.path, badge ?? 0), [badge]);
  return <NavLink item={item} collapsed={collapsed} active={active} badge={badge} child />;
}

/** Keeps polling badges while the group is closed (renders nothing). */
function BadgeProbe({ item, onBadge }: { item: HostNavItem; onBadge: (path: string, n: number) => void }) {
  const badge = useBadge(item);
  useEffect(() => onBadge(item.path, badge ?? 0), [badge]);
  return null;
}

function NavGroup(props: {
  group: Group;
  loc: string;
  collapsed: boolean;
  open: boolean;
  onToggle: (id: string) => void;
}) {
  const { group, loc, collapsed, open, onToggle } = props;
  const [counts, setCounts] = useState<Record<string, number>>({});
  const onBadge = (path: string, n: number) => setCounts((c) => (c[path] === n ? c : { ...c, [path]: n }));
  const hasActive = group.items.some((i) => isActive(loc, i));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const Icon = group.icon;
  const panelId = `snav-group-${group.id}`;
  return (
    <div class={`snav-group${open ? ' is-open' : ''}${hasActive ? ' has-active' : ''}`}>
      <button
        type="button"
        class={`sidebar-nav-link snav-group-toggle${hasActive && (!open || collapsed) ? ' is-active' : ''}`}
        aria-expanded={open}
        aria-controls={panelId}
        title={collapsed ? group.label : undefined}
        onClick={() => onToggle(group.id)}
      >
        <span class="sidebar-route-icon"><Icon size={16} /></span>
        <span class="sidebar-label">{group.label}</span>
        {!open && total > 0 && <span class="sidebar-unread">{total}</span>}
        <ChevronDown size={14} class="snav-chevron" />
      </button>
      {open && !collapsed ? (
        <div class="snav-children" id={panelId}>
          {group.items.map((i) =>
            i.module ? (
              <ModuleLink key={i.path} item={i} collapsed={collapsed} active={isActive(loc, i)} onBadge={onBadge} />
            ) : (
              <NavLink key={i.path} item={i} collapsed={collapsed} active={isActive(loc, i)} child />
            ),
          )}
        </div>
      ) : (
        group.items.filter((i) => i.module).map((i) => <BadgeProbe key={i.path} item={i.module!} onBadge={onBadge} />)
      )}
    </div>
  );
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
  const [remembered, setRemembered] = useState<Record<string, boolean>>(readOpen);
  useEffect(() => {
    try {
      localStorage.setItem('aios.sidebar', collapsed ? '1' : '0');
    } catch {
      /* storage blocked */
    }
  }, [collapsed]);
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(remembered));
    } catch {
      /* storage blocked */
    }
  }, [remembered]);

  const open = navOpen.value;
  // Mobile drawer closes on navigation.
  useEffect(() => {
    navOpen.value = false;
  }, [loc]);

  const moduleGroups = GROUP_ORDER.map((g) => {
    const items: Item[] = navItems.value
      .filter((i) => i.group === g)
      .map((i) => ({ label: i.label, path: i.path, icon: (i.icon as unknown as LucideIcon | undefined) ?? Puzzle, match: i.match, module: i }));
    return { id: g, label: GROUP_LABEL[g] ?? g, icon: GROUP_ICON[g] ?? Puzzle, items, cls: GROUP_CLASS[g] };
  }).filter((g) => g.items.length > 0);

  // A group is open when the viewer opened it, or when it holds the current page.
  const isOpen = (g: Group) => remembered[g.id] ?? (g.defaultOpen === true || g.items.some((i) => isActive(loc, i)));
  const toggle = (g: Group) => {
    if (collapsed) {
      // Icon rail: expand the sidebar and open the clicked group.
      setCollapsed(false);
      setRemembered((r) => ({ ...r, [g.id]: true }));
      return;
    }
    setRemembered((r) => ({ ...r, [g.id]: !isOpen(g) }));
  };
  const renderGroup = (g: Group) => (
    <NavGroup key={g.id} group={g} loc={loc} collapsed={collapsed} open={isOpen(g)} onToggle={() => toggle(g)} />
  );

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
        <div class="sidebar-section sidebar-section-workspace snav-section snav-section-home" style={{ borderTop: 0, marginTop: 0 }}>
          <div class="sidebar-section-items">
            <NavLink item={HOME_NAV} collapsed={collapsed} active={isActive(loc, HOME_NAV)} />
          </div>
        </div>
        <div class="sidebar-section sidebar-section-workspace snav-section">
          <div class="snav-caption">WORKSPACE</div>
          <div class="sidebar-section-items">{renderGroup(WORK_GROUP)}</div>
        </div>
        {moduleGroups.length > 0 && (
          <div class="sidebar-section snav-section">
            <div class="snav-caption">NGHIỆP VỤ</div>
            {moduleGroups.map((g) => (
              <div key={g.id} class={`sidebar-section-${g.cls}`}>
                <div class="sidebar-section-items">{renderGroup(g)}</div>
              </div>
            ))}
          </div>
        )}
        <div class="sidebar-section sidebar-section-intelligence snav-section">
          <div class="snav-caption">AGENTS &amp; TRI THỨC</div>
          <div class="sidebar-section-items">{AGENT_GROUPS.map(renderGroup)}</div>
        </div>
        <div class="sidebar-section sidebar-section-configure snav-section">
          <div class="sidebar-section-items">{renderGroup(SYSTEM_GROUP)}</div>
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
