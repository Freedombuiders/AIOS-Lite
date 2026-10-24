import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModuleContext } from '../../../src/modules/sdk.js';
const contexts = new AsyncLocalStorage<ModuleContext>();
export const currentContext = () => contexts.getStore();
export const withContext = <T>(ctx: ModuleContext, fn: () => T): T => contexts.run(ctx, fn);
export const isFbStudioEnabled = () => currentContext()?.settings.get<boolean>('enabled', true) ?? true;
export async function notifyOwner(detail: string): Promise<void> {
 currentContext()?.attention.raise({ key: 'ads:connection', title: 'Kết nối quảng cáo cần kiểm tra', detail, link: '/m/ads', severity: 'warn' });
}
/** Only test harnesses bind a context outside a request or scheduled callback. */
export const bindTestContext = (ctx: ModuleContext): void => contexts.enterWith(ctx);
