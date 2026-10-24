/**
 * The one door from Video Studio into KOL Studio. Read-only for characters (profile, approved images,
 * gallery videos); generation goes through KOL Studio's own queue (identity lock, spend caps, ledger),
 * and KOL-free b-roll goes through KOL Studio's provider adapters with the same admission + ledger.
 * Video Studio never writes KOL data.
 */

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { getAsset, getAssetFile, listAssets } from '../../kol-port.js';
import { loadSettings } from '../../kol-port.js';
import { downloadOutput, getGeneration, requestGeneration } from '../../kol-port.js';
import { getPersona, listPersonaSummaries } from '../../kol-port.js';
import { unitPriceUsd } from '../../kol-port.js';
import { findModel, getAdapter, isProviderConfigured } from '../../kol-port.js';
import { admission, recordSpend } from '../../kol-port.js';
import type { Aspect, PersonaDto } from '../../kol-port.js';
import type { CastMember, KolVoice } from './types.js';

export const STUDIO_SPEND_ID = '_video-studio';
export const VEO_MODEL = 'veo-3.1-fast-generate-preview';
export const FAL_VIDEO_MODEL = 'fal-ai/kling-video/v3/pro/image-to-video';

export interface KolVideoRequest {
  kolId: string;
  sourceAssetId: string;
  model: string;
  aspect: Aspect;
  durationSec: number;
  prompt: string;
  /** Spoken line for models with native audio (Veo). */
  script?: string;
  audio: boolean;
}

/** A KOL image or gallery video as the director sees it when choosing a face or a clip. */
export interface KolMediaItem { id: string; kind: 'image' | 'video'; status: string; label: string; durationSec: number | null; createdAt: number; identityScore?: number | null }

/**
 * A short "outfit · setting · pose" label from a KOL Studio image prompt. The compiled prompt opens with
 * long identity boilerplate; what tells images apart is its DIRECTION block and the additional direction.
 */
export function describeKolPrompt(prompt: string, tags: string[] = []): string {
  const direction = /DIRECTION:\s*([\s\S]*?)(?:\n\n[A-Z][A-Z /&]{3,40}:|$)/.exec(prompt)?.[1] ?? '';
  const extra = /Additional direction:\s*([\s\S]*?)(?:\n\n|$)/.exec(prompt)?.[1] ?? '';
  const parts: string[] = [];
  for (const raw of direction.split('\n')) {
    const line = raw.replace(/^\s*-\s*/, '').trim();
    if (!line) continue;
    const outfit = /^Outfit:\s*(?:REPLACE (?:his|her|their) clothing completely with\s*)?([^.;]+)/i.exec(line);
    if (outfit) { parts.push(`mặc ${outfit[1].trim()}`); continue; }
    const field = /^(Setting|Location|Scene|Pose|Activity|Background)\s*:\s*([^.;]+)/i.exec(line);
    if (field) { parts.push(field[2].trim()); continue; }
    if (!parts.length) parts.push(line.split('.')[0]);
  }
  if (extra.trim()) parts.push(extra.trim().split('.')[0]);
  if (!parts.length && prompt.trim()) parts.push(prompt.replace(/\s+/g, ' ').slice(0, 120));
  return [tags.slice(0, 6).join(', '), ...parts].filter(Boolean).join(' · ').slice(0, 260);
}

export interface KolBridge {
  listCast(voices: Record<string, KolVoice>): CastMember[];
  /** Images (approved first) and gallery videos with a short label from their prompt/tags. */
  media(kolId: string): KolMediaItem[];
  member(id: string, voices: Record<string, KolVoice>): CastMember | null;
  persona(id: string): PersonaDto | null;
  /** Absolute file of a KOL image asset, checked to belong to the KOL. */
  imageFile(kolId: string, assetId: string): { abs: string; mime: string };
  videoFile(assetId: string): { abs: string; durationSec: number | null };
  ready(provider: 'gemini' | 'fal'): boolean;
  /** Queues an identity-locked KOL video in KOL Studio; returns the generation id. */
  requestVideo(req: KolVideoRequest): string;
  generation(id: string): { status: 'queued' | 'running' | 'done' | 'failed'; error: string; assetId: string | null; costUsd: number } | null;
  /** KOL-free text-to-video (Veo) with KOL Studio's admission + ledger. Returns a handle. */
  submitBroll(req: { prompt: string; aspect: Aspect; durationSec: number; key: string }): Promise<string>;
  pollBroll(handle: string, dest: string): Promise<'pending' | { done: true } | { error: string }>;
}

/**
 * Veo b-roll submitted but not finished yet, by handle: admission counts it, so a batch of N scenes
 * cannot pass the same cap headroom N times (spend is only recorded when a clip arrives).
 */
const inflight = new Map<string, number>();
const reserved = () => [...inflight.values()].reduce((t, x) => t + x, 0);

const nearest = (wanted: number, allowed: number[] | undefined) =>
  allowed?.length ? allowed.reduce((best, d) => (Math.abs(d - wanted) < Math.abs(best - wanted) ? d : best), allowed[0]) : wanted;

/** Veo only renders 9:16 and 16:9; the assembler crops to the production frame. */
export function veoAspect(aspect: string): Aspect {
  return aspect === '16:9' || aspect === '1:1' || aspect === '5:4' ? '16:9' : '9:16';
}

export const kolBridge: KolBridge = {
  listCast(voices) {
    return listPersonaSummaries().filter((p) => p.status !== 'archived').map((p) => kolBridge.member(p.id, voices)).filter((m): m is CastMember => Boolean(m));
  },

  member(id, voices) {
    const p = listPersonaSummaries().find((x) => x.id === id);
    if (!p) return null;
    const images = listAssets({ personaId: id, kind: 'image', limit: 80 }).assets
      .filter((a) => a.status !== 'rejected')
      .sort((a, b) => Number(b.status === 'approved') - Number(a.status === 'approved') || b.createdAt - a.createdAt)
      .slice(0, 40)
      .map((a) => ({ id: a.id, url: a.url, thumbUrl: a.thumbUrl, width: a.width, height: a.height }));
    const videos = listAssets({ personaId: id, kind: 'video', limit: 30 }).assets
      .filter((a) => a.status !== 'rejected')
      .map((a) => ({ id: a.id, url: a.url, thumbUrl: a.thumbUrl, durationSec: a.durationSec }));
    return {
      id: p.id, name: p.name, handle: p.handle, avatarUrl: p.avatarUrl ?? null, tagline: p.tagline, status: p.status,
      images, videos, voice: voices[id] ?? null, realPerson: getPersona(id)?.identitySource === 'licensed',
    };
  },

  media(kolId) {
    const label = (a: { prompt?: string; tags?: string[] }) => describeKolPrompt(a.prompt ?? '', a.tags ?? []);
    const images = listAssets({ personaId: kolId, kind: 'image', limit: 80 }).assets
      .filter((a) => a.status !== 'rejected')
      .sort((a, b) => Number(b.status === 'approved') - Number(a.status === 'approved') || b.createdAt - a.createdAt)
      .slice(0, 40);
    const videos = listAssets({ personaId: kolId, kind: 'video', limit: 30 }).assets.filter((a) => a.status !== 'rejected');
    return [
      ...images.map((a) => ({ id: a.id, kind: 'image' as const, status: a.status, label: label(a), durationSec: null, createdAt: a.createdAt, identityScore: a.consistency?.score ?? null })),
      ...videos.map((a) => ({ id: a.id, kind: 'video' as const, status: a.status, label: label(a), durationSec: a.durationSec ?? null, createdAt: a.createdAt })),
    ];
  },

  persona: (id) => getPersona(id),

  imageFile(kolId, assetId) {
    const a = getAsset(assetId);
    if (!a || a.personaId !== kolId || a.kind !== 'image') throw new Error('Ảnh KOL không hợp lệ cho cảnh này.');
    const f = getAssetFile(assetId);
    if (!f || !fs.existsSync(f.abs)) throw new Error('Không tìm thấy file ảnh KOL.');
    return { abs: f.abs, mime: f.mime };
  },

  videoFile(assetId) {
    const f = getAssetFile(assetId);
    if (!f || f.kind !== 'video' || !fs.existsSync(f.abs)) throw new Error('Không tìm thấy video trong thư viện KOL.');
    return { abs: f.abs, durationSec: f.durationSec };
  },

  ready: (provider) => isProviderConfigured(provider),

  requestVideo(req) {
    const model = findModel(req.model);
    const g = requestGeneration({
      personaId: req.kolId,
      mode: 'animate',
      selection: { sourceAssetId: req.sourceAssetId },
      params: {
        model: req.model,
        aspect: req.aspect,
        durationSec: nearest(req.durationSec, model?.durations),
        audio: req.audio,
        ...(req.script ? { script: req.script } : {}),
        ...(req.prompt ? { extraPrompt: req.prompt } : {}),
      },
    }, 'video-studio');
    return g.id;
  },

  generation(id) {
    const g = getGeneration(id);
    if (!g) return null;
    const status = (g.status === 'succeeded' ? 'done' : g.status === 'failed' || g.status === 'cancelled' || g.status === 'unknown' ? 'failed' : g.status) as 'queued' | 'running' | 'done' | 'failed';
    return { status, error: g.error, assetId: g.assetIds[0] ?? null, costUsd: g.costUsd };
  },

  async submitBroll(req) {
    const model = findModel(VEO_MODEL);
    if (!model) throw new Error('Không tìm thấy model Veo.');
    const durationSec = nearest(req.durationSec, model.durations);
    const price = unitPriceUsd(model.id, { audio: false }, loadSettings().priceOverrides);
    const estimate = (price?.usd ?? 0) * (price?.unit === 'second' ? durationSec : 1);
    admission(STUDIO_SPEND_ID, estimate + reserved());
    const { handle } = await getAdapter('gemini').submitVideo({
      model, prompt: req.prompt, startFrame: null, refs: [], audioFile: null,
      aspect: req.aspect, quality: 'standard', durationSec, audio: false, idempotencyKey: req.key || randomUUID(),
    });
    inflight.set(handle, estimate);
    return JSON.stringify({ handle, estimate, durationSec });
  },

  async pollBroll(raw, dest) {
    const { handle, estimate } = JSON.parse(raw) as { handle: string; estimate: number };
    // Downloaded and booked in an earlier round (a later step failed): never download or book again.
    const booked = `${dest}.spent`;
    if (fs.existsSync(booked) && fs.existsSync(dest)) { inflight.delete(handle); return { done: true }; }
    const model = findModel(VEO_MODEL)!;
    const r = await getAdapter('gemini').pollVideo(handle, model);
    if (r.state === 'pending') return 'pending';
    if (r.state === 'failed') { inflight.delete(handle); return { error: r.error }; }
    const out = r.outputs[0];
    if (!out) { inflight.delete(handle); return { error: 'Veo không trả video.' }; }
    const d = await downloadOutput(out, 'video');
    fs.writeFileSync(dest, d.bytes);
    const cost = typeof r.reportedCostUsd === 'number' ? r.reportedCostUsd : estimate;
    recordSpend({ personaId: STUDIO_SPEND_ID, generationId: null, provider: 'gemini', model: model.id, kind: 'video', costUsd: cost, costStatus: typeof r.reportedCostUsd === 'number' ? 'reported' : 'estimated', requestedBy: 'video-studio' });
    fs.writeFileSync(booked, handle);
    inflight.delete(handle);
    return { done: true };
  },
};
