// Runtime binding shared by every compat file. The app calls bindCompat(deps) once at boot;
// tests can call bindCompatForTest(db) (or _initTestDatabase) instead.
import type { AppDeps } from '../../core/deps.js';
import type { ModuleContext } from '../sdk.js';

let current: AppDeps | null = null;
const moduleCtxs = new Map<string, ModuleContext>();
const listeners: ((deps: AppDeps) => void)[] = [];

/** register a callback that refreshes live-binding exports whenever the binding changes */
export function onBind(fn: (deps: AppDeps) => void): void {
  listeners.push(fn);
  if (current) fn(current);
}

export function bindCompat(deps: AppDeps): void {
  current = deps;
  for (const fn of listeners) fn(deps);
}

export function bindModuleCompat(moduleId: string, ctx: ModuleContext): void {
  moduleCtxs.set(moduleId, ctx);
}

export function unbindModuleCompat(moduleId: string): void {
  moduleCtxs.delete(moduleId);
}

export function moduleCompat(moduleId: string): ModuleContext | undefined {
  return moduleCtxs.get(moduleId);
}

export function boundModules(): ModuleContext[] {
  return [...moduleCtxs.values()];
}

export function tryDeps(): AppDeps | null {
  return current;
}

export function getDeps(): AppDeps {
  if (!current) throw new Error('compat chưa được nối: gọi bindCompat(deps) lúc khởi động (hoặc _initTestDatabase() trong test).');
  return current;
}

export function unbindCompat(): void {
  current = null;
  moduleCtxs.clear();
}
