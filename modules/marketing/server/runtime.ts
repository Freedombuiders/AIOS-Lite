// The module context, set by start()/routes(). Copied workers are module-level code, so they reach
// settings, attention and agents through this holder. Null in unit tests that never bind a context.
import type { ModuleContext } from '../../../src/modules/sdk.js';

let current: ModuleContext | null = null;

export function setRuntime(ctx: ModuleContext | null): void {
  current = ctx;
}

export function getRuntime(): ModuleContext | null {
  return current;
}

export function requireRuntime(): ModuleContext {
  if (!current) throw new Error('Module marketing chưa được khởi động.');
  return current;
}
