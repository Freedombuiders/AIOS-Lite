// Reference channels the owner wants to learn from. Up to 100, checked here (not only in the page).
// Each channel is a row in dream_channels and a note dream-100/kenh/<slug>.md (loai: kenh-dream). No scanning.
import crypto from 'node:crypto';
import type { ModuleContext } from '../../../src/modules/sdk.js';

export const MAX_CHANNELS = 100;

export type Platform = 'youtube' | 'tiktok' | 'facebook' | 'instagram' | 'threads' | 'web';

export interface ParsedChannel {
  platform: Platform;
  /** normalised link: https, no query, no trailing slash */
  url: string;
  handle: string;
}

export interface ChannelRow {
  id: string;
  platform: Platform;
  url: string;
  handle: string;
  why: string | null;
  folder_id: string;
  note_path: string | null;
  created_at: number;
}

export class ChannelError extends Error {
  readonly code = 'bad_request';
  constructor(message: string) {
    super(message);
    this.name = 'ChannelError';
  }
}

const HOSTS: [RegExp, Platform][] = [
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, 'youtube'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)facebook\.com$|(^|\.)fb\.com$|(^|\.)fb\.watch$/, 'facebook'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)threads\.(net|com)$/, 'threads'],
];

/** A channel link, or null when it is not an http(s) link. */
export function parseChannel(input: string): ParsedChannel | null {
  const raw = input.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.hostname.includes('.')) return null;
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, '');
  const platform = HOSTS.find(([re]) => re.test(host))?.[1] ?? 'web';
  const segs = u.pathname.split('/').filter(Boolean);
  const keep = platform === 'youtube' && segs[0] && ['channel', 'c', 'user'].includes(segs[0]) ? segs.slice(0, 2) : segs.slice(0, 1);
  const pathPart = keep.length ? `/${keep.join('/')}` : '';
  const url = `https://${host}${pathPart}`;
  const handle = decodeURIComponent(keep[keep.length - 1] ?? host).replace(/^@/, '') || host;
  return { platform, url, handle };
}

/** Slug for note file names: lowercase ascii, digits and dashes. */
export function slugify(text: string, fallback = 'kenh'): string {
  const s = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return s || fallback;
}

export const newId = (prefix: string): string => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

export function listChannels(ctx: Pick<ModuleContext, 'db'>): ChannelRow[] {
  return ctx.db.prepare('SELECT * FROM dream_channels ORDER BY created_at DESC, id').all() as ChannelRow[];
}

export function channelCount(ctx: Pick<ModuleContext, 'db'>): number {
  return (ctx.db.prepare('SELECT COUNT(*) AS n FROM dream_channels').get() as { n: number }).n;
}

export function getChannel(ctx: Pick<ModuleContext, 'db'>, id: string): ChannelRow | undefined {
  return ctx.db.prepare('SELECT * FROM dream_channels WHERE id = ?').get(id) as ChannelRow | undefined;
}

export interface AddResult {
  added: ChannelRow[];
  /** lines skipped, each with a Vietnamese reason */
  skipped: { input: string; reason: string }[];
}

const channelBody = (c: ParsedChannel, why: string | null) =>
  `# ${c.handle}\n\nKênh mẫu trên ${c.platform}: ${c.url}\n\n## Học gì ở kênh này\n\n${why?.trim() || '(chưa ghi)'}\n\nVideo đã phân tích của kênh này nằm ở dream-100/video/ và có liên kết về ghi chú này.\n`;

/** A free note path dream-100/kenh/<slug>.md in `folderId`. */
function freeChannelPath(ctx: Pick<ModuleContext, 'brain'>, folderId: string, handle: string): string {
  const base = slugify(handle);
  for (let i = 1; i < 500; i++) {
    const rel = `dream-100/kenh/${i === 1 ? base : `${base}-${i}`}.md`;
    if (!ctx.brain.notes.read({ folderId, relPath: rel })) return rel;
  }
  return `dream-100/kenh/${base}-${crypto.randomBytes(3).toString('hex')}.md`;
}

/**
 * Add channels from free text (one link per line, or separated by spaces/commas). Duplicates and bad links are
 * skipped with a reason; once there are 100 channels every further one is refused.
 */
export function addChannels(ctx: Pick<ModuleContext, 'db' | 'brain'>, input: { text: string; why?: string | null; folderId: string }): AddResult {
  const why = input.why?.trim().slice(0, 1000) || null;
  const tokens = input.text.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  const out: AddResult = { added: [], skipped: [] };
  if (!tokens.length) throw new ChannelError('Chưa có link kênh nào.');
  for (const token of tokens) {
    const parsed = parseChannel(token);
    if (!parsed) {
      out.skipped.push({ input: token, reason: 'Không phải link hợp lệ.' });
      continue;
    }
    if (ctx.db.prepare('SELECT 1 FROM dream_channels WHERE url = ?').get(parsed.url)) {
      out.skipped.push({ input: token, reason: 'Kênh này đã có trong danh sách.' });
      continue;
    }
    if (channelCount(ctx) >= MAX_CHANNELS) {
      out.skipped.push({ input: token, reason: `Đã đủ ${MAX_CHANNELS} kênh. Xoá bớt kênh cũ rồi thêm lại.` });
      continue;
    }
    const id = newId('ch');
    const relPath = freeChannelPath(ctx, input.folderId, parsed.handle);
    ctx.brain.notes.create(
      { folderId: input.folderId, relPath },
      { loai: 'kenh-dream', nen_tang: parsed.platform, link: parsed.url, hoc_gi: why, lay_bang: 'tay' },
      channelBody(parsed, why),
      { message: `Dream 100: thêm kênh ${parsed.handle}` },
    );
    const row: ChannelRow = { id, platform: parsed.platform, url: parsed.url, handle: parsed.handle, why, folder_id: input.folderId, note_path: relPath, created_at: Date.now() };
    ctx.db
      .prepare('INSERT INTO dream_channels (id, platform, url, handle, why, folder_id, note_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.platform, row.url, row.handle, row.why, row.folder_id, row.note_path, row.created_at);
    out.added.push(row);
  }
  return out;
}

/** Change "học gì ở kênh này": the row, and the hoc_gi key of the note (the note body is the owner's, left alone). */
export function updateWhy(ctx: Pick<ModuleContext, 'db' | 'brain'>, id: string, why: string | null): ChannelRow {
  const row = getChannel(ctx, id);
  if (!row) throw new ChannelError('Không tìm thấy kênh.');
  const clean = why?.trim().slice(0, 1000) || null;
  ctx.db.prepare('UPDATE dream_channels SET why = ? WHERE id = ?').run(clean, id);
  if (row.note_path) {
    const ref = { folderId: row.folder_id, relPath: row.note_path };
    const note = ctx.brain.notes.read(ref);
    if (note) ctx.brain.notes.patch(ref, { hoc_gi: clean }, { message: `Dream 100: sửa lý do theo dõi ${row.handle}`, expectHash: note.hash });
  }
  return { ...row, why: clean };
}

/** Stop following: the row goes, the note stays (it is the owner's knowledge now). */
export function removeChannel(ctx: Pick<ModuleContext, 'db'>, id: string): boolean {
  ctx.db.prepare('UPDATE dream_videos SET channel_id = NULL WHERE channel_id = ?').run(id);
  return ctx.db.prepare('DELETE FROM dream_channels WHERE id = ?').run(id).changes > 0;
}
