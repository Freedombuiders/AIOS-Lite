// Asset Hub contract (Dựng nhanh). Providers (providers.ts), the director shortlist (shortlist.ts) and B-roll
// resolution (resolve.ts) share these shapes. See modules/video/docs/dung-nhanh-gd1-plan.md › "Asset Hub".

export type AssetSource = 'project' | 'mine' | 'pexels' | 'pexels-photo';

export interface AssetLicense {
  name: string;
  creator?: string;
  sourceUrl?: string;
  attributionRequired: boolean;
}

export interface AssetCandidate {
  /** Library asset id, or 'pexels:video:<id>' / 'pexels:photo:<id>' before it is downloaded. */
  ref: string;
  source: AssetSource;
  kind: 'video' | 'image' | 'bgm' | 'sfx';
  /** Vietnamese description. */
  caption: string;
  thumbUrl?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  license: AssetLicense;
  /** 1..5, scored by the model against the line being spoken. */
  score?: number;
  reason?: string;
}

export interface AssetShortlist {
  projectAssets: { assetId: string; kind: 'video' | 'image'; hint?: string; caption?: string }[];
  /** Owner library items that match the transcript. */
  library: AssetCandidate[];
  /** Background music for the template mood; carries bpm when analysed. */
  music: AssetCandidate[];
  sfx: AssetCandidate[];
}
