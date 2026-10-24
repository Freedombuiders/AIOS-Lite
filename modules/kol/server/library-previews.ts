/**
 * Catalog photos for the attribute library, so every slot picker shows what an
 * outfit, expression, hairstyle, place, pose, look or effect looks like.
 *
 * A preview is for the owner's eyes only: it is stored in `preview_file` and
 * never attached to a generation (the item's own reference image `file` is).
 * Each kind has a house style, so a picker reads like one catalog: outfits on an
 * invisible mannequin, expressions/hair/poses on the same kind of studio model,
 * places with nobody in them, looks and effects applied to one fixed scene so
 * they can be compared side by side. Camera setups keep their drawn diagrams.
 *
 * A KOL can also get its own set (kol_persona_previews): every item drawn on the
 * persona itself through the Studio's compose pipeline (identity pack + item
 * reference image), then checked by the identity judge, so the pickers show
 * that KOL wearing the outfit, making the expression, in the hairstyle… The
 * own photo wins over the catalog model's wherever that KOL is in view.
 *
 * One in-process job at a time generates the missing previews with a chosen
 * image model, a few at once, checking the KOL Studio caps before every image
 * (ledger persona '_library'). ChatGPT previews count against the ChatGPT daily
 * limit like any other ChatGPT image.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { logger } from './compat.js';
import { judgeImageFile } from './consistency.js';
import { ensureKolDir, KolError, kolDb, kolPaths, loadSettings, nowSec } from './core.js';
import { ffmpegBin, runBin, tempPath } from './files.js';
import { chatgptImagesToday, claimChatgptTurn, downloadOutput, inputForRef, planGeneration, releaseChatgptTurn } from './generations.js';
import {
  libraryPreviewFiles, listLibrary, PERSON_KINDS, personaGender, personaPreviewFiles, setLibraryPreview, setPersonaPreview, type PreviewVariant,
} from './library.js';
import { getPersona } from './personas.js';
import { unitPriceUsd } from './pricing.js';
import { findModel, getAdapter, isProviderConfigured } from './providers/index.js';
import { ProviderError, providerErrorVi } from './providers/types.js';
import { admission, LIBRARY_SPEND_ID, recordSpend } from './spend.js';
import type { GenerationRequest, LibraryItemDto, LibraryKind, ModelInfo, PreviewJobDto, Selection } from './types.js';

/** Kinds that get a catalog photo, in drawing order (most-used first). Camera setups are drawn as diagrams instead. */
export const PREVIEW_KINDS: LibraryKind[] = ['outfit', 'scene', 'expression', 'pose', 'hair', 'look', 'effect'];

/**
 * Drawing order: a persona's own items first (they are what that KOL actually wears and where she goes),
 * then by kind in PREVIEW_KINDS order, then library order. Matters on slow, rationed models (ChatGPT's
 * daily limit spreads a full run over days).
 */
export function previewOrder<T extends Pick<LibraryItemDto, 'kind' | 'personaId' | 'sort'>>(items: T[], kinds: LibraryKind[] = PREVIEW_KINDS): T[] {
  const rank = (k: LibraryKind) => { const i = kinds.indexOf(k); return i < 0 ? kinds.length : i; };
  return [...items].sort((a, b) => Number(!a.personaId) - Number(!b.personaId) || rank(a.kind) - rank(b.kind) || a.sort - b.sort);
}

/** Every preview is a 4:5 portrait, the tile shape of the pickers. */
const PREVIEW_ASPECT = '4:5' as const;
/** Longest side kept on disk: sharp on a retina tile, about 80 KB. */
const PREVIEW_WIDTH = 640;
const CALL_TIMEOUT_MS = 5 * 60_000;
/** How long a ChatGPT lane waits before asking the shared pool again. */
const POOL_WAIT_MS = 4000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');

const FINISH = 'Photorealistic, high-end catalog photography with a refined, muted palette and crisp focus. '
  + 'One single photograph: no text, letters, captions, logos, watermark, frame, border, grid or collage.';

/**
 * The catalog models for kinds that need a person: the same description every time, so a picker
 * looks like one shoot. `bare` leaves the hair out (the hairstyle is the subject of hair photos).
 */
const MODELS: Record<'female' | 'male', { bare: string; full: string; expression: string; they: string; hairShot: string }> = {
  female: {
    bare: 'a young Vietnamese woman in her mid-twenties with natural makeup',
    full: 'a young Vietnamese woman in her mid-twenties with natural makeup',
    expression: 'a young Vietnamese woman in her mid-twenties with natural makeup, dark hair tied back',
    they: 'She wears',
    hairShot: 'A salon portfolio photo',
  },
  male: {
    bare: 'a young Vietnamese man in his early thirties, clean-shaven',
    full: 'a young Vietnamese man in his early thirties, clean-shaven, with short neat dark hair',
    expression: 'a young Vietnamese man in his early thirties, clean-shaven, with short neat dark hair',
    they: 'He wears',
    hairShot: 'A barbershop portfolio photo',
  },
};
const STUDIO = 'seamless warm light-grey studio backdrop, soft diffused key light with gentle fill';
const cap = (t: string): string => `${t[0].toUpperCase()}${t.slice(1)}`;

/**
 * English prompt for an item's catalog photo in one variant (the woman or the man model; outfits
 * and places have nobody in them), or null when the kind has none (camera).
 */
export function previewPrompt(item: Pick<LibraryItemDto, 'kind' | 'prompt'>, variant: PreviewVariant = 'female'): string | null {
  const p = clean(item.prompt);
  if (!p) return null;
  const m = MODELS[variant === 'male' ? 'male' : 'female'];
  const MODEL = m.full;
  switch (item.kind) {
    case 'outfit':
      return `A premium fashion e-commerce photo of this outfit on an invisible ghost mannequin, with no person, head, hands or skin visible: ${p}. `
        + 'The complete outfit is centred and fully in frame, including shoes, bag and accessories when described. '
        + `Seamless warm off-white backdrop with a soft floor shadow, softbox lighting, true colours and fabric texture. ${FINISH}`;
    case 'hair':
      return `${m.hairShot} of this hairstyle: ${p}. ${cap(m.bare)}, head and shoulders from a three-quarter angle, `
        + `face turned slightly away so the hairstyle is the hero, plain cream top; ${STUDIO}; every strand sharp. ${FINISH}`;
    case 'expression':
      return `A close-up ${variant === 'male' ? '' : 'beauty '}portrait of ${m.expression}, plain white crew-neck t-shirt, showing exactly this expression or gesture: ${p}. `
        + `Head and shoulders facing the camera (hands in frame when the gesture uses them); ${STUDIO}. ${FINISH}`;
    case 'pose':
      return `A full-body studio photo of ${MODEL} demonstrating this pose: ${p}. ${m.they} a fitted plain charcoal long-sleeve top, charcoal trousers and white sneakers `
        + 'so the body line reads clearly; the whole body is in frame with room around it; only the simplest neutral prop (stool, bench, wall, phone) when the pose needs one; '
        + `${STUDIO}. ${FINISH}`;
    case 'scene':
      return `An editorial location photo of this place with nobody in it: ${p}. Eye level, 35mm lens, natural light true to the setting, `
        + `an inviting atmosphere and depth, travel-magazine quality. ${FINISH}`;
    case 'look':
      return `A lifestyle portrait of ${MODEL} in a cream knit sweater, seated at a café window with a cup of coffee, medium shot, `
        + `rendered in this exact look and colour grade: ${p}. The grade is the point of the picture: keep it strong and unmistakable. ${FINISH.replace('a refined, muted palette and ', '')}`;
    case 'effect':
      return `A lifestyle portrait of ${MODEL} in a camel coat walking along a city street in the early evening, medium shot, `
        + `with this effect clearly visible: ${p}. ${FINISH.replace('a refined, muted palette and ', '')}`;
    default:
      return null;
  }
}

// ── A KOL's own photos ───────────────────────────────────────────────

/** Kinds a KOL's own set covers, in drawing order: what the persona wears first, places last. */
export const PERSONA_PREVIEW_KINDS: LibraryKind[] = ['outfit', 'hair', 'expression', 'pose', 'look', 'effect', 'scene'];

const SLOT_OF: Partial<Record<LibraryKind, keyof Selection>> = {
  outfit: 'outfitId', hair: 'hairId', expression: 'expressionId', pose: 'poseId', look: 'lookId', effect: 'effectId', scene: 'sceneId',
};

/**
 * Catalog framing for a KOL's own photo of a kind, added to the Studio prompt as extra direction:
 * the same house style as the shared catalog, so a picker still compares like with like.
 */
const PERSONA_FRAMING: Partial<Record<LibraryKind, string>> = {
  outfit: 'Catalog photo for an outfit picker: full-body fashion lookbook shot, standing in a relaxed natural pose facing the camera, the whole outfit in frame from head to shoes, '
    + 'seamless warm light-grey studio backdrop, soft even light, true colours and fabric texture. The outfit is the hero.',
  hair: 'Catalog photo for a hairstyle picker: head-and-shoulders portrait from a slight three-quarter angle so the hairstyle reads clearly, plain cream crew-neck top, '
    + 'seamless warm light-grey studio backdrop, soft diffused light; every strand sharp. The hairstyle is the hero.',
  expression: 'Catalog photo for an expression picker: close-up head-and-shoulders portrait facing the camera (hands in frame when the gesture uses them), plain white crew-neck t-shirt, '
    + 'seamless warm light-grey studio backdrop, soft diffused light. The expression is the hero.',
  pose: 'Catalog photo for a pose picker: full-body studio photo demonstrating the pose, fitted plain charcoal long-sleeve top, charcoal trousers and white sneakers so the body line reads clearly, '
    + 'the whole body in frame with room around it, only the simplest neutral prop when the pose needs one, seamless warm light-grey studio backdrop.',
  look: 'Catalog photo for a look picker: seated at a café window with a cup of coffee, cream knit sweater, medium shot; the look and colour grade is strong and unmistakable.',
  effect: 'Catalog photo for an effect picker: walking along a city street in the early evening, camel coat, medium shot, with the effect clearly visible.',
  scene: 'Catalog photo for a location picker: a wide shot where the place is the hero and fills the frame, the person full-body and naturally part of it (not a close-up), '
    + 'natural light true to the setting, travel-magazine quality.',
};

/**
 * Added to every KOL photo: a clean catalog setup tempts models into a glossy, CGI-like finish,
 * and these photos must read as a real person on a real camera.
 */
const PERSONA_REALISM = 'It must look like an untouched RAW photograph of a real human taken on a real full-frame camera with a 50–85 mm lens, never like AI art, CGI or a beauty-filtered image: '
  + 'real skin with visible pores, fine peach fuzz, slightly uneven skin tone and a few tiny natural blemishes, natural under-eye texture, slight facial asymmetry; '
  + 'individual hair strands with some frizz and flyaways; natural fabric creases; true-to-life colours, soft natural contrast and a trace of real camera noise. '
  + 'No skin smoothing, no beauty filter, no glow or bloom, no airbrushed or porcelain skin, no glossy plastic sheen, no doll-like or perfectly symmetric face, no over-sharpened HDR look.';

/**
 * The lowest identity score a KOL photo is kept at, whatever the persona's own threshold: these
 * photos stand for the KOL in every picker, so they must be unmistakably that person.
 */
export const PERSONA_MIN_SCORE = 90;

/**
 * The default lowest "looks like a real photo" score a KOL photo is kept at: the owner wants these
 * to read as real people, not AI renders. Only applied when the judge returns a realism score.
 */
export const PERSONA_MIN_REALISM = 80;

/**
 * Per-KOL realism floors (kol_settings 'personaRealismFloor': { personaId: number }). A render that
 * keeps a face cannot look more real than that face's own source photos: Genie's originals score
 * 74–82 on the judge, Tony's real photos 83–91, so each KOL gets a floor just under its originals.
 */
export function personaRealismFloor(personaId: string): number {
  try {
    const row = kolDb().prepare("SELECT value FROM kol_settings WHERE key = 'personaRealismFloor'").get() as { value: string } | undefined;
    const n = Number((row ? JSON.parse(row.value) as Record<string, unknown> : {})[personaId]);
    return Number.isFinite(n) && n > 0 && n <= 100 ? n : PERSONA_MIN_REALISM;
  } catch {
    return PERSONA_MIN_REALISM;
  }
}

/**
 * Does a judge verdict keep a KOL photo: same person (≥ PERSONA_MIN_SCORE) and real-looking.
 * An unjudged photo ('skipped': the judge failed or declined) is never kept: it is redrawn.
 */
export function keepsPersonaPhoto(v: { verdict: string | null; score: number | null; realism?: number | null }, minRealism = PERSONA_MIN_REALISM): boolean {
  if (v.verdict !== 'pass' || (v.score ?? 0) < PERSONA_MIN_SCORE) return false;
  return v.realism == null || v.realism >= minRealism;
}

/** The Studio request that draws a KOL's own photo of an item (one image, 4:5 when the model allows it). */
export function personaPreviewRequest(personaId: string, item: Pick<LibraryItemDto, 'id' | 'kind'>, model: ModelInfo): GenerationRequest | null {
  const slot = SLOT_OF[item.kind];
  if (!slot) return null;
  return {
    personaId,
    mode: 'compose',
    selection: { [slot]: item.id },
    params: {
      model: model.id, quality: 'standard', count: 1,
      ...(model.aspects.length === 0 || model.aspects.includes(PREVIEW_ASPECT) ? { aspect: PREVIEW_ASPECT } : {}),
      extraPrompt: `${PERSONA_FRAMING[item.kind]} ${PERSONA_REALISM}`,
    },
  };
}

/** Draws per item before giving up on a KOL photo the judge does not pass. */
const PERSONA_DRAWS = 3;
/** Extra judge attempts when the judge gives no verdict, and the base wait between them. */
const JUDGE_RETRIES = 2;
let JUDGE_RETRY_MS = 15_000;
/** Tests: no waiting between retries. */
export function _setPersonaRetryDelayForTests(ms: number): void { JUDGE_RETRY_MS = ms; }
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Does an item belong in a KOL's own set: its own items, and the shared ones for its gender or everyone. */
function fitsPersona(item: Pick<LibraryItemDto, 'kind' | 'gender' | 'personaId'>, personaId: string, gender: 'female' | 'male' | null): boolean {
  if (!PERSONA_PREVIEW_KINDS.includes(item.kind)) return false;
  if (item.personaId) return item.personaId === personaId;
  return item.gender === 'all' || !gender || item.gender === gender;
}

// ── Job state ────────────────────────────────────────────────────────

interface Job {
  running: boolean;
  model: string | null;
  /** The KOL whose own photos the run draws, or null for the shared catalog. */
  personaId: string | null;
  total: number;
  done: number;
  failed: number;
  costUsd: number;
  startedAt: number | null;
  finishedAt: number | null;
  stopReason: string;
  errors: { name: string; error: string }[];
  stop: boolean;
}

const job: Job = { running: false, model: null, personaId: null, total: 0, done: 0, failed: 0, costUsd: 0, startedAt: null, finishedAt: null, stopReason: '', errors: [], stop: false };
let current: Promise<void> | null = null;

/** Every library item of the preview kinds (shared and every persona's own). */
function allItems(): LibraryItemDto[] {
  const shared = listLibrary();
  const own = (kolDb().prepare('SELECT DISTINCT persona_id AS id FROM kol_library WHERE persona_id IS NOT NULL').all() as { id: string }[])
    .flatMap((p) => listLibrary({ personaId: p.id }).filter((i) => i.personaId === p.id));
  return [...shared, ...own].filter((i) => PREVIEW_KINDS.includes(i.kind));
}

/**
 * The versions an item needs: nobody for outfits and places; for people, a persona's own items in
 * that persona's gender, gender-specific items in their gender, items for everyone in both.
 */
export function requiredVariants(item: Pick<LibraryItemDto, 'kind' | 'gender' | 'personaId'>, ownerGender: 'female' | 'male' | null): PreviewVariant[] {
  if (!PREVIEW_KINDS.includes(item.kind)) return [];
  if (!PERSON_KINDS.includes(item.kind)) return ['none'];
  if (item.personaId) return [ownerGender ?? 'female'];
  if (item.gender === 'female' || item.gender === 'male') return [item.gender];
  return ['female', 'male'];
}

/** One photo to draw: a catalog variant, or (with personaId) that KOL's own photo. */
interface Task { item: LibraryItemDto; variant: PreviewVariant; personaId?: string }
/** An item, the versions it needs and the ones it has. An owner's reference image stands in for all of them. */
interface Entry { item: LibraryItemDto; need: PreviewVariant[]; have: Set<PreviewVariant>; gaveUp?: boolean }

function catalog(): Entry[] {
  const files = libraryPreviewFiles();
  const owners = new Map<string, 'female' | 'male' | null>();
  const ownerGender = (id: string) => (owners.has(id) ? owners.get(id)! : (owners.set(id, personaGender(id)), owners.get(id)!));
  return allItems().map((item) => ({
    item,
    need: item.imageUrl ? [] : requiredVariants(item, item.personaId ? ownerGender(item.personaId) : null),
    have: new Set(files.get(item.id)?.keys() ?? []),
  }));
}

/** A KOL's own set: every item that fits it, and whether it has its photo yet. */
function personaCatalog(personaId: string): Entry[] {
  const gender = personaGender(personaId);
  const own = personaPreviewFiles(personaId);
  const misses = personaMisses(personaId);
  return listLibrary({ personaId })
    .filter((item) => fitsPersona(item, personaId, gender))
    .map((item) => ({
      item, need: ['none'], have: new Set<PreviewVariant>(own.has(item.id) ? ['none'] : []),
      gaveUp: !own.has(item.id) && (misses.get(item.id)?.attempts ?? 0) >= MISS_LIMIT,
    }));
}

// ── Items a KOL's photo keeps failing for ────────────────────────────
// Some items never pass on a model (ChatGPT drops revealing outfits; a pose may always drift).
// After MISS_LIMIT failed runs, automatic runs leave them alone so they do not burn the daily
// quota night after night; the owner can still draw them on purpose.

/** Failed runs after which automatic runs skip an item for a KOL. */
export const MISS_LIMIT = 2;

function personaMisses(personaId: string): Map<string, { attempts: number; error: string }> {
  const rows = kolDb().prepare('SELECT item_id, attempts, error FROM kol_persona_preview_misses WHERE persona_id = ?').all(personaId) as { item_id: string; attempts: number; error: string }[];
  return new Map(rows.map((r) => [r.item_id, { attempts: r.attempts, error: r.error }]));
}

function recordMiss(personaId: string, itemId: string, error: string): void {
  kolDb().prepare(
    `INSERT INTO kol_persona_preview_misses (persona_id, item_id, attempts, error, updated_at) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(persona_id, item_id) DO UPDATE SET attempts = attempts + 1, error = excluded.error, updated_at = excluded.updated_at`,
  ).run(personaId, itemId, error.slice(0, 200), nowSec());
}

function clearMiss(personaId: string, itemId: string): void {
  kolDb().prepare('DELETE FROM kol_persona_preview_misses WHERE persona_id = ? AND item_id = ?').run(personaId, itemId);
}

const entriesFor = (personaId: string | null | undefined): Entry[] => (personaId ? personaCatalog(personaId) : catalog());

const missingOf = (e: Entry): PreviewVariant[] => e.need.filter((v) => !e.have.has(v));
const covered = (e: Entry): boolean => !!e.item.imageUrl || missingOf(e).length === 0;
const missingCount = (entries: Entry[]): number => entries.reduce((n, e) => n + missingOf(e).length, 0);
/** What an automatic run still has to draw: items given up on are left alone. */
const autoMissingCount = (entries: Entry[]): number => missingCount(entries.filter((e) => !e.gaveUp));

function coverage(entries: Entry[], persona: boolean): PreviewJobDto['coverage'] {
  const out: PreviewJobDto['coverage'] = {};
  for (const k of persona ? PERSONA_PREVIEW_KINDS : PREVIEW_KINDS) out[k] = { withPreview: 0, total: 0 };
  for (const e of entries) {
    out[e.item.kind].total += 1;
    // A KOL's set needs the KOL's own photo: an uploaded reference image does not stand in for it.
    if (persona ? missingOf(e).length === 0 : covered(e)) out[e.item.kind].withPreview += 1;
  }
  return out;
}

/** Tasks in drawing order: previewOrder for the items, the woman/nobody version before the man's. */
function orderTasks(tasks: Task[], kinds: LibraryKind[] = PREVIEW_KINDS): Task[] {
  const rank = new Map(previewOrder(tasks.map((t) => t.item), kinds).map((it, i) => [it, i]));
  const vRank: Record<PreviewVariant, number> = { none: 0, female: 1, male: 2 };
  return [...tasks].sort((a, b) => rank.get(a.item)! - rank.get(b.item)! || vRank[a.variant] - vRank[b.variant]);
}

const previewPrice = (m: ModelInfo): number | null => {
  if (m.provider === 'chatgpt') return 0;
  return unitPriceUsd(m.id, { quality: 'standard' }, loadSettings().priceOverrides)?.usd ?? null;
};

export function previewJobStatus(modelId?: string, personaId?: string): PreviewJobDto {
  const entries = entriesFor(personaId);
  let estimate: PreviewJobDto['estimate'] = null;
  if (modelId) {
    const m = findModel(modelId);
    const count = missingCount(entries);
    const unit = m ? previewPrice(m) : null;
    estimate = { model: modelId, count, usd: unit === null ? null : Math.round(unit * count * 1e4) / 1e4 };
  }
  const plan = readAutoPlan();
  return {
    running: job.running, model: job.model, total: job.total, done: job.done, failed: job.failed, costUsd: job.costUsd,
    startedAt: job.startedAt, finishedAt: job.finishedAt, stopReason: job.stopReason, errors: [...job.errors],
    coverage: coverage(entries, !!personaId), estimate,
    auto: plan ? { ...plan, reserve: CHATGPT_RESERVE } : null,
    personaId: personaId ?? null, runPersonaId: job.personaId,
    gaveUp: personaId ? gaveUpList(personaId, entries) : [],
  };
}

function gaveUpList(personaId: string, entries: Entry[]): PreviewJobDto['gaveUp'] {
  const misses = personaMisses(personaId);
  return entries.filter((e) => e.gaveUp).map((e) => ({ id: e.item.id, name: e.item.name, error: misses.get(e.item.id)?.error ?? '' }));
}

const startSchema = z.object({
  model: z.string({ message: 'Chọn mô hình ảnh.' }).min(1, 'Chọn mô hình ảnh.'),
  /** Draw this KOL's own photos instead of the shared catalog's. */
  personaId: z.string().min(1).max(100).optional(),
  kinds: z.array(z.enum(PREVIEW_KINDS as [LibraryKind, ...LibraryKind[]])).optional(),
  ids: z.array(z.string().max(100)).max(500).optional(),
  /** Redraw items that already have a catalog photo. */
  force: z.boolean().optional(),
  /** A KOL's run leaves alone the items that failed MISS_LIMIT times (automatic runs always do). */
  skipGivenUp: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

/** Starts the preview job in the background. Throws 400/409/412 before anything is spent. */
export function startPreviewJob(input: unknown, requestedBy = 'owner'): PreviewJobDto {
  const r = startSchema.safeParse(input ?? {});
  if (!r.success) throw new KolError(400, r.error.issues[0]?.message ?? 'Dữ liệu không hợp lệ.');
  const v = r.data;
  if (job.running) throw new KolError(409, 'Đang tạo ảnh minh hoạ. Chờ xong hoặc dừng lượt hiện tại.', 'busy');
  const model = findModel(v.model);
  if (!model || model.kind !== 'image') throw new KolError(400, 'Mô hình này không tạo ảnh.');
  if (!isProviderConfigured(model.provider)) throw new KolError(412, `${model.provider} chưa có API key.`, 'not_configured');
  if (previewPrice(model) === null) throw new KolError(412, 'Chưa có giá cho mô hình này. Nhập giá ở KOL Studio › Cài đặt › Giá ghi đè.', 'no_price');

  const personaId = v.personaId ?? null;
  if (personaId) assertPersonaReady(personaId);

  let entries = entriesFor(personaId);
  if (v.kinds?.length) entries = entries.filter((e) => v.kinds!.includes(e.item.kind));
  if (v.ids?.length) { const want = new Set(v.ids); entries = entries.filter((e) => want.has(e.item.id)); }
  // Automatic runs leave alone the items that failed MISS_LIMIT times; the owner's runs try them again.
  if (personaId && (requestedBy === 'auto' || v.skipGivenUp)) entries = entries.filter((e) => !e.gaveUp);
  let tasks = personaId
    ? orderTasks(entries.filter((e) => v.force || missingOf(e).length > 0).map((e) => ({ item: e.item, variant: 'none' as const, personaId })), PERSONA_PREVIEW_KINDS)
    : orderTasks(entries.flatMap((e) => (v.force ? e.need : missingOf(e))
      .filter((variant) => previewPrompt(e.item, variant) !== null)
      .map((variant) => ({ item: e.item, variant }))));
  if (v.limit) tasks = tasks.slice(0, v.limit);
  if (tasks.length === 0) throw new KolError(400, 'Không còn mục nào thiếu ảnh minh hoạ.', 'nothing_to_do');
  // Fail fast on a switched-off studio, an exhausted cap or ChatGPT's daily limit, before the first call.
  const blocked = blockedReason(model, 0);
  if (blocked) throw new KolError(409, blocked, 'blocked');

  Object.assign(job, {
    running: true, model: model.id, personaId, total: tasks.length, done: 0, failed: 0, costUsd: 0,
    startedAt: nowSec(), finishedAt: null, stopReason: '', errors: [], stop: false,
  });
  // An owner's run survives a server restart: the marker stays when the process dies mid-run.
  // Automatic runs are not marked: the scheduler starts them again with a fresh budget anyway.
  if (requestedBy !== 'auto') writeRunMarker({ model: model.id, personaId: personaId ?? undefined, kinds: v.kinds, ids: v.ids, skipGivenUp: v.skipGivenUp, requestedBy });
  current = runJob(tasks, model, requestedBy).catch((err) => {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'KOL: library preview job crashed');
    job.stopReason = 'Lỗi không mong muốn, đã dừng.';
  }).finally(() => {
    job.running = false;
    job.finishedAt = nowSec();
    current = null;
    clearRunMarker();
  });
  return previewJobStatus(undefined, personaId ?? undefined);
}

// ── Resume after a restart ───────────────────────────────────────────

const RUN_KEY = 'previewRun';
interface RunMarker { model: string; personaId?: string; kinds?: LibraryKind[]; ids?: string[]; skipGivenUp?: boolean; requestedBy: string }

function writeRunMarker(m: RunMarker): void {
  kolDb().prepare('INSERT INTO kol_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(RUN_KEY, JSON.stringify(m));
}

function clearRunMarker(): void {
  kolDb().prepare('DELETE FROM kol_settings WHERE key = ?').run(RUN_KEY);
}

/**
 * Continues an owner's run that a server restart cut short: the missing photos only (a redraw is
 * not repeated), within the limits of now. Returns true when it started one.
 */
export function resumeInterruptedRun(): boolean {
  const row = kolDb().prepare('SELECT value FROM kol_settings WHERE key = ?').get(RUN_KEY) as { value: string } | undefined;
  if (!row || job.running) return false;
  let marker: RunMarker;
  try { marker = JSON.parse(row.value) as RunMarker; } catch { clearRunMarker(); return false; }
  try {
    startPreviewJob({ model: marker.model, personaId: marker.personaId, kinds: marker.kinds, ids: marker.ids, skipGivenUp: marker.skipGivenUp }, marker.requestedBy || 'owner');
    logger.info({ model: marker.model }, 'KOL: library preview run resumed after a restart');
    return true;
  } catch (err) {
    clearRunMarker();
    logger.info({ err: err instanceof Error ? err.message : String(err) }, 'KOL: interrupted library preview run not resumed');
    return false;
  }
}

/** Asks the job to stop after the images already in flight. */
export function stopPreviewJob(): PreviewJobDto {
  if (job.running) { job.stop = true; job.stopReason = 'Bạn đã dừng.'; }
  return previewJobStatus(undefined, job.personaId ?? undefined);
}

/** For tests: wait for the running job. */
export async function _awaitPreviewJob(): Promise<void> {
  await current;
}

/**
 * Why the next image may not start (cap, ChatGPT daily limit, kill switch), or null.
 * `inFlight` images are already running and not yet in the ledger: they count too.
 */
function blockedReason(model: ModelInfo, inFlight: number): string | null {
  try {
    admission(LIBRARY_SPEND_ID, (previewPrice(model) ?? 0) * (inFlight + 1));
  } catch (err) {
    return err instanceof KolError ? err.message : String(err);
  }
  if (model.provider === 'chatgpt') {
    const limit = loadSettings().chatgptDailyLimit;
    if (limit > 0 && chatgptImagesToday() + inFlight >= limit) return `Đã dùng hết ${limit} ảnh ChatGPT hôm nay (gồm cả ảnh minh hoạ). Chạy tiếp vào ngày mai hoặc chọn mô hình khác.`;
  }
  return null;
}

async function runJob(items: Task[], model: ModelInfo, requestedBy: string): Promise<void> {
  const settings = loadSettings();
  // ChatGPT lanes take turns from the Studio's pool (claimChatgptTurn), so they can use all of it.
  const lanes = model.provider === 'chatgpt' ? Math.max(1, settings.chatgptParallel) : Math.max(1, Math.min(3, settings.concurrency + 1));
  let next = 0;
  let inFlight = 0;
  const worker = async () => {
    while (!job.stop && next < items.length) {
      const reason = blockedReason(model, inFlight);
      if (reason) { job.stop = true; job.stopReason = reason; break; }
      // ChatGPT turns come from the pool the Studio uses; the owner's own images go first.
      if (model.provider === 'chatgpt' && !claimChatgptTurn()) { await sleep(POOL_WAIT_MS); continue; }
      const task = items[next++];
      inFlight += 1;
      try {
        await renderOne(task, model, requestedBy, () => { inFlight -= 1; });
        job.done += 1;
        if (task.personaId) clearMiss(task.personaId, task.item.id);
      } catch (err) {
        job.failed += 1;
        const msg = err instanceof ProviderError ? providerErrorVi(err) : err instanceof Error ? err.message : String(err);
        // The item's own failure counts; a cap, the daily limit or a lost login says nothing about it.
        const notItsFault = (err instanceof KolError && err.status === 409) || (err instanceof ProviderError && (err.kind === 'auth' || err.kind === 'quota'));
        if (task.personaId && !notItsFault) recordMiss(task.personaId, task.item.id, msg);
        const name = `${task.item.name}${task.variant === 'male' && !task.personaId ? ' (nam)' : ''}`;
        job.errors = [...job.errors, { name, error: msg.slice(0, 200) }].slice(-6);
        logger.warn({ item: task.item.id, variant: task.variant, err: msg.slice(0, 300) }, 'KOL: library preview failed');
        // Auth or quota problems repeat for every item: stop instead of failing the rest one by one.
        if (err instanceof ProviderError && (err.kind === 'auth' || err.kind === 'quota')) { job.stop = true; job.stopReason = msg; }
      } finally {
        if (model.provider === 'chatgpt') releaseChatgptTurn();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, worker));
}

/** `onCharged` runs once the call is over (in the ledger or failed), so the in-flight reservation ends. */
async function renderOne(task: Task, model: ModelInfo, requestedBy: string, onCharged: () => void): Promise<void> {
  let charged = false;
  const settle = () => { if (!charged) { charged = true; onCharged(); } };
  try {
    await drawAndStore(task, model, requestedBy, settle);
  } finally {
    settle();
  }
}

async function drawAndStore(task: Task, model: ModelInfo, requestedBy: string, settle: () => void): Promise<void> {
  if (task.personaId) return drawPersonaPreview(task.personaId, task.item, model, requestedBy, settle);
  const { item, variant } = task;
  const prompt = previewPrompt(item, variant);
  if (!prompt) throw new KolError(400, 'Loại này không có ảnh minh hoạ.');
  const call = () => getAdapter(model.provider).generateImage({
    model, prompt, refs: [], aspect: PREVIEW_ASPECT, quality: 'standard', count: 1,
    idempotencyKey: `preview-${item.id}-${randomUUID().slice(0, 8)}`, signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  let res;
  try {
    res = await call();
  } catch (err) {
    // One retry for dropped connections (ChatGPT streams disconnect now and then).
    if (!(err instanceof ProviderError) || !['network', 'timeout', 'server', 'rate'].includes(err.kind)) throw err;
    res = await call();
  }
  const out = res.outputs[0];
  if (!out) throw new ProviderError('rejected', 'no image returned');

  const price = previewPrice(model) ?? 0;
  const reported = typeof res.reportedCostUsd === 'number' && Number.isFinite(res.reportedCostUsd);
  const cost = reported ? res.reportedCostUsd! : price;
  recordSpend({
    personaId: LIBRARY_SPEND_ID, generationId: null, provider: model.provider, model: model.id, kind: 'image',
    costUsd: cost, costStatus: reported ? 'reported' : 'estimated', requestedBy: `${requestedBy}:library-preview`.slice(0, 60),
  });
  job.costUsd = Math.round((job.costUsd + cost) * 1e6) / 1e6;
  settle();

  const d = await downloadOutput(out, 'image');
  const dir = ensureKolDir(kolPaths.libraryPreviews());
  const dest = await storePreviewImage(d.bytes, d.ext, path.join(dir, `${item.id}-${variant}-${randomUUID().slice(0, 8)}`));
  setLibraryPreview(item.id, variant, dest);
}

/**
 * Throws before anything is spent when a KOL cannot get its own photos: unknown, archived, or
 * without an identity anchor (the face would be anyone's).
 */
function assertPersonaReady(personaId: string): void {
  const persona = getPersona(personaId);
  if (!persona) throw new KolError(404, 'Không tìm thấy KOL.');
  if (persona.status === 'archived') throw new KolError(409, 'KOL này đã lưu trữ.');
  if (!persona.refs.some((r) => r.kind === 'anchor' || r.kind === 'angle')) {
    throw new KolError(400, 'KOL chưa có ảnh gốc (anchor): tải ảnh lên hoặc tạo ảnh gốc trước, để ảnh minh hoạ đúng khuôn mặt.', 'no_anchor');
  }
}

/** Converts a provider image to the stored 640-px JPEG under library/previews and returns its path. */
async function storePreviewImage(bytes: Buffer, ext: string, stem: string): Promise<string> {
  const src = tempPath(`.${ext}`);
  fs.writeFileSync(src, bytes, { mode: 0o600 });
  let dest = `${stem}.jpg`;
  try {
    const r = await runBin(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src, '-vf', `scale='min(${PREVIEW_WIDTH},iw)':-2`, '-q:v', '3', dest], 60_000);
    if (r.code !== 0 || !fs.existsSync(dest) || fs.statSync(dest).size === 0) {
      // No ffmpeg: keep the provider's file as it is.
      fs.rmSync(dest, { force: true });
      dest = `${stem}.${ext}`;
      fs.copyFileSync(src, dest);
    }
  } finally {
    fs.rmSync(src, { force: true });
  }
  return dest;
}

/**
 * One KOL photo of an item: the Studio's compose request (identity pack + the item's reference
 * image, catalog framing), then the identity judge. A photo that drifts or looks AI-made is drawn
 * again (PERSONA_DRAWS in all); when every draw fails the item keeps the catalog model's photo and the run reports it.
 */
async function drawPersonaPreview(personaId: string, item: LibraryItemDto, model: ModelInfo, requestedBy: string, settle: () => void): Promise<void> {
  const req = personaPreviewRequest(personaId, item, model);
  if (!req) throw new KolError(400, 'Loại này không có ảnh minh hoạ.');
  const plan = planGeneration(req);
  // The daily ChatGPT limit is the job's own check (it counts the photos in flight).
  const problem = plan.problems.find((p) => p.code !== 'chatgpt_daily_limit');
  if (problem) throw problem;
  const refs = plan.composed.refs.map((r) => inputForRef(r, plan.persona.name));
  const dir = ensureKolDir(kolPaths.libraryPreviews());
  const price = previewPrice(model) ?? 0;
  const minRealism = personaRealismFloor(personaId);
  let lastNote = '';
  for (let attempt = 1; attempt <= PERSONA_DRAWS; attempt++) {
    if (attempt > 1) {
      // The redraw is one more image: it must fit the caps and ChatGPT's daily limit too.
      const blocked = blockedReason(model, 0);
      if (blocked) throw new KolError(409, `${lastNote} ${blocked}`.trim());
    }
    const call = () => getAdapter(model.provider).generateImage({
      model, prompt: plan.composed.prompt, refs, aspect: plan.params.aspect ?? PREVIEW_ASPECT, quality: plan.params.quality ?? 'standard', count: 1,
      idempotencyKey: `persona-preview-${personaId.slice(0, 8)}-${item.id}-${randomUUID().slice(0, 8)}`, signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    let res;
    try {
      res = await call();
    } catch (err) {
      // 'unknown' covers Codex exiting at start-up during a short ChatGPT outage: wait, then try once more.
      if (!(err instanceof ProviderError) || !['network', 'timeout', 'server', 'rate', 'unknown'].includes(err.kind)) throw err;
      await pause(JUDGE_RETRY_MS);
      res = await call();
    }
    const out = res.outputs[0];
    if (!out) throw new ProviderError('rejected', 'no image returned');
    const reported = typeof res.reportedCostUsd === 'number' && Number.isFinite(res.reportedCostUsd);
    const cost = reported ? res.reportedCostUsd! : price;
    recordSpend({
      personaId: LIBRARY_SPEND_ID, generationId: null, provider: model.provider, model: model.id, kind: 'image',
      costUsd: cost, costStatus: reported ? 'reported' : 'estimated', requestedBy: `${requestedBy}:persona-preview`.slice(0, 60),
    });
    job.costUsd = Math.round((job.costUsd + cost) * 1e6) / 1e6;
    if (attempt === 1) settle();

    const d = await downloadOutput(out, 'image');
    const dest = await storePreviewImage(d.bytes, d.ext, path.join(dir, `${item.id}-p${personaId.slice(0, 8)}-${randomUUID().slice(0, 8)}`));
    const judgeOnce = () => judgeImageFile(personaId, { path: dest, mime: dest.endsWith('.jpg') ? 'image/jpeg' : `image/${d.ext}` }, {
      spendId: LIBRARY_SPEND_ID, requestedBy: `${requestedBy}:persona-preview`.slice(0, 60),
    });
    // A judge that could not answer (outage, refusal) is asked again before the photo is given up.
    let verdict = await judgeOnce();
    for (let j = 0; verdict.verdict === 'skipped' && j < JUDGE_RETRIES; j++) {
      await pause(JUDGE_RETRY_MS * (j + 1));
      verdict = await judgeOnce();
    }
    if (keepsPersonaPhoto(verdict, minRealism)) {
      setPersonaPreview(personaId, item.id, dest, verdict.score);
      logger.info({ item: item.id, persona: personaId, attempt, score: verdict.score, realism: verdict.realism }, 'KOL: persona preview kept');
      return;
    }
    fs.rmSync(dest, { force: true });
    const drifted = verdict.verdict !== 'pass' || (verdict.score ?? 0) < PERSONA_MIN_SCORE;
    lastNote = verdict.verdict === 'skipped' ? `Chưa chấm được ảnh (${verdict.notes.slice(0, 80)}).`
      : drifted ? `Lệch mặt (${verdict.score ?? '?'}/100).` : `Ảnh trông giả/AI (độ thật ${verdict.realism}/100).`;
    logger.info({ item: item.id, persona: personaId, attempt, score: verdict.score, realism: verdict.realism }, 'KOL: persona preview rejected');
  }
  throw new KolError(422, `${lastNote} Vẽ ${PERSONA_DRAWS} lần chưa đạt, giữ ảnh mẫu chung.`);
}

// ── Auto-continue ────────────────────────────────────────────────────
//
// A full ChatGPT run is rationed by the daily limit, so it takes several days. With the
// plan on, the job continues by itself when the owner is not using the Studio: at night
// (00:00–06:00 local) or after an hour without a new generation, never while a
// generation is queued or running, and always leaving CHATGPT_RESERVE ChatGPT images of
// the day for the owner. The plan switches itself off once every item has a photo.

const AUTO_KEY = 'previewAuto';
/** ChatGPT images of the day an automatic run leaves for the owner's own work. */
export const CHATGPT_RESERVE = 15;
/** Without a new generation for this long the owner counts as away, also in the daytime. */
const IDLE_SEC = 60 * 60;
const AUTO_TICK_MS = 10 * 60_000;

interface AutoPlan {
  enabled: boolean;
  model: string;
  /** The KOL whose own photos it draws, or null for the shared catalog. */
  personaId: string | null;
  /** KOLs to continue with, in order, once the current one is done. */
  queue: string[];
}

export function readAutoPlan(): AutoPlan | null {
  const row = kolDb().prepare('SELECT value FROM kol_settings WHERE key = ?').get(AUTO_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as Partial<AutoPlan>;
    return typeof v.model === 'string' && v.model
      ? {
        enabled: v.enabled === true, model: v.model, personaId: typeof v.personaId === 'string' && v.personaId ? v.personaId : null,
        queue: Array.isArray(v.queue) ? v.queue.filter((q): q is string => typeof q === 'string' && !!q) : [],
      }
      : null;
  } catch {
    return null;
  }
}

function writeAutoPlan(plan: AutoPlan): void {
  kolDb().prepare('INSERT INTO kol_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(AUTO_KEY, JSON.stringify(plan));
}

const autoSchema = z.object({
  enabled: z.boolean({ message: 'Cần bật hoặc tắt.' }),
  model: z.string().min(1, 'Chọn mô hình ảnh.').optional(),
  /** Turning on with a KOL continues that KOL's own photos; without, the shared catalog. */
  personaId: z.string().min(1).max(100).nullable().optional(),
  /** Several KOLs, one after another (the first now, the others when it is done). */
  personaIds: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
});

/** Turns automatic continuation on or off (with the model to use), then tries a run at once. */
export function setAutoPlan(input: unknown): PreviewJobDto {
  const r = autoSchema.safeParse(input ?? {});
  if (!r.success) throw new KolError(400, r.error.issues[0]?.message ?? 'Dữ liệu không hợp lệ.');
  const current = readAutoPlan();
  const modelId = r.data.model ?? current?.model ?? '';
  const ids = r.data.personaIds ? [...new Set(r.data.personaIds)] : null;
  const personaId = ids ? ids[0] : r.data.personaId !== undefined ? r.data.personaId : (current?.personaId ?? null);
  // A single scope replaces the queue; switching off keeps it for the next time.
  const queue = ids ? ids.slice(1) : r.data.personaId !== undefined ? [] : (current?.queue ?? []);
  if (r.data.enabled) {
    const model = findModel(modelId);
    if (!model || model.kind !== 'image') throw new KolError(400, 'Chọn một mô hình ảnh để tự vẽ tiếp.');
    if (!isProviderConfigured(model.provider)) throw new KolError(412, `${model.provider} chưa có API key.`, 'not_configured');
    if (previewPrice(model) === null) throw new KolError(412, 'Chưa có giá cho mô hình này. Nhập giá ở KOL Studio › Cài đặt › Giá ghi đè.', 'no_price');
    for (const id of [personaId, ...queue]) if (id) assertPersonaReady(id);
  }
  if (!modelId) throw new KolError(400, 'Chọn mô hình ảnh.');
  writeAutoPlan({ enabled: r.data.enabled, model: modelId, personaId, queue });
  if (r.data.enabled) tickAutoPreviews();
  return previewJobStatus(undefined, personaId ?? undefined);
}

/**
 * How many photos an automatic run may draw now (0 = not now). Pure, for tests.
 * Night or an idle owner opens the window; ChatGPT keeps CHATGPT_RESERVE of the day's limit.
 */
export function autoRunBudget(o: {
  now: Date; lastActivitySec: number | null; provider: ModelInfo['provider']; chatgptUsed: number; chatgptLimit: number; missing: number;
}): number {
  if (o.missing <= 0) return 0;
  const night = o.now.getHours() < 6;
  const idle = o.lastActivitySec === null || o.now.getTime() / 1000 - o.lastActivitySec >= IDLE_SEC;
  if (!night && !idle) return 0;
  if (o.provider !== 'chatgpt' || o.chatgptLimit <= 0) return o.missing;
  return Math.max(0, Math.min(o.missing, o.chatgptLimit - CHATGPT_RESERVE - o.chatgptUsed));
}

/** One scheduler step: starts an automatic run when the plan is on and the window is open. True when it started one. */
export function tickAutoPreviews(now = new Date()): boolean {
  const plan = readAutoPlan();
  if (!plan?.enabled || job.running) return false;
  const model = findModel(plan.model);
  if (!model || !isProviderConfigured(model.provider)) return false;
  const busy = kolDb().prepare("SELECT COUNT(*) AS n FROM kol_generations WHERE status IN ('queued', 'running')").get() as { n: number };
  if (busy.n > 0) return false;
  // The current scope is done: move on to the next KOL in the queue, or switch off.
  let scope = plan;
  let missing = autoMissingCount(entriesFor(scope.personaId));
  while (missing === 0 && scope.queue.length) {
    scope = { ...scope, personaId: scope.queue[0], queue: scope.queue.slice(1) };
    writeAutoPlan(scope);
    missing = autoMissingCount(entriesFor(scope.personaId));
  }
  if (missing === 0) { writeAutoPlan({ ...scope, enabled: false }); return false; }
  const last = kolDb().prepare('SELECT MAX(created_at) AS t FROM kol_generations').get() as { t: number | null };
  const budget = autoRunBudget({
    now, lastActivitySec: last.t, provider: model.provider, chatgptUsed: chatgptImagesToday(now.getTime()),
    chatgptLimit: loadSettings().chatgptDailyLimit, missing,
  });
  if (budget <= 0) return false;
  try {
    startPreviewJob({ model: model.id, personaId: scope.personaId ?? undefined, limit: budget }, 'auto');
    logger.info({ model: model.id, budget, persona: scope.personaId }, 'KOL: library previews continue automatically');
    return true;
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'KOL: automatic preview run not started');
    return false;
  }
}

let autoTimer: ReturnType<typeof setInterval> | null = null;

export function stopPreviewScheduler(): void {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;
}

/** Starts the 10-minute scheduler (once per process). */
export function startPreviewScheduler(): void {
  if (autoTimer) return;
  // Give the server a moment to settle, then pick up a run the restart interrupted: the owner's
  // run, else the automatic plan at once (not ten minutes later; restarts are frequent).
  setTimeout(() => {
    try { if (!resumeInterruptedRun()) tickAutoPreviews(); } catch (err) { logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'KOL: preview resume failed'); }
  }, 20_000).unref?.();
  autoTimer = setInterval(() => {
    try { tickAutoPreviews(); } catch (err) { logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'KOL: preview scheduler tick failed'); }
  }, AUTO_TICK_MS);
  autoTimer.unref?.();
}
