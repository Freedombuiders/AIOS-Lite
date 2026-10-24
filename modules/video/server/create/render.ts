/** From-scratch assembly: only verified project copies, no raw source/transcript or agent code. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { VideoEditStore } from '../edit/store.js';
import type { RenderRecord } from '../edit/types.js';
import { probeMedia } from '../edit/media.js';
import { runFfmpeg } from '../edit/pipeline/tools.js';

const assText = (text: string) => text.replace(/[\\{}]/g, '').replace(/[\r\n]+/g, '\\N');
function subtitles(text: string, width: number, height: number): string {
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,${Math.round(width / 22)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,2,45,45,${Math.round(height * .14)},1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:01:00.00,Default,,0,0,0,,${assText(text)}\n`;
}
export async function renderCreation(store: VideoEditStore, projectId: string, options: { signal?: AbortSignal; progress?: (fraction: number, message?: string) => void } = {}): Promise<RenderRecord> {
  const project = store.loadProject(projectId);
  if (project?.mode !== 'create' || !project.creation?.scenes.length) throw new Error('Chưa có kế hoạch tạo mới.');
  const scenes = project.creation.scenes;
  if (scenes.some(s => s.state !== 'imported' || !s.mediaFile || !s.mediaSha256)) throw new Error('Chưa nhận đủ file thật cho các cảnh.');
  const dir = store.projectDir(projectId);
  const work = path.join(dir, 'assembly'); fs.mkdirSync(work, { recursive: true });
  const [width, height] = project.aspect === '9:16' ? [720, 1280] : project.aspect === '16:9' ? [1280, 720] : [720, 720];
  for (const [index, scene] of scenes.entries()) {
    options.signal?.throwIfAborted();
    const file = path.resolve(dir, scene.mediaFile!);
    if (!/^generated\/scene-\d+\.(png|jpg|jpeg|webp|mp4|webm|mov)$/.test(scene.mediaFile!) || !fs.realpathSync(file).startsWith(fs.realpathSync(dir) + path.sep)) throw new Error('Invalid project media');
    const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (hash !== scene.mediaSha256) throw new Error('File cảnh đã thay đổi sau khi xác minh.');
    const media = await probeMedia(file);
    if (scene.kind === 'video' && media.durationSec + .1 < scene.durationSec) throw new Error(`Cảnh ${index + 1} ngắn hơn kế hoạch; không tự lặp video.`);
    const captionFile = `caption-${index}.ass`;
    fs.writeFileSync(path.join(work, captionFile), subtitles(scene.caption, width, height));
    const filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30${scene.caption ? `,subtitles=${captionFile}` : ''}`;
    const native = scene.kind === 'video' && media.hasAudio && project.creation.brief.audio === 'native';
    await runFfmpeg([
      ...(scene.kind === 'image' ? ['-loop', '1'] : []), '-i', file,
      ...(!native ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : []),
      '-map', '0:v:0', '-map', native ? '0:a:0' : '1:a:0', '-t', String(scene.durationSec),
      '-vf', filter, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-y', `scene-${index}.mp4`,
    ], { cwd: work, signal: options.signal, timeoutMs: 180_000 });
    options.progress?.((index + 1) / (scenes.length + 1), `Đã lắp cảnh ${index + 1}/${scenes.length}`);
  }
  fs.writeFileSync(path.join(work, 'concat.txt'), scenes.map((_, i) => `file 'scene-${i}.mp4'`).join('\n'));
  const renders = store.rendersDir(projectId); fs.mkdirSync(renders, { recursive: true });
  const tmp = path.join(renders, '.create.part.mp4');
  await runFfmpeg(['-f', 'concat', '-safe', '1', '-i', 'concat.txt', '-c', 'copy', '-movflags', '+faststart', '-y', tmp], { cwd: work, signal: options.signal, timeoutMs: 120_000 });
  options.signal?.throwIfAborted();
  const media = await probeMedia(tmp);
  const wanted = scenes.reduce((n, s) => n + s.durationSec, 0);
  if (media.width !== width || media.height !== height || media.durationSec <= 0 || Math.abs(media.durationSec - wanted) > .6) throw new Error('Bản xuất không khớp kích thước/thời lượng kế hoạch.');
  const file = path.join(renders, 'final.v1.mp4'); fs.renameSync(tmp, file);
  options.progress?.(1, 'Đã kiểm tra MP4 thật');
  return { version: 1, file: 'renders/final.v1.mp4', durationSec: media.durationSec, sizeBytes: media.sizeBytes, createdAt: new Date().toISOString() };
}
