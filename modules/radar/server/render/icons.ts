/** Inline SVG icons of the original Radar pages (stroke icons, 24x24 grid). */

const PATHS = {
  people: "<circle cx=\"9\" cy=\"8\" r=\"3.5\"/><path d=\"M2.5 20a6.5 6.5 0 0 1 13 0\"/><circle cx=\"17\" cy=\"9\" r=\"2.5\"/><path d=\"M16 14.2a5 5 0 0 1 5.5 4.8\"/>",
  cart: "<circle cx=\"9\" cy=\"20\" r=\"1.5\"/><circle cx=\"18\" cy=\"20\" r=\"1.5\"/><path d=\"M2 3h3l2.6 12.2a2 2 0 0 0 2 1.6h8.2a2 2 0 0 0 2-1.5L22 8H6\"/>",
  bulb: "<path d=\"M9 18h6\"/><path d=\"M10 21h4\"/><path d=\"M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z\"/>",
  flag: "<path d=\"M5 21V4\"/><path d=\"M5 4h11l-2 4 2 4H5\"/>",
  megaphone: "<path d=\"M3 10v4a1 1 0 0 0 1 1h3l6 4V5L7 9H4a1 1 0 0 0-1 1z\"/><path d=\"M17 8.5a5 5 0 0 1 0 7\"/>",
  globe: "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M3 12h18\"/><path d=\"M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18\"/>",
  info: "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 11v5\"/><path d=\"M12 7.5v.5\"/>",
  chat: "<path d=\"M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z\"/>",
  share: "<path d=\"M4 12v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6\"/><path d=\"M12 15V3\"/><path d=\"M7.5 7.5 12 3l4.5 4.5\"/>",
  eye: "<path d=\"M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>",
  bookmark: "<path d=\"M6 3h12v18l-6-4-6 4z\"/>",
  star: "<path d=\"M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4 6.5 20.3l1-6.2L3 9.7l6.2-.9z\"/>",
  flame: "<path d=\"M12 22a7 7 0 0 0 7-7c0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-2 2-5 5-5 8a7 7 0 0 0 7 7z\"/>",
  target: "<circle cx=\"12\" cy=\"12\" r=\"9\"/><circle cx=\"12\" cy=\"12\" r=\"5\"/><circle cx=\"12\" cy=\"12\" r=\"1\"/>",
  doc: "<path d=\"M6 2h8l5 5v15H6z\"/><path d=\"M14 2v5h5\"/><path d=\"M9 13h7M9 17h7\"/>",
  heart: "<path d=\"M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z\"/>",
  clock: "<circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"M12 7.5V12l3 2\"/>",
  video: "<rect x=\"3\" y=\"6\" width=\"13\" height=\"12\" rx=\"2\"/><path d=\"M16 10l5-3v10l-5-3\"/>",
  image: "<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2\"/><circle cx=\"9\" cy=\"10\" r=\"2\"/><path d=\"M21 16l-5-5-9 9\"/>",
  pin: "<path d=\"M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z\"/><circle cx=\"12\" cy=\"10\" r=\"2.5\"/>",
  tag: "<path d=\"M3 12V3h9l9 9-9 9z\"/><circle cx=\"7.5\" cy=\"7.5\" r=\"1.5\"/>",
  calendar: "<rect x=\"3\" y=\"5\" width=\"18\" height=\"16\" rx=\"2\"/><path d=\"M3 10h18M8 3v4M16 3v4\"/>",
  briefcase: "<rect x=\"2\" y=\"6\" width=\"20\" height=\"12\" rx=\"2\"/><circle cx=\"12\" cy=\"12\" r=\"2.5\"/>",
  warn: "<path d=\"M12 3l10 18H2z\"/><path d=\"M12 10v5M12 18v.5\"/>",
  quote: "<path d=\"M7 7h4v4c0 3-2 5-4 6\"/><path d=\"M14 7h4v4c0 3-2 5-4 6\"/>",
  trophy: "<path d=\"M8 4h8v5a4 4 0 0 1-8 0z\"/><path d=\"M8 6H4a3 3 0 0 0 4 4M16 6h4a3 3 0 0 1-4 4\"/><path d=\"M12 13v4M8 21h8\"/>",
  grid: "<rect x=\"3\" y=\"3\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"14\" y=\"14\" width=\"7\" height=\"7\" rx=\"1.5\"/>",
  layers: "<path d=\"M12 3l9 5-9 5-9-5z\"/><path d=\"M3 13l9 5 9-5\"/>",
  repost: "<path d=\"M17 2l3 3-3 3\"/><path d=\"M4 11V9a4 4 0 0 1 4-4h12\"/><path d=\"M7 22l-3-3 3-3\"/><path d=\"M20 13v2a4 4 0 0 1-4 4H4\"/>",
  up: "<path d=\"M12 4l7 9h-4.5v7h-5v-7H5z\"/>",
} as const;

export type IconName = keyof typeof PATHS;

const ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

/** Report icon: `<svg class="fi">` sized by CSS. */
export function icon(name: IconName): string {
  return `<svg class="fi" ${ATTRS}>${PATHS[name]}</svg>`;
}

/** Index icon: fixed pixel size, no class. */
export function iconSized(name: IconName, size: number): string {
  return `<svg width="${size}" height="${size}" ${ATTRS}>${PATHS[name]}</svg>`;
}
