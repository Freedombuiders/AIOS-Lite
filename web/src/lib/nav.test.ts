import { describe, expect, it } from 'vitest';
import type { NavGroup } from '@/module-host/contracts';
import { ADVANCED_GROUP, BOTTOM_NAV, CORE_NAV, GROUP_LABEL, GROUP_SECTION, NAV_SECTIONS, PLACEHOLDER_PATHS, bestMatch, moduleItemsFor, reachableCorePaths } from './nav';

// Every core route that existed before the new menu (web/src/App.tsx at the time of T10), by path. G3 removed the generic
// Agents list (/agents) and the old agent market (/agent-market): both redirect to Đội AI · Bot (/bots).
const OLD_PATHS = [
  '/', '/tasks', '/schedules', '/chat', '/brain', '/memory', '/skills', '/teams', '/recos', '/usage', '/budgets',
  '/modules', '/connections', '/audit', '/settings',
];
const REMOVED_PATHS = ['/agents', '/agent-market'];

describe('core menu', () => {
  it('still reaches every old page, directly or through "Nâng cao"', () => {
    const reachable = new Set(reachableCorePaths());
    for (const p of OLD_PATHS) expect(reachable.has(p), p).toBe(true);
    for (const p of REMOVED_PATHS) expect(reachable.has(p), p).toBe(false);
  });

  it('folds the rarely used pages into "Nâng cao" and keeps them off the top level', () => {
    const top = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.path));
    const advanced = ADVANCED_GROUP.items.map((i) => i.path);
    expect(advanced).toEqual(['/teams', '/skills', '/memory', '/recos', '/usage', '/budgets', '/audit', '/modules']);
    for (const p of advanced) expect(top).not.toContain(p);
  });

  it('opens the team section with the GenBot screen (Đội AI · Bot), the main way to the agents', () => {
    const team = NAV_SECTIONS.find((s) => s.id === 'system')!;
    expect(team.items[0]).toMatchObject({ label: 'Đội AI · Bot', path: '/bots' });
    expect(team.items.map((i) => i.path)).not.toContain('/agents');
    expect(reachableCorePaths()).toContain('/bots');
  });

  it('has the five sections in order, the first without a caption', () => {
    expect(NAV_SECTIONS.map((s) => s.label)).toEqual([undefined, 'BRAIN', 'CHĂM KHÁCH', 'MARKETING', 'ĐỘI AI VÀ HỆ THỐNG']);
    expect(NAV_SECTIONS[0]!.items.map((i) => i.label)).toEqual(['Hôm nay', 'Gọi trợ lý', 'Trò chuyện']);
  });

  it('lists each path once, so the palette and breadcrumb have no duplicates', () => {
    const all = [...CORE_NAV, ...BOTTOM_NAV].map((i) => i.path);
    expect(new Set(all).size).toBe(all.length);
    for (const p of OLD_PATHS) expect(all).toContain(p);
  });

  it('marks the pages that are not built yet', () => {
    expect(PLACEHOLDER_PATHS).toEqual(['/voice', '/brain/graph']);
    const all = CORE_NAV.map((i) => i.path);
    for (const p of PLACEHOLDER_PATHS) expect(all).toContain(p);
  });
});

describe('module groups', () => {
  const GROUPS: NavGroup[] = ['studio', 'sales', 'care', 'brain', 'marketing', 'finance', 'ops', 'other'];

  it('maps every group, old and new, to a section', () => {
    for (const g of GROUPS) expect(GROUP_SECTION[g], g).toBeDefined();
    expect(GROUP_SECTION).toMatchObject({
      sales: 'care', care: 'care', brain: 'brain', marketing: 'marketing', studio: 'marketing', finance: 'more', ops: 'more', other: 'more',
    });
    for (const g of GROUPS) expect(GROUP_LABEL[g], g).toBeTruthy();
  });

  it('sorts module items into their sections and leaves none out', () => {
    const items = GROUPS.map((group) => ({ group, path: `/m/${group}` }));
    const sections = ['brain', 'care', 'marketing', 'more'] as const;
    const placed = sections.flatMap((s) => moduleItemsFor(s, items).map((i) => i.group));
    expect(placed.sort()).toEqual([...GROUPS].sort());
    expect(moduleItemsFor('care', items).map((i) => i.group).sort()).toEqual(['care', 'sales']);
    expect(moduleItemsFor('marketing', items).map((i) => i.group).sort()).toEqual(['marketing', 'studio']);
    expect(moduleItemsFor('more', items).map((i) => i.group).sort()).toEqual(['finance', 'ops', 'other']);
  });
});

describe('bestMatch', () => {
  const items = [{ path: '/brain' }, { path: '/brain/graph' }, { path: '/' }, { path: '/m/x', match: ['/m/x-extra'] }];
  it('gives one owner to nested paths', () => {
    expect(bestMatch('/brain/graph', items)?.path).toBe('/brain/graph');
    expect(bestMatch('/brain/search', items)?.path).toBe('/brain');
    expect(bestMatch('/', items)?.path).toBe('/');
    expect(bestMatch('/m/x-extra/1', items)?.path).toBe('/m/x');
  });
  it('gives none when nothing matches', () => {
    expect(bestMatch('/nope', items)).toBeUndefined();
  });
});
