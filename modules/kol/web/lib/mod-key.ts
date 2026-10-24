// Ctrl/⌘ + Enter helper for the studio composer (⌘ on macOS, Ctrl elsewhere).
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');

export const matchesModKey = (e: KeyboardEvent): boolean => (isMac ? e.metaKey : e.ctrlKey);
export const modKeyLabel = (): string => (isMac ? '⌘' : 'Ctrl');
