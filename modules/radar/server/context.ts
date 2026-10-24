import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModuleContext } from '../../../src/modules/sdk.js';
import type { DB } from '../../../src/core/db.js';

const contexts = new AsyncLocalStorage<ModuleContext>();
let ambient: ModuleContext | undefined;
let pinned = false;

/** Context of the running request or scheduled tick; falls back to the context bound in start(). */
export const currentContext = (): ModuleContext | undefined => (pinned ? ambient : contexts.getStore() ?? ambient);
export const withContext = <T>(ctx: ModuleContext, fn: () => T): T => contexts.run(ctx, fn);
export const setAmbientContext = (ctx: ModuleContext | undefined): void => { ambient = ctx; };

export function requireContext(): ModuleContext {
  const ctx = currentContext();
  if (!ctx) throw new Error('Radar chưa được khởi động: thiếu ngữ cảnh module.');
  return ctx;
}

export const radarDatabase = (): DB => requireContext().db;

/** Only test harnesses bind a context outside a request or scheduled callback. */
export const bindTestContext = (ctx: ModuleContext): void => { pinned = true; ambient = ctx; };
