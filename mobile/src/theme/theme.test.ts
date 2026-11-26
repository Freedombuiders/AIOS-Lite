import { colors, MIN_TARGET } from './colors';

/** WCAG 2.x contrast ratio of two #rrggbb colours. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('dark theme contrast (WCAG AA: 4.5:1 for text)', () => {
  const surfaces = ['bg', 'sidebar', 'card', 'elevated', 'input', 'controlBg'] as const;
  const textColors = ['text', 'textMuted', 'accent', 'accentHover', 'danger', 'warning', 'success'] as const;

  it.each(surfaces.flatMap((s) => textColors.map((t) => [t, s] as const)))('%s on %s', (fg, bg) => {
    expect(ratio(colors[fg], colors[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it('button labels: dark text on the accent and danger fills', () => {
    expect(ratio(colors.onAccent, colors.accent)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(colors.onAccent, colors.danger)).toBeGreaterThanOrEqual(4.5);
  });

  it('accent text on its own tinted chip background (accent at 14% over the card)', () => {
    // accentSoft is rgba(109,141,255,.14); over #171a21 that is about #212a43.
    expect(ratio(colors.accentHover, '#212a43')).toBeGreaterThanOrEqual(4.5);
  });

  it('knows why textFaint is decoration only', () => {
    expect(ratio(colors.textFaint, colors.card)).toBeLessThan(4.5);
  });

  it('touch targets are at least 44 points', () => {
    expect(MIN_TARGET).toBeGreaterThanOrEqual(44);
  });
});
