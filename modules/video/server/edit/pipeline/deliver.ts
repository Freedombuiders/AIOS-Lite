// Step "Giao & đăng": copy the finished video and covers to the profile's delivery folder.
import fs from 'node:fs';
import path from 'node:path';
import type { EditPlan, VideoProfile, VideoProject } from '../types.js';
import type { VideoEditStore } from '../store.js';
import { slugify } from '../store.js';

export interface DeliverResult {
  dir: string;
  files: string[];
}

/** Copies never overwrite an older delivery: a new version gets its own `final.v<N>.mp4`. */
export function deliverProject(
  store: VideoEditStore,
  project: Pick<VideoProject, 'id' | 'code' | 'title'>,
  profile: Pick<VideoProfile, 'deliverDir'>,
  plan: EditPlan,
  version: number,
): DeliverResult | null {
  const base = profile.deliverDir?.trim();
  if (!base) return null;
  if (!path.isAbsolute(base)) throw new Error('Thư mục giao phải là đường dẫn đầy đủ.');
  const dir = path.join(base, `${project.code}-${slugify(plan.meta.title || project.title)}`);
  fs.mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const copy = (src: string | null, name: string) => {
    if (!src || !fs.existsSync(src)) return;
    const dest = path.join(dir, name);
    fs.copyFileSync(src, dest);
    files.push(dest);
  };
  copy(store.finalFile(project.id, version), `final.v${version}.mp4`);
  for (const n of [1, 2, 3] as const) copy(store.coverFile(project.id, n), `cover-${n}.v${version}.jpg`);
  const meta = [
    plan.meta.title,
    '',
    plan.meta.caption,
    '',
    plan.meta.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' '),
  ].join('\n').trim();
  const metaFile = path.join(dir, `meta.v${version}.txt`);
  fs.writeFileSync(metaFile, `${meta}\n`);
  files.push(metaFile);
  return { dir, files };
}
