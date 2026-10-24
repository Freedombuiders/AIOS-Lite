// Where KOL Studio keeps files and how it finds provider credentials. All values resolve per call
// from the bound module context so a key saved in Kết nối works without a restart.
import os from 'node:os';
import { moduleCompat } from './compat.js';

/** Tests override this to point media at a temp folder; in the app the module data dir is used. */
export const STORE_DIR = '';

const ctx = () => moduleCompat('kol');

/** Root folder of generated media: <data>/modules/kol/media. */
export function mediaRoot(): string {
  const dir = ctx()?.dataDir;
  if (!dir) throw new Error('KOL Studio chưa được khởi động (không có thư mục dữ liệu).');
  return `${dir}/media`;
}

/** A secret saved in Kết nối (empty when missing or the module is not started). */
export const connectionSecret = (name: string): string => ctx()?.connections.secret(name)?.trim() ?? '';
export const googleApiKey = (): string => connectionSecret('GOOGLE_API_KEY');
export const openaiApiKey = (): string => connectionSecret('OPENAI_API_KEY');

/** The Codex login of the machine owner (the SDK reads auth.json from here). */
export const operatorCodexHome = (): string => process.env.CODEX_HOME?.trim() || `${os.homedir()}/.codex`;

/** Campaign video folders (<kol>/<campaign>/metadata.json + variants) the owner or an agent drops here. */
let videosOverride: string | null = null;
/** @internal tests only. */
export function _setVideosDirForTests(dir: string | null): void { videosOverride = dir; }
export const kolVideosDir = (): string => {
  if (videosOverride) return videosOverride;
  const dir = ctx()?.dataDir;
  return dir ? `${dir}/videos` : `${process.cwd()}/kol-videos`;
};
