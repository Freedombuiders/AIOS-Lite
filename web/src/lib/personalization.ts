export function modKeyLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl';
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
}

export type Appearance = 'dark' | 'light' | 'system';

export function getAppearance(): Appearance {
  try {
    const v = localStorage.getItem('aios.appearance');
    if (v === 'light' || v === 'system') return v;
  } catch {
    /* ignore */
  }
  // Dark by default, like FreedomOS.
  return 'dark';
}

export function setAppearance(mode: Appearance): void {
  try {
    localStorage.setItem('aios.appearance', mode);
  } catch {
    /* ignore */
  }
  const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-appearance', dark ? 'dark' : 'light');
}
