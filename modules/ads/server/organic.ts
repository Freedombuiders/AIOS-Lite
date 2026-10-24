import type { ModuleContext } from '../../../src/modules/sdk.js';
import type { FbAdsOrganicRow } from './store.js';

export interface MarketingProvides {
  topPosts(pageId: string | undefined, days: number): FbAdsOrganicRow[] | Promise<FbAdsOrganicRow[]>;
}
export async function organicPosts(ctx: ModuleContext): Promise<{ available: boolean; rows: FbAdsOrganicRow[] }> {
  const marketing = ctx.modules.get<MarketingProvides>('marketing');
  if (!marketing?.topPosts) return { available: false, rows: [] };
  return { available: true, rows: await marketing.topPosts(undefined, 30) };
}
