// The agent scores B-roll candidates 1–5 against the line being spoken, looking at a small picture of each:
// a downloaded Pexels preview, one frame of a library clip, or the library picture itself.
import fs from 'node:fs';
import path from 'node:path';

import { assetFilePath, findAsset, libraryTmpDir } from '../library/store.js';
import type { Transcript } from '../types.js';
import { hub } from './hub.js';
import { brollScorePrompt, parseScores } from './prompts.js';
import type { AssetCandidate } from './types.js';

const SCORE_TIMEOUT_MS = 4 * 60_000;
/** Candidates per agent turn (one picture each). */
export const SCORE_BATCH = 8;

export interface ScoreRequest {
  agentId: string;
  /** What is being said while the shot is on screen. */
  line?: string;
  description: string;
  keywords: string[];
}

/** The words spoken from the anchor word through the shot (and a little before), at most 40 words. */
export function spokenLine(transcript: Transcript | null, anchorWord: number, durationSec: number): string | undefined {
  const words = transcript?.words ?? [];
  const anchor = words[anchorWord];
  if (!anchor) return undefined;
  const from = anchor.start - 1.5;
  const to = anchor.start + Math.max(2, durationSec) + 1;
  const line = words.filter((w) => w.start >= from && w.start <= to).slice(0, 40).map((w) => w.text.trim()).filter(Boolean).join(' ');
  return line || undefined;
}

async function pictureOf(c: AssetCandidate, dir: string, i: number): Promise<string | null> {
  const h = hub();
  if (c.source === 'pexels' || c.source === 'pexels-photo') {
    if (!c.thumbUrl) return null;
    const dest = path.join(dir, `thumb-${i + 1}.jpg`);
    try { await h.download(c.thumbUrl, dest); return dest; } catch { return null; }
  }
  const asset = findAsset(h.root, c.ref);
  const file = asset ? assetFilePath(h.root, asset) : null;
  if (!asset || !file) return null;
  const [frame] = await h.frames(file, [asset.kind === 'video' ? (asset.durationSec ?? 0) / 2 : 0], path.join(dir, `c${i + 1}`));
  return frame ?? null;
}

/**
 * Scores up to SCORE_BATCH candidates in one agent turn. Unscored candidates come back without `score`;
 * `error` says why nothing was scored (no agent, agent failed, unreadable answer).
 */
export async function scoreCandidates(candidates: AssetCandidate[], req: ScoreRequest): Promise<{ candidates: AssetCandidate[]; error?: string }> {
  const h = hub();
  const batch = candidates.slice(0, SCORE_BATCH);
  if (batch.length === 0) return { candidates: [] };
  if (!h.run) return { candidates: batch, error: 'chưa có agent để chấm cảnh (module video chưa chạy)' };

  fs.mkdirSync(libraryTmpDir(h.root), { recursive: true });
  const dir = fs.mkdtempSync(path.join(libraryTmpDir(h.root), 'score-'));
  try {
    const images: string[] = [];
    const imageOf: (number | null)[] = [];
    const seeing = h.seesImages(req.agentId);
    for (const [i, c] of batch.entries()) {
      const pic = seeing ? await pictureOf(c, dir, i) : null;
      if (pic) images.push(pic);
      imageOf.push(pic ? images.length : null);
    }
    const res = await h.run({
      agentId: req.agentId, title: `Chấm cảnh trám: ${req.description}`.slice(0, 120), timeoutMs: SCORE_TIMEOUT_MS,
      prompt: brollScorePrompt({ line: req.line, description: req.description, keywords: req.keywords, candidates: batch, imageOf }),
      ...(images.length ? { images } : {}),
    });
    if (!res.ok) return { candidates: batch, error: `agent chưa chấm được (${res.error ?? 'không rõ lỗi'})` };
    const scores = parseScores(res.output, batch.length);
    if (scores.size === 0) return { candidates: batch, error: 'câu trả lời chấm điểm không đúng dạng' };
    return {
      candidates: batch.map((c, i) => {
        const s = scores.get(i);
        return s ? { ...c, score: s.score, ...(s.reason ? { reason: s.reason } : {}) } : c;
      }),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
