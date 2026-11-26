// Analysing reference videos the owner pasted: one background job per link, run one at a time.
//   download (yt-dlp) → length (ffprobe) → scene cuts (ffmpeg) → 4 hook frames (ffmpeg) → one lean labelling turn
//   → a video-dream note with the numbers and the labels.
// The work dir data/modules/dream/tmp/<id>/ is removed in `finally`, whatever happens. Subtitles, frames and the
// video file never leave it: the note and the database only get numbers and labels from fixed lists.
import fs from 'node:fs';
import path from 'node:path';
import type { ModuleContext } from '../../../src/modules/sdk.js';
import { locateMediaTool, missingToolHint } from '../../_lib/media-tools/index.js';
import { getChannel, newId, slugify } from './channels.js';
import { LABEL_TEXT, labelVideo, type LabelOutcome } from './label.js';
import { cutStats, download, hookFrames, MeasureError, probeDuration, publicInfo, sceneTimes, type CutStats, type PublicInfo, type ToolPaths } from './measure.js';
import { ToolStartError, ToolTimeoutError } from './run.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface VideoRow {
  id: string;
  channel_id: string | null;
  url: string;
  folder_id: string;
  status: JobStatus;
  step: string | null;
  reason: string | null;
  platform: string | null;
  native_id: string | null;
  title: string | null;
  uploader: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  captured_at: number | null;
  duration_s: number | null;
  cuts: number | null;
  cuts_per_min: number | null;
  cuts_first3s: number | null;
  longest_scene_s: number | null;
  has_subtitles: number | null;
  used_frames: number | null;
  mo_dau: string | null;
  cau_truc: string | null;
  keu_goi: string | null;
  giay_keu_goi: number | null;
  label_note: string | null;
  agent_id: string | null;
  task_id: number | null;
  note_path: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export type DreamCtx = Pick<ModuleContext, 'db' | 'brain' | 'agents' | 'settings' | 'log' | 'dataDir' | 'events'>;

export const MAX_URLS_PER_PASTE = 20;

export class VideoInputError extends Error {
  readonly code = 'bad_request';
  constructor(message: string) {
    super(message);
    this.name = 'VideoInputError';
  }
}

/** Tool paths on this machine (VIDEO_EDIT_FFMPEG / VIDEO_EDIT_FFPROBE honoured). */
export const machineTools = (): ToolPaths => ({ ytdlp: locateMediaTool('yt-dlp'), ffmpeg: locateMediaTool('ffmpeg'), ffprobe: locateMediaTool('ffprobe') });

export const tmpRoot = (ctx: Pick<ModuleContext, 'dataDir'>): string => path.join(ctx.dataDir, 'tmp');

/** Remove everything left in tmp/ (a crash or a kill mid-job). Called at module start. */
export function cleanTmp(ctx: Pick<ModuleContext, 'dataDir' | 'log'>): number {
  const root = tmpRoot(ctx);
  let n = 0;
  try {
    for (const name of fs.readdirSync(root)) {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
      n++;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') ctx.log.warn({ err: (e as Error).message }, 'dream: không dọn được tmp');
  }
  return n;
}

/** A public video link: http(s) only, no credentials in it. */
export function parseVideoUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (!u.hostname.includes('.')) return null;
  return u.toString();
}

export function getVideo(ctx: Pick<ModuleContext, 'db'>, id: string): VideoRow | undefined {
  return ctx.db.prepare('SELECT * FROM dream_videos WHERE id = ?').get(id) as VideoRow | undefined;
}

export function listVideos(ctx: Pick<ModuleContext, 'db'>, limit = 200): VideoRow[] {
  return ctx.db.prepare('SELECT * FROM dream_videos ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as VideoRow[];
}

/** Queue links for analysis. Returns the new rows and the lines skipped with a reason. */
export function queueVideos(
  ctx: Pick<ModuleContext, 'db'>,
  input: { text: string; channelId?: string | null; folderId: string },
): { queued: VideoRow[]; skipped: { input: string; reason: string }[] } {
  if (input.channelId && !getChannel(ctx, input.channelId)) throw new VideoInputError('Không tìm thấy kênh đã chọn.');
  const tokens = input.text.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) throw new VideoInputError('Chưa có link video nào.');
  if (tokens.length > MAX_URLS_PER_PASTE) throw new VideoInputError(`Mỗi lần dán tối đa ${MAX_URLS_PER_PASTE} link.`);
  const queued: VideoRow[] = [];
  const skipped: { input: string; reason: string }[] = [];
  for (const token of tokens) {
    const url = parseVideoUrl(token);
    if (!url) {
      skipped.push({ input: token.slice(0, 200), reason: 'Không phải link http(s) hợp lệ.' });
      continue;
    }
    if (ctx.db.prepare("SELECT 1 FROM dream_videos WHERE url = ? AND status IN ('queued','running')").get(url)) {
      skipped.push({ input: token.slice(0, 200), reason: 'Link này đang chờ hoặc đang phân tích.' });
      continue;
    }
    const id = newId('vd');
    ctx.db
      .prepare("INSERT INTO dream_videos (id, channel_id, url, folder_id, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)")
      .run(id, input.channelId ?? null, url, input.folderId, Date.now());
    queued.push(getVideo(ctx, id)!);
  }
  return { queued, skipped };
}

/** Put a failed job back in the queue. */
export function retryVideo(ctx: Pick<ModuleContext, 'db'>, id: string): VideoRow {
  const row = getVideo(ctx, id);
  if (!row) throw new VideoInputError('Không tìm thấy video.');
  if (row.status !== 'failed') throw new VideoInputError('Chỉ chạy lại được video đã lỗi.');
  ctx.db.prepare("UPDATE dream_videos SET status = 'queued', step = NULL, reason = NULL, started_at = NULL, finished_at = NULL WHERE id = ?").run(id);
  return getVideo(ctx, id)!;
}

const set = (ctx: Pick<ModuleContext, 'db'>, id: string, fields: Partial<VideoRow>) => {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  ctx.db.prepare(`UPDATE dream_videos SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => (fields as Record<string, unknown>)[k] ?? null), id);
};

const fmt = (n: number | null | undefined, digits = 0) => (n === null || n === undefined ? '—' : n.toLocaleString('vi-VN', { maximumFractionDigits: digits }));

const ymd = (ms: number) => {
  const d = new Date(ms + 7 * 3600_000); // Asia/Ho_Chi_Minh day, like the rest of the app
  return d.toISOString().slice(0, 10);
};

interface Measured {
  info: PublicInfo;
  durationS: number | null;
  stats: CutStats | null;
  hasSubtitles: boolean;
  label: LabelOutcome | null;
  capturedAt: number;
}

/** Note body: the numbers and the bot's description of the structure. Nothing from the video's words. */
export function videoNoteBody(row: Pick<VideoRow, 'url'>, m: Measured, reason: string | null): string {
  const s = m.stats;
  const l = m.label?.labels ?? null;
  const lines = [
    `# Video mẫu ${m.info.nativeId ?? ''}`.trim(),
    '',
    `Link: ${row.url}`,
    '',
    '## Số đo',
    '',
    '| | |',
    '|---|---|',
    `| Lượt xem | ${fmt(m.info.views)} |`,
    `| Lượt thích | ${fmt(m.info.likes)} |`,
    `| Bình luận | ${fmt(m.info.comments)} |`,
    `| Đọc số lúc | ${new Date(m.capturedAt).toISOString()} |`,
    `| Độ dài | ${m.durationS === null ? '—' : `${fmt(m.durationS, 1)} giây`} |`,
    `| Số lần cắt | ${s ? `khoảng ${s.cuts}` : '—'} |`,
    `| Cắt mỗi phút | ${s ? `khoảng ${fmt(s.cutsPerMin, 1)}` : '—'} |`,
    `| Cắt trong 3 giây đầu | ${s ? `khoảng ${s.cutsFirst3s}` : '—'} |`,
    `| Cảnh dài nhất | ${s ? `${fmt(s.longestSceneS, 1)} giây` : '—'} |`,
    '',
    'Số cắt đo bằng máy với ngưỡng đổi cảnh 0,3: bỏ sót chuyển cảnh mềm, đếm thừa khi có hiệu ứng chớp. Chỉ là số xấp xỉ.',
    '',
    '## Cấu trúc (bot mô tả)',
    '',
  ];
  if (l) {
    lines.push(
      `- Mở đầu: ${LABEL_TEXT[l.mo_dau]}`,
      `- Cấu trúc: ${LABEL_TEXT[l.cau_truc]}`,
      `- Kêu gọi: ${LABEL_TEXT[l.keu_goi]}${l.giay_keu_goi !== null ? `, ở giây ${fmt(l.giay_keu_goi, 1)}` : ''}`,
      `- Căn cứ: ${m.hasSubtitles ? 'phụ đề tự động' : 'không có phụ đề'}${m.label?.usedFrames ? ', 4 khung hình 3 giây đầu' : ''}`,
    );
  } else {
    lines.push('Chưa gắn nhãn.');
  }
  if (m.label?.note) lines.push('', `Ghi chú: ${m.label.note}`);
  if (reason) lines.push('', `Chưa mổ xẻ xong: ${reason}`);
  lines.push('', 'Không lưu lời thoại, khung hình hay file video. Chỉ giữ số đo và nhãn.', '');
  return lines.join('\n');
}

function writeVideoNote(ctx: DreamCtx, row: VideoRow, m: Measured, reason: string | null): string {
  const ch = row.channel_id ? getChannel(ctx, row.channel_id) : undefined;
  const chSlug = ch?.note_path ? path.posix.basename(ch.note_path, '.md') : null;
  const kenhName = chSlug ?? slugify(m.info.uploader ?? '', 'khong-ro');
  const relPath = `dream-100/video/${ymd(m.capturedAt)}-${kenhName}-${row.id}.md`;
  const l = m.label?.labels ?? null;
  const data: Record<string, unknown> = {
    loai: 'video-dream',
    kenh: chSlug ? `[[${chSlug}]]` : kenhName,
    link: row.url,
    nen_tang: m.info.platform,
    luot_xem: m.info.views,
    luot_thich: m.info.likes,
    binh_luan: m.info.comments,
    lay_luc: new Date(m.capturedAt).toISOString(),
    do_dai: m.durationS === null ? null : Math.round(m.durationS * 10) / 10,
    so_cat_khoang: m.stats?.cuts ?? null,
    cat_moi_phut: m.stats?.cutsPerMin ?? null,
    cat_3s_dau: m.stats?.cutsFirst3s ?? null,
    canh_dai_nhat: m.stats?.longestSceneS ?? null,
    // mo_dau follows the shared list; "thieu-du-lieu" is written as empty
    mo_dau: l && l.mo_dau !== 'thieu-du-lieu' ? l.mo_dau : null,
    cau_truc: l?.cau_truc ?? null,
    keu_goi: l?.keu_goi ?? null,
    giay_keu_goi: l?.giay_keu_goi ?? null,
    trang_thai: reason ? 'chua-mo-xe' : l ? 'da-mo-xe' : 'thieu-nhan',
    ly_do: reason,
  };
  ctx.brain.notes.create({ folderId: row.folder_id, relPath }, data, videoNoteBody(row, m, reason), { message: `Dream 100: phân tích video ${row.id}` });
  return relPath;
}

/** Turn any error of a step into the Vietnamese reason stored on the job. */
export function reasonOf(e: unknown): string {
  if (e instanceof MeasureError) return e.message;
  if (e instanceof ToolTimeoutError) return e.message;
  if (e instanceof ToolStartError) return `${e.message}. ${missingToolHint(e.tool)}`;
  return `Lỗi không lường trước: ${(e as Error)?.message?.slice(0, 160) ?? String(e)}`;
}

/**
 * Run one queued job to the end. Never throws; the outcome is in the row. The work dir is always removed.
 * A note is written once yt-dlp gave the public numbers, also when a later step failed (with the reason).
 */
export async function runJob(ctx: DreamCtx, id: string, tools: ToolPaths = machineTools(), signal?: AbortSignal): Promise<VideoRow> {
  const row = getVideo(ctx, id);
  if (!row) throw new VideoInputError('Không tìm thấy video.');
  const dir = path.join(tmpRoot(ctx), id);
  set(ctx, id, { status: 'running', step: 'tai', started_at: Date.now(), reason: null });
  ctx.events.emit('video', { id, status: 'running' });
  let measured: Measured | null = null;
  let reason: string | null = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const dl = await download(tools, row.url, dir, signal);
    const capturedAt = Date.now();
    const info = publicInfo(dl.info);
    measured = { info, durationS: info.durationS, stats: null, hasSubtitles: Boolean(dl.subtitles), label: null, capturedAt };
    set(ctx, id, {
      platform: info.platform, native_id: info.nativeId, title: info.title, uploader: info.uploader,
      views: info.views, likes: info.likes, comments: info.comments, captured_at: capturedAt, has_subtitles: dl.subtitles ? 1 : 0, step: 'do',
    });
    const durationS = await probeDuration(tools, dl.video, signal);
    measured.durationS = durationS;
    const stats = cutStats(await sceneTimes(tools, dl.video, signal), durationS);
    measured.stats = stats;
    set(ctx, id, { duration_s: durationS, cuts: stats.cuts, cuts_per_min: stats.cutsPerMin, cuts_first3s: stats.cutsFirst3s, longest_scene_s: stats.longestSceneS, step: 'khung-hinh' });
    const frames = await hookFrames(tools, dl.video, dir, signal);
    set(ctx, id, { step: 'gan-nhan' });
    const label = await labelVideo(ctx, { durationS, stats, subtitles: dl.subtitles, frames, jobId: id }, signal);
    measured.label = label;
    set(ctx, id, {
      mo_dau: label.labels?.mo_dau ?? null, cau_truc: label.labels?.cau_truc ?? null, keu_goi: label.labels?.keu_goi ?? null,
      giay_keu_goi: label.labels?.giay_keu_goi ?? null, label_note: label.note, used_frames: label.usedFrames ? 1 : 0,
      agent_id: label.agentId, task_id: label.taskId,
    });
  } catch (e) {
    reason = reasonOf(e);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      ctx.log.warn({ id, err: (e as Error).message }, 'dream: không xoá được thư mục tạm');
    }
  }
  if (signal?.aborted) {
    // the module is stopping: put the job back, it runs again at the next start
    set(ctx, id, { status: 'queued', step: null, reason: null, started_at: null });
    return getVideo(ctx, id)!;
  }
  let notePath: string | null = null;
  if (measured) {
    try {
      notePath = writeVideoNote(ctx, getVideo(ctx, id)!, measured, reason);
    } catch (e) {
      reason = reason ?? `Đo xong nhưng không ghi được ghi chú: ${(e as Error).message.slice(0, 200)}`;
    }
  }
  set(ctx, id, { status: reason ? 'failed' : 'done', step: null, reason, note_path: notePath, finished_at: Date.now() });
  ctx.events.emit('video', { id, status: reason ? 'failed' : 'done' });
  return getVideo(ctx, id)!;
}

/** Runs queued jobs one at a time, in the order they were pasted. */
export class JobQueue {
  private running: Promise<void> | null = null;
  private ctrl = new AbortController();
  private stopped = false;

  constructor(
    private readonly ctx: DreamCtx,
    private readonly tools: () => ToolPaths = machineTools,
  ) {}

  /** Start draining the queue if it is not already running. */
  kick(): void {
    if (this.running || this.stopped) return;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const next = this.ctx.db.prepare("SELECT id FROM dream_videos WHERE status = 'queued' ORDER BY created_at, id LIMIT 1").get() as { id: string } | undefined;
      if (!next) return;
      try {
        await runJob(this.ctx, next.id, this.tools(), this.ctrl.signal);
      } catch (e) {
        set(this.ctx, next.id, { status: 'failed', step: null, reason: reasonOf(e), finished_at: Date.now() });
      }
    }
  }

  /** Wait for the current drain (tests). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ctrl.abort();
    await this.idle();
  }
}

/** Jobs left 'running' by a crash go back to the queue. */
export function requeueInterrupted(ctx: Pick<ModuleContext, 'db'>): number {
  return ctx.db.prepare("UPDATE dream_videos SET status = 'queued', step = NULL WHERE status = 'running'").run().changes;
}
