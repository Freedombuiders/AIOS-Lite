/**
 * Facebook hand-off. A KOL post for a Fanpage becomes a row in the Marketing module's queue (scheduled for the
 * time the owner approved); Marketing's own publisher posts it and every KOL tick mirrors the row back.
 * Reached only through `ctx.modules.get('marketing').kolBridge` (contract: modules/_lib/kol-bridge.ts); without the
 * Marketing module every read reports "nothing there" and createContent throws.
 */
import type { KolBridgeContent, KolBridgeMetric, KolBridgePage, MarketingKolBridge } from '../../_lib/kol-bridge.js';
import { KolError } from './core.js';
import { moduleCompat } from './compat.js';

export type { KolBridgeContent, KolBridgeMetric, KolBridgePage, MarketingKolBridge };

export const NEEDS_MARKETING = 'Cần bật module Marketing (Facebook) để đăng lên Fanpage.';

let override: MarketingKolBridge | null | undefined;

/** @internal tests only: a fake bridge (null = Marketing absent, undefined = use the module host). */
export function _setFbBridgeForTests(bridge: MarketingKolBridge | null | undefined): void {
  override = bridge;
}

export function fbBridge(): MarketingKolBridge | undefined {
  if (override !== undefined) return override ?? undefined;
  return moduleCompat('kol')?.modules.get<{ kolBridge?: MarketingKolBridge }>('marketing')?.kolBridge;
}

export const fbAvailable = (): boolean => !!fbBridge();

export function requireFbBridge(): MarketingKolBridge {
  const b = fbBridge();
  if (!b) throw new KolError(412, NEEDS_MARKETING);
  return b;
}

export const getFbSetting = (key: string): string | undefined => fbBridge()?.getSetting(key);
export const getFbPage = (id: string): KolBridgePage | undefined => fbBridge()?.getPage(id);
export const getFbContent = (id: number): KolBridgeContent | undefined => fbBridge()?.getContent(id);
export const listFbPostMetricsForPost = (postId: string): KolBridgeMetric[] => fbBridge()?.getPostMetrics(postId) ?? [];
