// Unsaved-changes registry. Forms register while they hold edits; navigation that would unmount
// them (switching conversation, closing the drawer) asks first. Same behaviour as the Zalo screen:
// refuse with a message rather than silently drop the edit.

const dirty = new Set<string>();
const listeners = new Set<() => void>();

export function setDirty(key: string, isDirty: boolean): void {
  const before = dirty.size;
  if (isDirty) dirty.add(key);
  else dirty.delete(key);
  if (dirty.size !== before) for (const l of [...listeners]) l();
}

export function anyDirty(): boolean {
  return dirty.size > 0;
}

export function dirtyKeys(): string[] {
  return [...dirty];
}

export function subscribeDirty(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function resetDirtyForTests(): void {
  dirty.clear();
  listeners.clear();
}
