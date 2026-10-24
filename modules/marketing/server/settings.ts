// Module settings (module.json) replace the owner's kill switches. Without a bound context
// (unit tests) the values fall back to fb_settings and to in-process overrides.
import { getFbSetting, setFbSetting } from './store.js';
import { getRuntime } from './runtime.js';

export type FbSwitch = 'FB_PUBLISH_ENABLED' | 'FB_AUTOREPLY_ENABLED';

const SETTING_OF: Record<FbSwitch, string> = { FB_PUBLISH_ENABLED: 'publish', FB_AUTOREPLY_ENABLED: 'autoreply' };
const overrides = new Map<FbSwitch, boolean>();

export class KillSwitchDisabledError extends Error {
  constructor(public readonly switchName: FbSwitch) {
    super(`Tính năng ${switchName === 'FB_PUBLISH_ENABLED' ? 'đăng bài' : 'trả lời bình luận tự động'} đang tắt.`);
    this.name = 'KillSwitchDisabledError';
  }
}

export function isEnabled(name: FbSwitch): boolean {
  const o = overrides.get(name);
  if (o !== undefined) return o;
  const ctx = getRuntime();
  return ctx ? ctx.settings.get<boolean>(SETTING_OF[name], true) !== false : true;
}

export function requireEnabled(name: FbSwitch): void {
  if (!isEnabled(name)) throw new KillSwitchDisabledError(name);
}

export function _setSwitch(name: FbSwitch, on: boolean | undefined): void {
  if (on === undefined) overrides.delete(name);
  else overrides.set(name, on);
}

/** Studio master switch (module setting `enabled`). Off until the owner turns it on. */
export function isFbStudioEnabled(): boolean {
  const ctx = getRuntime();
  return ctx ? ctx.settings.get<boolean>('enabled', false) === true : getFbSetting('enabled') === '1';
}

export function setFbStudioEnabled(on: boolean): void {
  const ctx = getRuntime();
  if (ctx) ctx.settings.set('enabled', on);
  else setFbSetting('enabled', on ? '1' : '0');
}

export function setBudgetPerHour(n: number): void {
  const ctx = getRuntime();
  if (ctx) ctx.settings.set('api_budget_per_hour', n);
  else setFbSetting('api_budget_per_hour', String(n));
}

/** Hourly Composio budget from the module settings, or undefined for the default. */
export function configuredBudgetPerHour(): number | undefined {
  const ctx = getRuntime();
  const n = ctx ? Number(ctx.settings.get<number>('api_budget_per_hour', 0)) : Number(getFbSetting('api_budget_per_hour'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function readComposioKey(): string | undefined {
  return getRuntime()?.connections.secret('COMPOSIO_API_KEY');
}
