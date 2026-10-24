/**
 * "Đăng": the finished render goes into the KOL's gallery and becomes a KOL Studio post draft
 * (the owner reviews, picks channels and schedules it there). Idempotent per persona + render version.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { importAssetFromUpload } from '../../kol-port.js';
import { createPost } from '../../kol-port.js';
import { loadCurrentPlan } from '../agent/approval-handler.js';
import { StoreError, type VideoEditStore } from '../store.js';
import type { VideoProject } from '../types.js';
import type { ProductionStore } from './store.js';

export interface PublishResult {
  postId: string;
  assetId: string;
  personaId: string;
  version: number;
  link: string;
  reused: boolean;
}

export interface PublishDeps {
  editStore: VideoEditStore;
  productions: ProductionStore;
  emitProject: (p: VideoProject) => void;
  /** Test seams. */
  importAsset?: typeof importAssetFromUpload;
  createPost?: typeof createPost;
}

export async function publishToKol(deps: PublishDeps, projectId: string, input: { personaId?: string; version?: number }): Promise<PublishResult> {
  const project = deps.editStore.loadProject(projectId);
  if (!project) throw new StoreError(404, 'Không tìm thấy video này.');
  const version = input.version ?? project.renders?.at(-1)?.version;
  const file = version !== undefined ? deps.editStore.finalFile(projectId, version) : null;
  if (!file || version === undefined) throw new StoreError(409, 'Chưa có bản xuất cuối. Xuất video trước rồi mới đăng.', 'no_render');
  const production = project.productionId ? deps.productions.get(project.productionId) : null;
  const personaId = input.personaId || production?.cast[0];
  if (!personaId) throw new StoreError(400, 'Chọn KOL sẽ đăng video này.', 'no_persona');

  const done = project.published?.find((x) => x.personaId === personaId && x.version === version);
  if (done) return { postId: done.postId, assetId: done.assetId, personaId, version, link: `/kol/${encodeURIComponent(personaId)}?tab=content&post=${encodeURIComponent(done.postId)}`, reused: true };

  const plan = loadCurrentPlan(deps.editStore, project);
  const title = plan?.meta.title || production?.script?.title || project.title;
  const caption = plan?.meta.caption || production?.script?.caption || '';
  const hashtags = (plan?.meta.hashtags?.length ? plan.meta.hashtags : production?.script?.hashtags ?? []).map((h) => h.replace(/^#/, '')).filter(Boolean).slice(0, 15);

  // importAssetFromUpload consumes its input: give it a copy.
  const tmp = path.join(os.tmpdir(), `video-studio-${randomUUID()}.mp4`);
  fs.copyFileSync(file, tmp);
  let assetId: string;
  try {
    const asset = await (deps.importAsset ?? importAssetFromUpload)(personaId, tmp, { status: 'approved', tags: ['video-studio'], fileName: `${title.slice(0, 60)}.mp4` });
    assetId = asset.id;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const post = (deps.createPost ?? createPost)(personaId, {
    title: title.slice(0, 120), caption, hashtags, assetIds: [assetId],
    format: project.aspect === '9:16' ? 'reel' : 'video',
    ...(production?.brief ? { brief: production.brief.slice(0, 2000) } : {}),
  }, { source: 'owner', sourceRef: `video-studio:${projectId}:v${version}`, status: 'draft' });

  const next = deps.editStore.updateProject(projectId, (p) => {
    p.published = [...(p.published ?? []), { personaId, postId: post.id, assetId, version, at: new Date().toISOString() }];
  });
  if (next) deps.emitProject(next);
  return { postId: post.id, assetId, personaId, version, link: `/kol/${encodeURIComponent(personaId)}?tab=content&post=${encodeURIComponent(post.id)}`, reused: false };
}
