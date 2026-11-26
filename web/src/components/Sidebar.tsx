import { ChevronDown, ChevronsLeft, ChevronsRight, Puzzle, Search, X } from 'lucide-preact';
import type { LucideIcon } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { Link, useLocation } from 'wouter-preact';
import { ADVANCED_GROUP, GROUP_ICON, MORE_GROUP_ID, MORE_GROUP_LABEL, NAV_SECTIONS, bestMatch, moduleItemsFor } from '@/lib/nav';
import type { CoreNavItem, NavGroupDef, NavSectionDef } from '@/lib/nav';
import { modKeyLabel } from '@/lib/personalization';
import { navOpen, paletteOpen } from '@/lib/palette';
import { navItems, useBadge } from '@/module-host/host';
import type { HostNavItem } from '@/module-host/host';
import { sseConnected } from '@/lib/sse';

const OPEN_KEY = 'aios.nav.open';
const noop = () => undefined;

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
function ModuleLink({ item, collapsed, active, onBadge, child }: { item: Item; collapsed: boolean; active: boolean; onBadge: (path: string, n: number) => void; child?: boolean }) {
  const badge = useBadge(item.module!);
  useEffect(() => onBadge(item.path, badge ?? 0), [badge]);
  return <NavLink item={item} collapsed={collapsed} active={active} badge={badge} child={child} />;
}

/** Keeps polling badges while the group is closed (renders nothing). */
function BadgeProbe({ item, onBadge }: { item: HostNavItem; onBadge: (path: string, n: number) => void }) {
  const badge = useBadge(item);
  useEffect(() => onBadge(item.path, badge ?? 0), [badge]);
  return null;
}

function NavGroup(props: {
  group: Group;
  activePath: string | undefined;
  collapsed: boolean;
  open: boolean;
  onToggle: (id: string) => void;
}) {
  const { group, activePath, collapsed, open, onToggle } = props;
  const [counts, setCounts] = useState<Record<string, number>>({});
  const onBadge = (path: string, n: number) => setCounts((c) => (c[path] === n ? c : { ...c, [path]: n }));
  const hasActive = group.items.some((i) => i.path === activePath);
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
              <ModuleLink key={i.path} item={i} collapsed={collapsed} active={i.path === activePath} onBadge={onBadge} child />
            ) : (
              <NavLink key={i.path} item={i} collapsed={collapsed} active={i.path === activePath} child />
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

  const toItem = (i: HostNavItem): Item => ({ label: i.label, path: i.path, icon: (i.icon as unknown as LucideIcon | undefined) ?? Puzzle, match: i.match, module: i });
  const moduleNav = navItems.value;
  const sections = NAV_SECTIONS.map((sec) => ({ sec, modules: moduleItemsFor(sec.id, moduleNav).map(toItem) }))
    .filter((x) => x.sec.items.length + x.modules.length > 0);
  const moreGroup: Group = {
    id: MORE_GROUP_ID, label: MORE_GROUP_LABEL, icon: GROUP_ICON[MORE_GROUP_ID] ?? Puzzle,
    items: moduleItemsFor('more', moduleNav).map(toItem),
  };
  const advanced: Group = ADVANCED_GROUP;
  // One owner per page, so /brain/graph lights only "Đồ thị" and not "Second Brain" as well.
  const activePath = bestMatch(loc, [
    ...NAV_SECTIONS.flatMap((x) => x.items), ...advanced.items, ...moduleNav.map(toItem),
  ])?.path;

  // A group is open when the viewer opened it, or when it holds the current page.
  const isOpen = (g: Group) => remembered[g.id] ?? (g.defaultOpen === true || g.items.some((i) => i.path === activePath));
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
    <NavGroup key={g.id} group={g} activePath={activePath} collapsed={collapsed} open={isOpen(g)} onToggle={() => toggle(g)} />
  );
  const renderSection = ({ sec, modules }: { sec: NavSectionDef; modules: Item[] }, first: boolean) => (
    <div key={sec.id} class={`sidebar-section sidebar-section-${sec.tone} snav-section${sec.id === 'top' ? ' snav-section-home' : ''}`} style={first ? { borderTop: 0, marginTop: 0 } : undefined} data-nav-section={sec.id}>
      {sec.label && <div class="snav-caption">{sec.label}</div>}
      <div class="sidebar-section-items">
        {sec.items.map((i) => <NavLink key={i.path} item={i} collapsed={collapsed} active={i.path === activePath} />)}
        {modules.map((i) => <ModuleLink key={i.path} item={i} collapsed={collapsed} active={i.path === activePath} onBadge={noop} />)}
        {sec.id === 'system' && (
          <>
            {renderGroup(advanced)}
            {moreGroup.items.length > 0 && renderGroup(moreGroup)}
          </>
        )}
      </div>
    </div>
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
        {sections.map((x, i) => renderSection(x, i === 0))}
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
