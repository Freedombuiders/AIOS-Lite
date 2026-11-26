/**
 * What may be uploaded, and how to recognise it from its first bytes.
 * Shared by the Worker and, through a copy of the rules, the core app's
 * `agenticos-cloud` integration.
 */
export const UPLOAD_PURPOSES = ['post-media', 'avatar', 'pack-cover'] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

export const MEDIA_TYPES = {
  'image/jpeg': { ext: 'jpg', maxBytes: 10 * 1024 * 1024, kind: 'image' },
  'image/png': { ext: 'png', maxBytes: 10 * 1024 * 1024, kind: 'image' },
  'image/webp': { ext: 'webp', maxBytes: 10 * 1024 * 1024, kind: 'image' },
  'video/mp4': { ext: 'mp4', maxBytes: 200 * 1024 * 1024, kind: 'video' },
} as const;
export type MediaType = keyof typeof MEDIA_TYPES;

export const isMediaType = (t: string): t is MediaType => Object.hasOwn(MEDIA_TYPES, t);

/** How many leading bytes `sniff` needs. */
export const SNIFF_BYTES = 16;

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** The media type the bytes actually are, or null. */
export function sniff(head: Uint8Array): MediaType | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => head[i] === v)) return 'image/png';
  if (head.length >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return 'image/webp';
  if (head.length >= 8 && ascii(head, 4, 8) === 'ftyp') return 'video/mp4';
  return null;
}
