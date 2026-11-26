/**
 * Colours of the desktop app (web/src/styles/main.css, the @theme block), dark
 * only. Keep the two in step by hand; theme.test.ts checks the contrast of the
 * pairs the screens use.
 */
export const colors = {
  bg: '#0f1115',
  sidebar: '#12151a',
  card: '#171a21',
  elevated: '#1e222b',
  border: '#272c37',
  borderStrong: '#353c4a',
  text: '#e6e8ee',
  textMuted: '#9aa3b2',
  /** Decoration only (dividers, disabled hints): #697386 on the card is below 4.5:1 and must not carry meaning. */
  textFaint: '#697386',
  accent: '#6d8dff',
  accentHover: '#8aa3ff',
  accentSoft: 'rgba(109, 141, 255, 0.14)',
  onAccent: '#0b1020',
  danger: '#f0647a',
  warning: '#f0b24a',
  success: '#46c28a',
  input: '#12151b',
  controlBg: '#1b1f27',
  controlBorder: '#2d3340',
} as const;

export type ColorName = keyof typeof colors;

export const radius = { sm: 4, md: 6, lg: 8, xl: 12, pill: 999 } as const;
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
/** Minimum touch target, in points (Apple HIG and Material both ask for about this). */
export const MIN_TARGET = 44;
