/**
 * Finds the command-line tools Video Studio needs, also when the app was started without Homebrew on PATH.
 * The lookup lives in modules/_lib/media-tools (shared with Dream 100); this file keeps the old import path.
 */
export {
  childPath,
  FFMPEG_HINT,
  findBin,
  MissingToolError,
  missingToolHint,
  requireBin,
  resetBinCache,
  searchDirs,
} from '../../_lib/media-tools/index.js';
