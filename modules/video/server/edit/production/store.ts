/**
 * Production store: JSON files under STORE_DIR/video-edit/productions/<id>/
 *   production.json   the Production
 *   scenes/<sceneId>.mp4 / .srt / .jpg   generated or copied scene media
 * and STORE_DIR/video-edit/kol-voices.json for the per-KOL HeyGen voice.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { isUuid, StoreError } from '../store.js';
import type { VideoAspect } from '../types.js';
import type { KolBrand, KolVoice, Production, ProductionScene, ProductionSummary, SceneEngine, SceneKind } from './types.js';
import { DEFAULT_BRAND } from './types.js';

export interface NewScene {
  kind: SceneKind;
  kolId?: string | null;
  text?: string;
  visual?: string;
  engine?: SceneEngine;
  model?: string | null;
  sourceAssetId?: string | null;
  clipAssetId?: string | null;
  durationSec?: number;
}

export function defaultEngine(kind: SceneKind): SceneEngine {
  return kind === 'talking' ? 'heygen' : kind === 'clip' ? 'clip' : 'veo';
}

export function makeScene(input: NewScene, now = new Date().toISOString()): ProductionScene {
  const kind = input.kind;
  return {
    id: randomUUID(),
    kind,
    kolId: input.kolId ?? null,
    text: (input.text ?? '').trim().slice(0, 2000),
    visual: (input.visual ?? '').trim().slice(0, 1200),
    engine: input.engine ?? defaultEngine(kind),
    model: input.model ?? null,
    sourceAssetId: input.sourceAssetId ?? null,
    clipAssetId: input.clipAssetId ?? null,
    durationSec: clampDuration(input.durationSec ?? (kind === 'talking' ? estimateSpeechSec(input.text ?? '') : 5)),
    trimStart: 0,
    take: 0,
    status: 'draft',
    job: null,
    output: null,
    error: null,
    updatedAt: now,
  };
}

export function clampDuration(sec: number): number {
  return Math.min(120, Math.max(1, Math.round((Number.isFinite(sec) ? sec : 5) * 10) / 10));
}

/** Vietnamese speech runs at about 3 words per second in a calm presenter voice. */
export function estimateSpeechSec(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words ? Math.max(2, Math.round((words / 3) * 10) / 10) : 5;
}

export function createProductionStore(root: string) {
  const dir = path.join(root, 'productions');
  const voicesFile = path.join(root, 'kol-voices.json');
  const brandFile = path.join(root, 'kol-brand.json');

  const ensure = (d: string) => fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const requireId = (id: string) => {
    if (!isUuid(id)) throw new StoreError(404, 'Không tìm thấy video này.');
    return id;
  };
  const prodDir = (id: string) => path.join(dir, requireId(id));
  const file = (id: string) => path.join(prodDir(id), 'production.json');

  function writeJson(f: string, data: unknown) {
    ensure(path.dirname(f));
    const tmp = path.join(path.dirname(f), `.${randomUUID()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
  }
  function readJson<T>(f: string): T | null {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')) as T; } catch { return null; }
  }

  /** Older productions predate projectId/pendingApproval/trim. */
  function normalize(p: Production): Production {
    return {
      ...p, projectId: p.projectId ?? null, pendingApproval: p.pendingApproval ?? null, series: p.series ?? null,
      scenes: p.scenes.map((s) => ({ ...s, trimStart: s.trimStart ?? 0, take: s.take ?? 0, retry: s.retry ?? null })),
    };
  }
  function get(id: string): Production | null {
    const p = readJson<Production>(file(id));
    return p ? normalize(p) : null;
  }
  function require(id: string): Production {
    const p = get(id);
    if (!p) throw new StoreError(404, 'Không tìm thấy video này.');
    return p;
  }
  function save(p: Production): Production {
    const next = { ...p, updatedAt: new Date().toISOString() };
    writeJson(file(p.id), next);
    return next;
  }
  function update(id: string, fn: (p: Production) => void): Production {
    const p = require(id);
    fn(p);
    return save(p);
  }

  function create(input: { brief: string; cast: string[]; aspect: VideoAspect; targetSec: number; title?: string; series?: Production['series'] }): Production {
    const now = new Date().toISOString();
    const brief = input.brief.trim();
    const p: Production = {
      id: randomUUID(),
      projectId: null,
      pendingApproval: null,
      series: input.series ?? null,
      title: (input.title?.trim() || brief.split('\n')[0] || 'Video mới').slice(0, 90),
      titleLocked: Boolean(input.title?.trim()),
      cast: [...new Set(input.cast)].slice(0, 6),
      brief: brief.slice(0, 6000),
      aspect: input.aspect,
      targetSec: Math.min(180, Math.max(5, Math.round(input.targetSec))),
      script: null,
      scenes: [],
      state: 'brief',
      finishProjectId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    writeJson(file(p.id), p);
    return p;
  }

  function list(): ProductionSummary[] {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    const out: ProductionSummary[] = [];
    for (const n of names) {
      if (!isUuid(n)) continue;
      const p = readJson<Production>(path.join(dir, n, 'production.json'));
      if (!p) continue;
      const thumbScene = p.scenes.find((s) => s.output?.thumb);
      out.push({
        id: p.id, title: p.title, cast: p.cast, aspect: p.aspect, targetSec: p.targetSec, state: p.state,
        finishProjectId: p.finishProjectId, projectId: p.projectId ?? null, series: p.series ?? null,
        pendingApproval: Boolean(p.pendingApproval), createdAt: p.createdAt, updatedAt: p.updatedAt,
        scenes: p.scenes.length, scenesDone: p.scenes.filter((s) => s.status === 'done').length,
        thumb: thumbScene ? `/api/m/video/edit/productions/${p.id}/scenes/${thumbScene.id}/thumb` : null,
      });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function remove(id: string): void {
    fs.rmSync(prodDir(id), { recursive: true, force: true });
  }

  const scenesDir = (id: string) => path.join(prodDir(id), 'scenes');
  function sceneFile(id: string, sceneId: string, ext: 'mp4' | 'srt' | 'jpg' | 'png' | 'sheet.jpg'): string {
    if (!isUuid(sceneId)) throw new StoreError(404, 'Không tìm thấy cảnh này.');
    ensure(scenesDir(id));
    return path.join(scenesDir(id), `${sceneId}.${ext}`);
  }
  const workDir = (id: string) => { const d = path.join(prodDir(id), 'work'); ensure(d); return d; };

  function voices(): Record<string, KolVoice> {
    return readJson<Record<string, KolVoice>>(voicesFile) ?? {};
  }
  function setVoice(kolId: string, voice: KolVoice | null): Record<string, KolVoice> {
    const all = voices();
    if (voice) all[kolId] = voice; else delete all[kolId];
    writeJson(voicesFile, all);
    return all;
  }

  function brands(): Record<string, KolBrand> {
    return readJson<Record<string, KolBrand>>(brandFile) ?? {};
  }
  function brand(kolId: string): KolBrand {
    return { ...DEFAULT_BRAND, ...(brands()[kolId] ?? {}) };
  }
  function setBrand(kolId: string, input: Partial<KolBrand>): KolBrand {
    const all = brands();
    const next: KolBrand = {
      ...DEFAULT_BRAND, ...(all[kolId] ?? {}), ...input,
    };
    next.cta = next.cta.trim().slice(0, 200);
    next.intro = next.intro.trim().slice(0, 200);
    next.outro = next.outro.trim().slice(0, 200);
    next.captionNote = next.captionNote.trim().slice(0, 300);
    all[kolId] = next;
    writeJson(brandFile, all);
    return next;
  }

  /** Productions with scenes still waiting on a provider (resumed after a restart). */
  function pendingIds(): string[] {
    return list().filter((s) => s.state === 'generating').map((s) => s.id);
  }

  /** Productions holding an approval card (checked for cards that expired or failed elsewhere). */
  function awaitingApproval(): string[] {
    return list().filter((s) => s.pendingApproval).map((s) => s.id);
  }

  return { root, get, require, save, update, create, list, remove, sceneFile, scenesDir, workDir, voices, setVoice, brand, setBrand, pendingIds, awaitingApproval };
}

export type ProductionStore = ReturnType<typeof createProductionStore>;
