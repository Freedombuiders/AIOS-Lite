// Director shortlist for Dựng nhanh: the owner's footage for this project (with their descriptions), library
// files whose captions share words with the transcript, music for the template's moods (or the owner's pick)
// and the template's SFX. The director chooses only among these real asset ids.
import { VIDEO_STYLES } from '../catalog/styles.js';
import { getLibrary, type LibraryAsset } from '../library/store.js';
import { getTemplate } from '../templates/registry.js';
import type { TemplateManifest } from '../templates/types.js';
import type { VideoProject } from '../types.js';
import { hub } from './hub.js';
import { enqueueIndex } from './indexer.js';
import { matchScore, terms } from './match.js';
import { isSticker, libraryCandidate, usableAsset } from './providers.js';
import type { AssetCandidate, AssetShortlist } from './types.js';

const LIBRARY_MAX = 8;
const MUSIC_MAX = 6;
const SFX_MAX = 12;
const DEFAULT_MOODS = ['Tập trung'];

function templateOf(templateId: string | undefined): TemplateManifest | null {
  if (!templateId) return null;
  try { return getTemplate(templateId); } catch { return null; }
}

/**
 * Music moods of a template: those of the VideoStyle it builds on (manifest `styleId`; a 'style:<id>' template
 * wraps that style). Without a known template or style, the project's style, else Tập trung.
 */
export function moodsFor(templateId: string | undefined, styleId?: string): string[] {
  const moodsOf = (id: string | undefined) => (id ? VIDEO_STYLES.find((s) => s.id === id)?.musicMoods : undefined);
  const moods = moodsOf(templateOf(templateId)?.styleId) ?? moodsOf(styleId);
  return moods?.length ? [...moods] : [...DEFAULT_MOODS];
}

/** SFX of a template: none when its density is 'none'; the ids its presets and sound rules name come first. */
function sfxFor(templateId: string | undefined, all: LibraryAsset[]): LibraryAsset[] {
  const t = templateOf(templateId);
  if (t?.sounds.density === 'none') return [];
  const named = [...(t?.animations ?? []).map((a) => a.sound), t?.sounds.transition, t?.sounds.click].filter((x): x is string => Boolean(x));
  const rank = (a: LibraryAsset) => { const i = named.indexOf(a.id); return i < 0 ? named.length : i; };
  return all.filter((a) => a.kind === 'sfx').sort((x, y) => rank(x) - rank(y));
}

const fmtSec = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

function musicCandidate(a: LibraryAsset): AssetCandidate {
  const facts = [a.mood, a.genre, a.bpm ? `${Math.round(a.bpm)} BPM` : '', a.vocals === true ? 'có lời' : a.vocals === false ? 'không lời' : ''].filter(Boolean);
  const about = a.caption || a.description || '';
  return { ...libraryCandidate(a, 'mine'), caption: [`"${a.name}"`, facts.join(', '), about].filter(Boolean).join(' · ') };
}

function emptyShortlist(): AssetShortlist {
  return { projectAssets: [], library: [], music: [], sfx: [] };
}

export async function buildShortlist(projectId: string): Promise<AssetShortlist> {
  const h = hub();
  let project: VideoProject | null = null;
  let words = '';
  try {
    project = h.store.loadProject(projectId);
    words = h.store.readTranscript(projectId)?.words.map((w) => w.text).join(' ') ?? '';
  } catch { /* unknown id */ }
  if (!project) return emptyShortlist();

  const quick = project.quick;
  const usable = getLibrary(h.root).filter(usableAsset);
  const byId = new Map(usable.map((a) => [a.id, a]));

  const projectAssets: AssetShortlist['projectAssets'] = [];
  for (const { assetId, hint } of quick?.assets ?? []) {
    const a = byId.get(assetId);
    if (!a || (a.kind !== 'video' && a.kind !== 'image')) continue;
    projectAssets.push({ assetId, kind: a.kind, ...(hint ? { hint } : {}), ...(a.caption ? { caption: a.caption } : {}) });
  }

  const attached = new Set(projectAssets.map((p) => p.assetId));
  const spoken = terms(words);
  const library = words
    ? usable
      .filter((a) => (a.kind === 'video' || a.kind === 'image') && !attached.has(a.id) && !isSticker(a))
      .map((a) => ({ a, score: matchScore(spoken, terms([a.caption, a.name, a.description, ...(a.tags ?? [])].filter(Boolean).join(' '))) }))
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score || (y.a.quality ?? 0.5) - (x.a.quality ?? 0.5))
      .slice(0, LIBRARY_MAX)
      .map((x) => libraryCandidate(x.a, 'mine'))
    : [];

  const mode = quick?.music.mode ?? 'ai';
  let tracks: LibraryAsset[] = [];
  if (mode === 'pick') {
    const picked = quick?.music.assetId ? byId.get(quick.music.assetId) : undefined;
    tracks = picked?.kind === 'bgm' ? [picked] : [];
  } else if (mode === 'ai') {
    const moods = moodsFor(quick?.templateId, project.styleId);
    const rank = (a: LibraryAsset) => { const i = moods.indexOf(a.mood ?? ''); return i < 0 ? moods.length : i; };
    tracks = usable
      .filter((a) => a.kind === 'bgm')
      .sort((x, y) => rank(x) - rank(y) || (y.quality ?? 0.5) - (x.quality ?? 0.5) || x.name.localeCompare(y.name, 'vi'))
      .slice(0, MUSIC_MAX);
  }

  const sfx = sfxFor(quick?.templateId, usable)
    .slice(0, SFX_MAX)
    .map((a) => ({ ...libraryCandidate(a, 'mine'), caption: [a.name, a.caption || a.description].filter(Boolean).join(': ') }));

  // Footage without a caption and music without beats get indexed in the background for the next turn.
  enqueueIndex([
    ...projectAssets.filter((p) => !p.caption).map((p) => p.assetId),
    ...tracks.filter((t) => !t.beats?.length).map((t) => t.id),
  ]);

  return { projectAssets, library, music: tracks.map(musicCandidate), sfx };
}

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function row(c: AssetCandidate): string {
  const kind = c.kind === 'video' ? `video${c.durationSec ? ` ${Math.round(c.durationSec)}s` : ''}` : c.kind === 'image' ? 'ảnh' : c.durationSec && c.kind === 'bgm' ? fmtSec(c.durationSec) : '';
  const lic = c.license.attributionRequired ? ` · ghi công: ${c.license.creator ?? c.license.name}` : '';
  return `- \`${c.ref}\`${kind ? ` · ${kind}` : ''} · ${clip(c.caption)}${lic}`;
}

/** The shortlist as a Vietnamese prompt section; empty when there is nothing to offer. */
export function renderShortlistForPrompt(s: AssetShortlist): string {
  if (!s.projectAssets.length && !s.library.length && !s.music.length && !s.sfx.length) return '';
  const out = ['## Tư liệu, kho và nhạc', 'Chỉ dùng assetId có trong các danh sách dưới đây; không tự đặt mã.'];
  if (s.projectAssets.length) {
    out.push('', 'Tư liệu chủ kênh gửi cho video này (ưu tiên dùng, đặt đúng chỗ lời nói khớp mô tả):');
    for (const p of s.projectAssets) {
      const said = [p.hint ? `chủ kênh mô tả: "${clip(p.hint)}"` : '', p.caption ? `máy xem: "${clip(p.caption)}"` : ''].filter(Boolean).join(' · ');
      out.push(`- \`${p.assetId}\` · ${p.kind === 'video' ? 'video' : 'ảnh'}${said ? ` · ${said}` : ''}`);
    }
  }
  if (s.library.length) out.push('', 'Kho của tôi (hợp với lời nói):', ...s.library.map(row));
  if (s.music.length) out.push('', 'Nhạc nền (chọn một bài cho music.assetId):', ...s.music.map(row));
  if (s.sfx.length) out.push('', 'Tiếng động:', ...s.sfx.map(row));
  out.push('', 'Cảnh trám chưa có ở trên: để trống assetId và ghi `query` gồm `description` (mô tả đầy đủ cảnh cần có, tiếng Việt) và `keywords` (2–4 từ khoá tiếng Anh ngắn để tìm); máy sẽ tìm, chấm theo câu đang nói và tải về.');
  return out.join('\n');
}
