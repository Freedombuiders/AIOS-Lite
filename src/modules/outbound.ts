import { redactString } from '../core/redact.js';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const DIRECTIVE_TAG = /<\/?aios-[a-z0-9-]*(?:\s[^>]*)?>/gi;
const FENCE = /^[ \t]*(?:```|~~~)[^\n]*$/gm;
const UNIX_PATH = /(?<![\w:/.-])(?:\/(?:Users|home|root|tmp|var|etc|opt|private|mnt|Volumes|srv|usr)\/|~\/)[^\s"'`)\]>]*/g;
const WIN_PATH = /\b[A-Za-z]:\\[^\s"'`)\]>]*/g;

/** Strip secrets, local paths, ANSI codes, directive tags and stray fences. Vietnamese text is untouched. */
export function sanitizeOutbound(text: string): string {
  let out = redactString(text ?? '');
  out = out.replace(ANSI, '');
  out = out.replace(DIRECTIVE_TAG, '');
  out = out.replace(FENCE, '');
  out = out.replace(UNIX_PATH, '').replace(WIN_PATH, '');
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
  return out.trim();
}
