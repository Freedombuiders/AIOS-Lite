/**
 * Business side of kol-cli (src/kol-cli.ts): argv → JSON result. Agents read personas, the
 * library and growth, preview and queue generations (paid, within the studio caps) and draft
 * posts for the owner's review. There is no publish command: approval and publishing stay
 * with the owner and the dashboard publisher.
 */

import { parseLocalDateTime } from './time.js';
import { listAccountRows } from './accounts.js';
import { listAssets } from './assets.js';
import { KolError } from './core.js';
import { getGeneration, previewGeneration, requestGeneration } from './generations.js';
import { listLibrary } from './library.js';
import { computeGrowth } from './metrics.js';
import { getPersona, listPersonaSummaries } from './personas.js';
import { createPost, listPosts, requirePost, submitPost, updatePost } from './posts.js';
import { listRadarIdeas } from './radar-ideas.js';
import type {
  AssetKind, AssetStatus, GenerationMode, GenerationRequest, LibraryKind, PersonaDto, Platform, PlatformVariant, PostFormat, PostInput, PostStatus,
} from './types.js';

export class CliUsageError extends Error {
  constructor(message: string) { super(message); this.name = 'CliUsageError'; }
}

interface Parsed { positionals: string[]; flags: Map<string, string[]> }

function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const value = next !== undefined && !next.startsWith('--') ? (i++, next) : 'true';
      flags.set(key, [...(flags.get(key) ?? []), value]);
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

const one = (p: Parsed, key: string): string | undefined => p.flags.get(key)?.at(-1);
const many = (p: Parsed, key: string): string[] => p.flags.get(key) ?? [];

function num(p: Parsed, key: string, min: number, max: number): number | undefined {
  const raw = one(p, key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new CliUsageError(`--${key} phải là số trong khoảng ${min}–${max}.`);
  return n;
}

function requireFlag(p: Parsed, key: string): string {
  const v = one(p, key);
  if (!v || v === 'true') throw new CliUsageError(`Thiếu --${key}.`);
  return v;
}

/** A persona by id or @handle. */
function personaOf(ref: string): PersonaDto {
  const byId = getPersona(ref);
  if (byId) return byId;
  const handle = ref.replace(/^@/, '').toLowerCase();
  const hit = listPersonaSummaries().find((s) => s.handle.toLowerCase() === handle || s.name.toLowerCase() === ref.toLowerCase());
  const persona = hit ? getPersona(hit.id) : null;
  if (!persona) throw new CliUsageError(`Không tìm thấy KOL "${ref}". Chạy "personas" để xem danh sách.`);
  return persona;
}

/** Local "YYYY-MM-DD HH:MM" in the timezone of the persona's first enabled account (else Asia/Ho_Chi_Minh). */
function scheduleOf(p: Parsed, personaId: string): number | undefined {
  const raw = one(p, 'schedule');
  if (!raw) return undefined;
  const tz = listAccountRows(personaId).find((a) => a.enabled)?.timezone ?? 'Asia/Ho_Chi_Minh';
  const at = parseLocalDateTime(raw, tz);
  if (at === null) throw new CliUsageError('--schedule phải có dạng "YYYY-MM-DD HH:MM" (giờ địa phương của tài khoản).');
  return at;
}

const SLOT_FLAGS: [flag: string, key: keyof NonNullable<GenerationRequest['selection']>][] = [
  ['outfit', 'outfitId'], ['expression', 'expressionId'], ['hair', 'hairId'], ['scene', 'sceneId'], ['pose', 'poseId'],
  ['look', 'lookId'], ['effect', 'effectId'], ['camera', 'cameraId'], ['template', 'templateId'], ['source-asset', 'sourceAssetId'],
];

function generationRequest(p: Parsed): GenerationRequest {
  const persona = personaOf(requireFlag(p, 'persona'));
  const selection: NonNullable<GenerationRequest['selection']> = {};
  for (const [flag, key] of SLOT_FLAGS) {
    const v = one(p, flag);
    if (v && v !== 'true') (selection as Record<string, string>)[key] = v;
  }
  // --camera lens,shot,angle,move: a camera setup of several items.
  if (selection.cameraId?.includes(',')) {
    selection.cameraIds = selection.cameraId.split(',').map((x) => x.trim()).filter(Boolean);
    delete selection.cameraId;
  }
  const realism = one(p, 'realism');
  if (realism) selection.realism = realism as never;
  const mode = (one(p, 'mode') ?? (selection.templateId ? 'recreate' : 'compose')) as GenerationMode;
  return {
    personaId: persona.id,
    mode,
    selection,
    params: {
      model: one(p, 'model'),
      aspect: one(p, 'aspect') as never,
      quality: one(p, 'quality') as never,
      count: num(p, 'count', 1, 4),
      seed: num(p, 'seed', 0, 2 ** 31),
      extraPrompt: one(p, 'prompt'),
      durationSec: num(p, 'duration', 1, 60),
      audio: one(p, 'audio') === undefined ? undefined : one(p, 'audio') !== 'false',
      script: one(p, 'script'),
    },
    ...(one(p, 'post') ? { postId: one(p, 'post') } : {}),
  };
}

function postInput(p: Parsed, personaId: string): PostInput {
  const input: PostInput = {};
  const title = one(p, 'title'); if (title !== undefined) input.title = title;
  const pillar = one(p, 'pillar'); if (pillar !== undefined) input.pillar = pillar;
  const format = one(p, 'format'); if (format !== undefined) input.format = format as PostFormat;
  const caption = one(p, 'caption'); if (caption !== undefined) input.caption = caption;
  const brief = one(p, 'brief'); if (brief !== undefined) input.brief = brief;
  if (p.flags.has('hashtag')) input.hashtags = many(p, 'hashtag');
  if (p.flags.has('asset')) input.assetIds = many(p, 'asset');
  if (p.flags.has('account')) input.accountIds = many(p, 'account');
  const variants: Partial<Record<Platform, PlatformVariant>> = {};
  for (const platform of ['facebook', 'instagram', 'tiktok', 'youtube'] as Platform[]) {
    const c = one(p, `caption-${platform}`);
    const t = one(p, `title-${platform}`);
    if (c !== undefined || t !== undefined) variants[platform] = { caption: c ?? '', ...(t ? { title: t } : {}) };
  }
  if (Object.keys(variants).length) input.variants = variants;
  const at = scheduleOf(p, personaId);
  if (at !== undefined) input.scheduledAt = at;
  return input;
}

const compactPost = (id: string) => {
  const post = requirePost(id);
  return {
    id: post.id, status: post.status, title: post.title, format: post.format, pillar: post.pillar, scheduledAt: post.scheduledAt,
    assets: post.assetIds, targets: post.targets.map((t) => ({ platform: t.platform, handle: t.handle, status: t.status, permalink: t.permalink, error: t.error })),
    feedback: post.feedback,
  };
};

export async function runCommand(argv: string[], agentId: string): Promise<unknown> {
  const [command, ...rest] = argv;
  const p = parse(rest);
  switch (command) {
    case 'personas':
      return listPersonaSummaries().filter((s) => one(p, 'all') ? true : s.status !== 'archived').map((s) => ({
        id: s.id, name: s.name, handle: s.handle, status: s.status, niche: s.niche, platforms: s.platforms, followers: s.followers,
        postsScheduled: s.postsScheduled, postsPublished30d: s.postsPublished30d, spendMonthUsd: s.spendMonthUsd, autopilot: s.autopilot,
      }));

    case 'show': {
      const persona = personaOf(p.positionals[0] ?? requireFlag(p, 'persona'));
      const { refs, ...rest } = persona;
      return {
        ...rest,
        refs: refs.map((r) => ({ id: r.id, kind: r.kind, label: r.label, isPrimary: r.isPrimary })),
        accounts: listAccountRows(persona.id).map((a) => ({
          id: a.id, platform: a.platform, handle: a.handle, enabled: !!a.enabled, timezone: a.timezone, window: `${a.window_start}–${a.window_end}`,
          maxPostsPerDay: a.max_posts_per_day, minGapMinutes: a.min_gap_minutes, status: a.status,
        })),
      };
    }

    case 'library': {
      const persona = personaOf(requireFlag(p, 'persona'));
      const kind = one(p, 'kind') as LibraryKind | undefined;
      const search = (one(p, 'search') ?? '').toLowerCase();
      const limit = num(p, 'limit', 1, 500) ?? 120;
      return listLibrary({ kind, personaId: persona.id })
        .filter((i) => !search || `${i.name} ${i.group} ${i.prompt} ${i.tags.join(' ')}`.toLowerCase().includes(search))
        .slice(0, limit)
        .map((i) => ({ id: i.id, kind: i.kind, group: i.group, name: i.name, prompt: i.prompt }));
    }

    case 'preview':
      return previewGeneration(generationRequest(p));

    case 'generate': {
      const generation = requestGeneration(generationRequest(p), agentId);
      return { id: generation.id, status: generation.status, model: generation.model, estimateUsd: generation.estimateUsd, note: 'Đã xếp hàng. Xem kết quả bằng "generation <id>".' };
    }

    case 'generation': {
      const id = p.positionals[0];
      if (!id) throw new CliUsageError('Cần id của lần tạo.');
      const g = getGeneration(id);
      if (!g) throw new CliUsageError(`Không có lần tạo ${id}.`);
      return { id: g.id, status: g.status, mode: g.mode, model: g.model, costUsd: g.costUsd, error: g.error, assetIds: g.assetIds };
    }

    case 'assets': {
      const persona = personaOf(requireFlag(p, 'persona'));
      const { assets } = listAssets({
        personaId: persona.id,
        status: one(p, 'status') as AssetStatus | undefined,
        kind: one(p, 'kind') as AssetKind | undefined,
        limit: num(p, 'limit', 1, 100) ?? 30,
      });
      return assets.map((a) => ({
        id: a.id, kind: a.kind, status: a.status, favorite: a.favorite, width: a.width, height: a.height, durationSec: a.durationSec,
        consistency: a.consistency, createdAt: a.createdAt,
      }));
    }

    case 'posts': {
      const persona = personaOf(requireFlag(p, 'persona'));
      return listPosts({ personaId: persona.id, status: one(p, 'status') as PostStatus | undefined }).map((post) => compactPost(post.id));
    }

    case 'post-add': {
      const persona = personaOf(requireFlag(p, 'persona'));
      const post = createPost(persona.id, postInput(p, persona.id), { source: 'agent', sourceRef: agentId });
      // Agents never approve: the post waits in review for the owner.
      return compactPost(one(p, 'draft') ? post.id : submitPost(post.id).id);
    }

    case 'post-update': {
      const id = p.positionals[0];
      if (!id) throw new CliUsageError('Cần id bài đăng.');
      const current = requirePost(id);
      updatePost(id, postInput(p, current.personaId));
      return compactPost(id);
    }

    case 'growth': {
      const persona = personaOf(requireFlag(p, 'persona'));
      return computeGrowth(persona.id, num(p, 'days', 1, 365) ?? 30);
    }

    case 'ideas':
      return listRadarIdeas(num(p, 'limit', 1, 100) ?? 20);

    default:
      throw new CliUsageError(command ? `Lệnh không hợp lệ: ${command}.` : 'Thiếu lệnh.');
  }
}

export { KolError };
