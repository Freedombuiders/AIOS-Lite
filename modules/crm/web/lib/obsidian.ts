/**
 * obsidian://open?path=<absolute path of the file>. Obsidian opens a file by its absolute path when it lies inside a
 * vault it knows. A folder path that is not absolute gives no link (null).
 */
export function obsidianUrl(folderPath: string | null | undefined, notePath: string | null | undefined): string | null {
  if (!folderPath || !notePath) return null;
  const isAbs = folderPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(folderPath);
  if (!isAbs) return null;
  const sep = folderPath.includes('\\') && !folderPath.includes('/') ? '\\' : '/';
  const full = `${folderPath.replace(/[\\/]+$/, '')}${sep}${notePath.replace(/^[\\/]+/, '')}`;
  return `obsidian://open?path=${encodeURIComponent(full)}`;
}
