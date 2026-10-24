// Finds library files (fonts, music, SFX, images, clips) for the composition builder, through the
// asset library store (manifest + builtin catalog + files dropped into the library folder).
import path from 'node:path';
import type { AssetKind } from '../types.js';
import { assetFilePath, findAsset, listFonts } from '../library/store.js';

export interface ResolvedAsset {
  id: string;
  kind: AssetKind;
  name: string;
  /** Absolute path of the file. */
  file: string;
  ext: string;
  durationSec?: number;
}

export interface AssetResolver {
  byId(id: string): ResolvedAsset | null;
  /** A font given as an asset id, a file name, or a family name. */
  font(spec: string | undefined, prefer?: 'bold' | 'regular'): ResolvedAsset | null;
}

const norm = (s: string) =>
  s.replace(/đ/g, 'd').replace(/Đ/g, 'D').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const extOf = (f: string) => path.extname(f).slice(1).toLowerCase();

export function createAssetResolver(root: string): AssetResolver {
  function byId(id: string): ResolvedAsset | null {
    if (!id) return null;
    try {
      const asset = findAsset(root, id);
      if (!asset || asset.enabled === false) return null;
      const file = assetFilePath(root, asset);
      if (!file) return null;
      return {
        id: asset.id, kind: asset.kind, name: asset.name, file, ext: extOf(file),
        ...(asset.durationSec ? { durationSec: asset.durationSec } : {}),
      };
    } catch {
      return null;
    }
  }

  function font(spec: string | undefined, prefer: 'bold' | 'regular' = 'regular'): ResolvedAsset | null {
    const s = spec?.trim();
    if (!s) return null;
    let families: ReturnType<typeof listFonts>;
    try { families = listFonts(root); } catch { return null; }
    const want = norm(s.replace(/\.[^.]+$/, ''));
    const family =
      families.find((f) => f.assetIds.includes(s))
      ?? families.find((f) => norm(f.family) === want)
      ?? families.find((f) => f.faces.some((face) => norm(path.basename(face.file).replace(/\.[^.]+$/, '')) === want))
      ?? families.find((f) => want.length >= 4 && norm(f.family).startsWith(want));
    if (!family) return null;
    const target = prefer === 'bold' ? 700 : 400;
    const face = [...family.faces]
      .filter((f) => f.style === 'normal' || family.faces.every((x) => x.style !== 'normal'))
      .sort((a, b) => {
        const d = (f: typeof a) => (target >= f.weightMin && target <= f.weightMax ? 0 : Math.min(Math.abs(f.weightMin - target), Math.abs(f.weightMax - target)));
        return d(a) - d(b);
      })[0] ?? family.faces[0];
    return { id: family.assetId, kind: 'font', name: family.family, file: face.file, ext: extOf(face.file) };
  }

  return { byId, font };
}
