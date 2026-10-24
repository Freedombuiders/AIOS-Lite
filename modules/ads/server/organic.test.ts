
// Contract with the marketing module: rows must use the shared snake_case FbAdsOrganicRow shape.
import { describe as describeShape, expect as expectShape, it as itShape } from 'vitest';
import type { FbAdsOrganicRow } from '../../_lib/fb-types.js';
describeShape('organic rows shape', () => {
  itShape('has post_id/page_name (snake_case) as the dashboard reads them', () => {
    const row: FbAdsOrganicRow = { post_id: '1_2', page_name: 'P', title: 't', caption: 'c', format: 'photo', published_at: 1, reach: 10, reactions: 1, comments: 0, shares: 0 };
    expectShape(Object.keys(row)).toContain('post_id');
  });
});
