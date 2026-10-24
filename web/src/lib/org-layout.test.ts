import { describe, expect, it } from 'vitest';
import {
  CARD_H, CARD_W, GAP_X, GAP_Y, MAX_ZOOM, MIN_ZOOM, OWNER_ID, PADDING, READABLE_ZOOM, READABLE_ZOOM_PHONE,
  buildTree, chartBounds, clampZoom, collectEdges, edgePath, fitToViewport, flattenLayout, initialView, layoutTree, ownerCenterX,
  subtreeWidth, zoomAround, type OrgNodeDto,
} from './org-layout';
import { agentHref, managerChoices, runningTaskByAgent, sidebarAgents, teamSummary } from './org-view';

const n = (id: string, reportsTo: string | null = null, running = false): OrgNodeDto => ({ id, name: id, reportsTo, running });

describe('buildTree', () => {
  it('hangs unmanaged agents off the owner and nests the rest', () => {
    const t = buildTree([n('main'), n('a', 'main'), n('b', 'a'), n('c')]);
    expect(t.id).toBe(OWNER_ID);
    expect(t.children.map((c) => c.id)).toEqual(['main', 'c']);
    expect(t.children[0].children[0].children[0].id).toBe('b');
  });

  it('treats an unknown manager as the owner and never drops or duplicates an agent in a loop', () => {
    const t = buildTree([n('x', 'ghost'), n('p', 'q'), n('q', 'p'), n('s', 's')]);
    const ids: string[] = [];
    const walk = (node: typeof t) => { ids.push(node.id); node.children.forEach(walk); };
    walk(t);
    expect(ids.sort()).toEqual([OWNER_ID, 'p', 'q', 's', 'x']);
  });

  it('is an owner-only tree when there are no agents', () => {
    expect(buildTree([]).children).toEqual([]);
  });
});

describe('layout', () => {
  it('a leaf is one card wide; a parent is as wide as its children plus gaps', () => {
    const leaf = buildTree([]);
    expect(subtreeWidth(leaf)).toBe(CARD_W);
    const t = buildTree([n('a'), n('b'), n('c')]);
    expect(subtreeWidth(t)).toBe(3 * CARD_W + 2 * GAP_X);
  });

  it('centers a parent over its children and puts children one row down', () => {
    const t = buildTree([n('a'), n('b', 'a'), n('c', 'a')]);
    const root = layoutTree(t);
    const a = root.children[0];
    const [b, c] = a.children;
    expect(b.y).toBe(a.y + CARD_H + GAP_Y);
    expect(c.x - b.x).toBe(CARD_W + GAP_X);
    expect(a.x + CARD_W / 2).toBeCloseTo((b.x + CARD_W / 2 + c.x + CARD_W / 2) / 2);
    expect(root.x + CARD_W / 2).toBeCloseTo(a.x + CARD_W / 2);
  });

  it('never overlaps two cards on the same row, for an uneven tree', () => {
    const t = buildTree([n('a'), n('b'), n('a1', 'a'), n('a2', 'a'), n('a3', 'a'), n('b1', 'b'), n('a1x', 'a1'), n('a1y', 'a1')]);
    const flat = flattenLayout(layoutTree(t));
    expect(flat).toHaveLength(9);
    const rows = new Map<number, number[]>();
    for (const f of flat) rows.set(f.y, [...(rows.get(f.y) ?? []), f.x]);
    for (const xs of rows.values()) {
      xs.sort((p, q) => p - q);
      for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(CARD_W + GAP_X - 1e-9);
    }
  });

  it('collects one edge per non-root node and draws an elbow', () => {
    const root = layoutTree(buildTree([n('a'), n('b', 'a')]));
    const edges = collectEdges(root);
    expect(edges).toHaveLength(2);
    expect(edgePath(edges[0].parent, edges[0].child)).toMatch(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+ L [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/);
  });

  it('bounds cover every card plus padding', () => {
    const flat = flattenLayout(layoutTree(buildTree([n('a'), n('b'), n('c')])));
    const b = chartBounds(flat);
    expect(b.width).toBe(PADDING * 2 + 3 * CARD_W + 2 * GAP_X);
    expect(b.height).toBe(PADDING * 2 + 2 * CARD_H + GAP_Y);
    expect(chartBounds([]).width).toBeGreaterThan(0);
  });
});

describe('zoom and fit', () => {
  it('clamps zoom', () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(9)).toBe(MAX_ZOOM);
    expect(clampZoom(1.2)).toBe(1.2);
  });

  it('fit centers a small chart at zoom 1 and shrinks a big one', () => {
    const small = fitToViewport(1000, 800, { width: 400, height: 300 })!;
    expect(small.zoom).toBe(1);
    expect(small.pan).toEqual({ x: 300, y: 250 });
    const big = fitToViewport(500, 500, { width: 2000, height: 400 })!;
    expect(big.zoom).toBeCloseTo((500 - 32) / 2000);
    expect(fitToViewport(10, 10, { width: 1, height: 1 })).toBeNull();
  });

  it('initialView keeps a wide chart readable on a phone and anchors on the owner', () => {
    const bounds = { width: 2000, height: 400 };
    const v = initialView(390, 700, bounds, 1000)!;
    expect(v.zoom).toBe(READABLE_ZOOM_PHONE);
    expect(v.pan.x).toBeCloseTo(195 - 1000 * READABLE_ZOOM_PHONE);
    // A desktop box only floors at the lower readable zoom.
    expect(initialView(1440, 800, { width: 6000, height: 400 }, 3000)!.zoom).toBe(READABLE_ZOOM);
    const desktop = initialView(1440, 800, { width: 800, height: 400 }, 400)!;
    expect(desktop.zoom).toBe(1);
  });

  it('zoomAround keeps the point under the cursor fixed', () => {
    const view = { zoom: 1, pan: { x: 40, y: 20 } };
    const at = { x: 300, y: 200 };
    const next = zoomAround(view, 2, at);
    const before = { x: (at.x - view.pan.x) / view.zoom, y: (at.y - view.pan.y) / view.zoom };
    const after = { x: (at.x - next.pan.x) / next.zoom, y: (at.y - next.pan.y) / next.zoom };
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(zoomAround(view, 99, at).zoom).toBe(MAX_ZOOM);
  });

  it('ownerCenterX is the middle of the owner card', () => {
    const root = layoutTree(buildTree([n('a'), n('b')]));
    expect(ownerCenterX(root)).toBe(root.x + CARD_W / 2);
  });
});

describe('view helpers', () => {
  it('managerChoices excludes the agent and everyone below it', () => {
    const nodes = [n('boss'), n('a', 'boss'), n('b', 'a'), n('c', 'b'), n('other')];
    expect(managerChoices(nodes, 'a').map((x) => x.id)).toEqual(['boss', 'other']);
    expect(managerChoices(nodes, 'other').map((x) => x.id)).toEqual(['boss', 'a', 'b', 'c']);
  });

  it('runningTaskByAgent keeps the first running task per agent and ignores unassigned ones', () => {
    const m = runningTaskByAgent([
      { id: '1', title: 'A', assigned_agent: 'x', status: 'running' },
      { id: '2', title: 'B', assigned_agent: 'x', status: 'running' },
      { id: '3', title: 'C', assigned_agent: 'y', status: 'queued' },
      { id: '4', title: 'D', assigned_agent: null, status: 'running' },
    ]);
    expect([...m.keys()]).toEqual(['x']);
    expect(m.get('x')).toEqual({ id: '1', title: 'A' });
    expect(runningTaskByAgent(null).size).toBe(0);
  });

  it('sidebarAgents puts running agents first and caps at 8', () => {
    const list = Array.from({ length: 11 }, (_, i) => ({ id: `a${i}`, running: i === 9 || i === 10 }));
    const { shown, hidden } = sidebarAgents(list);
    expect(shown).toHaveLength(8);
    expect(shown.slice(0, 2).map((a) => a.id)).toEqual(['a9', 'a10']);
    expect(shown[2].id).toBe('a0');
    expect(hidden).toBe(3);
    expect(sidebarAgents(list.slice(0, 2)).hidden).toBe(0);
  });

  it('builds links and a summary', () => {
    expect(agentHref('a b')).toBe('/agents/a%20b');
    expect(teamSummary([n('a', null, true), n('b')])).toBe('2 agent · 1 đang chạy');
  });
});
