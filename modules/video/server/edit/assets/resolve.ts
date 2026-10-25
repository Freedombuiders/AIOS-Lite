// Fills assetId for B-roll slots that carry a `query` but no file yet. STUB until task T5 (asset-hub) lands:
// returns the plan unchanged.
import type { EditPlan } from '../types.js';

export async function resolveBrolls(_projectId: string, plan: EditPlan): Promise<{ plan: EditPlan; notes: string[] }> {
  return { plan, notes: [] };
}
