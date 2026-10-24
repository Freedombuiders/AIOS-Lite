// Ported from paperclipai/paperclip@1b4c803 ui/src/pages/OrgChart.tsx (MIT). Changes: Preact-free pure functions, owner root, readable zoom floor on phones.
// Pure geometry for the org chart (/org): the reporting tree, the tidy-tree
// layout ported from Paperclip's OrgChart (subtreeWidth), and pan/zoom math.
// No DOM here so it can be unit tested.

export interface OrgNodeDto {
  id: string;
  name: string;
  role?: string;
  reportsTo: string | null;
  avatarUrl?: string;
  running: boolean;
}

export const OWNER_ID = '__owner__';

export interface TreeNode {
  id: string;
  /** Absent only for the owner root. */
  node?: OrgNodeDto;
  children: TreeNode[];
}

export interface LayoutNode {
  id: string;
  node?: OrgNodeDto;
  x: number;
  y: number;
  children: LayoutNode[];
}

export interface Point { x: number; y: number }
export interface Bounds { width: number; height: number }
export interface View { zoom: number; pan: Point }

export const CARD_W = 224;
export const CARD_H = 116;
export const GAP_X = 28;
export const GAP_Y = 64;
export const PADDING = 48;
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2;
export const FIT_PADDING = 32;
/** Below this zoom a card is too small to read; the first view floors here instead of "fit everything". */
export const READABLE_ZOOM = 0.5;
/** On a phone-width box the floor is higher: 11px card text must stay legible, the chart is pannable anyway. */
export const READABLE_ZOOM_PHONE = 0.8;
export const PHONE_WIDTH = 640;

export function readableZoomFor(containerWidth: number): number {
  return containerWidth < PHONE_WIDTH ? READABLE_ZOOM_PHONE : READABLE_ZOOM;
}

/**
 * Build the tree under the owner. Agents with no manager, or a manager that is
 * not in the list, hang directly off the owner. Anything unreachable from the
 * owner (a reporting loop that slipped through) is attached to the owner too,
 * so no agent is ever dropped from the chart and the walk always terminates.
 */
export function buildTree(nodes: readonly OrgNodeDto[]): TreeNode {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string, OrgNodeDto[]>();
  const rootKids: OrgNodeDto[] = [];
  for (const n of nodes) {
    if (n.reportsTo && n.reportsTo !== n.id && byId.has(n.reportsTo)) kids.set(n.reportsTo, [...(kids.get(n.reportsTo) ?? []), n]);
    else rootKids.push(n);
  }
  const placed = new Set<string>();
  const build = (n: OrgNodeDto): TreeNode => {
    placed.add(n.id);
    return { id: n.id, node: n, children: (kids.get(n.id) ?? []).filter((c) => !placed.has(c.id)).map(build) };
  };
  const children = rootKids.map(build);
  for (const n of nodes) if (!placed.has(n.id)) children.push(build(n));
  return { id: OWNER_ID, children };
}

/** Width a subtree needs: its children side by side, never less than one card. */
export function subtreeWidth(t: TreeNode): number {
  if (t.children.length === 0) return CARD_W;
  const kidsW = t.children.reduce((sum, c) => sum + subtreeWidth(c), 0) + (t.children.length - 1) * GAP_X;
  return Math.max(CARD_W, kidsW);
}

export function layoutTree(t: TreeNode, x = PADDING, y = PADDING): LayoutNode {
  const total = subtreeWidth(t);
  const children: LayoutNode[] = [];
  if (t.children.length > 0) {
    const kidsW = t.children.reduce((sum, c) => sum + subtreeWidth(c), 0) + (t.children.length - 1) * GAP_X;
    let cx = x + (total - kidsW) / 2;
    for (const c of t.children) {
      children.push(layoutTree(c, cx, y + CARD_H + GAP_Y));
      cx += subtreeWidth(c) + GAP_X;
    }
  }
  return { id: t.id, node: t.node, x: x + (total - CARD_W) / 2, y, children };
}

export function flattenLayout(root: LayoutNode): LayoutNode[] {
  const out: LayoutNode[] = [];
  const walk = (n: LayoutNode) => { out.push(n); n.children.forEach(walk); };
  walk(root);
  return out;
}

export function collectEdges(root: LayoutNode): Array<{ parent: LayoutNode; child: LayoutNode }> {
  const out: Array<{ parent: LayoutNode; child: LayoutNode }> = [];
  const walk = (n: LayoutNode) => { for (const c of n.children) { out.push({ parent: n, child: c }); walk(c); } };
  walk(root);
  return out;
}

/** Elbow connector from the bottom of the parent card to the top of the child card. */
export function edgePath(parent: LayoutNode, child: LayoutNode): string {
  const x1 = parent.x + CARD_W / 2;
  const y1 = parent.y + CARD_H;
  const x2 = child.x + CARD_W / 2;
  const y2 = child.y;
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`;
}

export function chartBounds(nodes: readonly LayoutNode[]): Bounds {
  if (nodes.length === 0) return { width: CARD_W + PADDING * 2, height: CARD_H + PADDING * 2 };
  let maxX = 0;
  let maxY = 0;
  for (const n of nodes) { maxX = Math.max(maxX, n.x + CARD_W); maxY = Math.max(maxY, n.y + CARD_H); }
  return { width: maxX + PADDING, height: maxY + PADDING };
}

export function clampZoom(value: number): number {
  return Math.min(Math.max(value, MIN_ZOOM), MAX_ZOOM);
}

/** Zoom/pan that shows the whole chart centered. Null while the container has no size yet. */
export function fitToViewport(cw: number, ch: number, bounds: Bounds): View | null {
  if (cw <= FIT_PADDING || ch <= FIT_PADDING) return null;
  const zoom = clampZoom(Math.min((cw - FIT_PADDING) / bounds.width, (ch - FIT_PADDING) / bounds.height, 1));
  return { zoom, pan: { x: (cw - bounds.width * zoom) / 2, y: (ch - bounds.height * zoom) / 2 } };
}

/**
 * First view of the chart: everything in sight when that stays readable, else
 * a readable zoom centered on `anchorX` (the owner card) from the top, so a
 * wide team on a phone is pannable instead of a speck.
 */
export function initialView(cw: number, ch: number, bounds: Bounds, anchorX: number): View | null {
  const fit = fitToViewport(cw, ch, bounds);
  const floor = readableZoomFor(cw);
  if (!fit || fit.zoom >= floor) return fit;
  return { zoom: floor, pan: { x: cw / 2 - anchorX * floor, y: FIT_PADDING / 2 } };
}

/** Zoom to `nextZoom` keeping the chart point under `at` (container coordinates) fixed. */
export function zoomAround(view: View, nextZoom: number, at: Point): View {
  const zoom = clampZoom(nextZoom);
  const k = zoom / view.zoom;
  return { zoom, pan: { x: at.x - k * (at.x - view.pan.x), y: at.y - k * (at.y - view.pan.y) } };
}

/** Where the owner card sits horizontally, for `initialView`. */
export function ownerCenterX(root: LayoutNode): number {
  return root.x + CARD_W / 2;
}
