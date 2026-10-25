// Fills assetId for the B-roll slots the director described with a `query` but no file. Sources are searched
// in order (project footage → Kho của tôi → Pexels videos → Pexels photos); the agent scores each source's
// candidates 1–5 against the line being spoken; the first source with a candidate at 3 or more wins (best
// score, never the shot of the neighbouring slot, unused shots first) and a stock pick is downloaded into the
// library with its licence. A slot nothing fits is dropped with the reason in `notes`; the owner's own slots
// stay. Design after OpenMontage's asset selection (idea only): describe fully to score, few words to search.
import { findAsset } from '../library/store.js';
import type { BrollItem, EditPlan, Transcript, VideoProject } from '../types.js';
import { fetchCandidate } from './fetch.js';
import { hub } from './hub.js';
import { SOURCE_ORDER, searchSource } from './providers.js';
import { scoreCandidates, spokenLine } from './score.js';
import type { AssetCandidate, AssetSource } from './types.js';

export const MIN_SCORE = 3;
const PER_SOURCE = 6;

const BROLL_SOURCE: Record<AssetSource, BrollItem['source']> = { project: 'upload', mine: 'library', pexels: 'pexels', 'pexels-photo': 'pexels' };

/** One key per shot: a Pexels page id (also for a library file downloaded from it), else the library id. */
export function shotKey(ref: string): string {
  if (ref.startsWith('pexels:')) return ref;
  const url = findAsset(hub().root, ref)?.sourceUrl ?? '';
  const m = /pexels\.com\/(video|photo)\/(?:[^/]*?-)?(\d+)\/?$/.exec(url);
  return m ? `pexels:${m[1]}:${m[2]}` : ref;
}

const needsShot = (b: BrollItem) => b.enabled !== false && Boolean(b.query) && !b.assetId;

function credit(c: AssetCandidate): string {
  return [c.license.name, c.license.creator].filter(Boolean).join(', ');
}

export async function resolveBrolls(projectId: string, plan: EditPlan): Promise<{ plan: EditPlan; notes: string[] }> {
  if (!plan.brolls.some(needsShot)) return { plan, notes: [] };
  const h = hub();
  let project: VideoProject | null = null;
  let transcript: Transcript | null = null;
  try { project = h.store.loadProject(projectId); transcript = h.store.readTranscript(projectId); } catch { /* unknown id */ }
  if (!project) return { plan, notes: ['Không tìm thấy việc dựng để tìm cảnh trám.'] };

  const sources = project.quick?.stock === false ? SOURCE_ORDER.filter((s) => s === 'project' || s === 'mine') : SOURCE_ORDER;
  const agentId = project.agentId || h.defaultAgentId();
  const brolls = plan.brolls.map((b) => ({ ...b }));
  const order = brolls.map((_, i) => i).sort((a, b) => brolls[a].anchorWord - brolls[b].anchorWord || a - b);
  const dropped = new Set<number>();
  const used = new Set(brolls.filter((b) => b.assetId).map((b) => shotKey(b.assetId!)));
  const skipped = new Set<string>();
  const results: string[] = [];

  /** The shot shown just before or after slot order[k] (in time). */
  const neighbour = (k: number, step: -1 | 1): string | null => {
    for (let j = k + step; j >= 0 && j < order.length; j += step) {
      const b = brolls[order[j]];
      if (dropped.has(order[j]) || b.enabled === false) continue;
      return b.assetId ? shotKey(b.assetId) : null;
    }
    return null;
  };

  /** Sources in order; the first with a candidate at MIN_SCORE or more that downloads wins. */
  const pick = async (b: BrollItem, avoid: Set<string>): Promise<{ picked: AssetCandidate; assetId: string } | { why: string }> => {
    const query = b.query!;
    const line = spokenLine(transcript, b.anchorWord, b.duration);
    let why = 'không tìm thấy cảnh phù hợp';
    for (const source of sources) {
      const found = await searchSource(source, {
        keywords: query.keywords, description: query.description, aspect: project.aspect, projectId, minSec: b.duration * 0.8, limit: PER_SOURCE,
      });
      if (found.note) skipped.add(found.note);
      const fresh = found.candidates.filter((c) => !avoid.has(shotKey(c.ref)));
      if (fresh.length === 0) continue;
      const scored = await scoreCandidates(fresh, { agentId, line, description: query.description, keywords: query.keywords });
      if (scored.error) return { why: scored.error };
      const keep = scored.candidates
        .filter((c) => (c.score ?? 0) >= MIN_SCORE)
        .sort((x, y) => y.score! - x.score! || Number(used.has(shotKey(x.ref))) - Number(used.has(shotKey(y.ref))));
      if (keep.length === 0) { why = `không cảnh nào đạt ${MIN_SCORE}/5`; continue; }
      for (const c of keep) {
        try {
          const { asset } = await fetchCandidate(c.ref, { keywords: query.keywords });
          return { picked: c, assetId: asset.id };
        } catch (err) {
          skipped.add((err as Error).message);
        }
      }
    }
    return { why };
  };

  for (let k = 0; k < order.length; k++) {
    const b = brolls[order[k]];
    if (!needsShot(b)) continue;
    const r = await pick(b, new Set([neighbour(k, -1), neighbour(k, 1)].filter((x): x is string => Boolean(x))));
    if ('picked' in r) {
      b.assetId = r.assetId;
      b.source = BROLL_SOURCE[r.picked.source];
      used.add(shotKey(r.picked.ref));
      results.push(`Cảnh trám "${b.title}": ${r.picked.caption.slice(0, 120)} (${r.picked.score}/5; ${credit(r.picked)}).`);
      continue;
    }
    if (b.origin === 'owner') results.push(`Chưa có cảnh cho chỗ trám "${b.title}" bạn thêm: ${r.why}.`);
    else { dropped.add(order[k]); results.push(`Bỏ chỗ trám "${b.title}": ${r.why}.`); }
  }

  return { plan: { ...plan, brolls: brolls.filter((_, i) => !dropped.has(i)) }, notes: [...skipped, ...results] };
}
