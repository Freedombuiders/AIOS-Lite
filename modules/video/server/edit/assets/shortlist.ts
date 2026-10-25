// Director shortlist for Dựng nhanh. STUB until task T5 (asset-hub) lands: empty lists, empty prompt section.
import type { AssetShortlist } from './types.js';

export async function buildShortlist(_projectId: string): Promise<AssetShortlist> {
  return { projectAssets: [], library: [], music: [], sfx: [] };
}

export function renderShortlistForPrompt(_s: AssetShortlist): string {
  return '';
}
