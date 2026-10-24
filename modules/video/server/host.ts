import type { ModuleContext } from '../../../src/modules/sdk.js';

let current: ModuleContext | undefined;

/** The running module's context (agents, events, settings...). Bound in server/index.ts start(). */
export function bindModuleCtx(ctx: ModuleContext | undefined): void { current = ctx; }
export const moduleCtx = (): ModuleContext | undefined => current;
