/**
 * Personas: the virtual influencers. CRUD, DTO mapping and validation.
 * DELETE archives (files and history are kept).
 */

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { KolError, kolDb, mediaUrl, nowSec, parseJson } from './core.js';
import { findModel } from './providers/index.js';
import { listRefs } from './refs.js';
import { personaMonthSpend } from './spend.js';
import type {
  Appearance, AutopilotConfig, Personality, Pillar, Platform, PersonaDto, PersonaInput, PersonaStatus, PersonaSummaryDto, RealismPreset,
} from './types.js';

export const DEFAULT_DISCLOSURE = 'Nhân vật ảo do AI tạo. #AI #VirtualInfluencer';

export const DEFAULT_APPEARANCE: Appearance = {
  gender: '', ageRange: '', ethnicity: '', face: '', eyes: '', skin: '', hair: '', body: '', marks: '', styleKeywords: [], signatureLook: '',
};

export const DEFAULT_PERSONALITY: Personality = {
  traits: [], values: [], backstory: '', voiceTone: '', writingStyle: '', catchphrases: [], do: [], dont: [],
};

export const DEFAULT_AUTOPILOT: AutopilotConfig = {
  enabled: false,
  postsPerWeek: { instagram: 5, tiktok: 3 },
  leadDays: 3,
  requireApproval: true,
  imagesPerPost: 2,
  generateMedia: true,
  weeklyBudgetUsd: 5,
};

const STATUSES: PersonaStatus[] = ['draft', 'active', 'paused', 'archived'];
const REALISM: RealismPreset[] = ['iphone-candid', 'pro-photo', 'editorial', 'film-35mm', 'studio-clean', 'none'];
const PLATFORMS: Platform[] = ['facebook', 'instagram', 'tiktok', 'youtube'];

// ── Rows & DTOs ──────────────────────────────────────────────────────

export interface PersonaRow {
  id: string;
  name: string;
  handle: string;
  status: PersonaStatus;
  tagline: string;
  niche: string;
  languages_json: string;
  bio: string;
  appearance_json: string;
  personality_json: string;
  audience: string;
  pillars_json: string;
  identity_source: 'synthetic' | 'licensed';
  consent_note: string;
  disclosure_text: string;
  voice_id: string;
  brain_agent: string;
  image_model: string;
  video_model: string;
  realism_preset: RealismPreset;
  consistency_threshold: number;
  auto_reject_drift: number;
  monthly_cap_usd: number | null;
  autopilot_json: string;
  cover_asset_id: string | null;
  created_at: number;
  updated_at: number;
}

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function mergeAppearance(raw: unknown): Appearance {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_APPEARANCE };
  for (const k of Object.keys(DEFAULT_APPEARANCE) as (keyof Appearance)[]) {
    if (k === 'styleKeywords') out.styleKeywords = strArr(o.styleKeywords);
    else if (typeof o[k] === 'string') (out as Record<string, unknown>)[k] = o[k];
  }
  return out;
}

function mergePersonality(raw: unknown): Personality {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    traits: strArr(o.traits), values: strArr(o.values), backstory: typeof o.backstory === 'string' ? o.backstory : '',
    voiceTone: typeof o.voiceTone === 'string' ? o.voiceTone : '', writingStyle: typeof o.writingStyle === 'string' ? o.writingStyle : '',
    catchphrases: strArr(o.catchphrases), do: strArr(o.do), dont: strArr(o.dont),
  };
}

function mergeAutopilot(raw: unknown): AutopilotConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<AutopilotConfig>;
  const ppw: Partial<Record<Platform, number>> = {};
  const src = o.postsPerWeek && typeof o.postsPerWeek === 'object' ? o.postsPerWeek : DEFAULT_AUTOPILOT.postsPerWeek;
  for (const p of PLATFORMS) if (typeof src[p] === 'number') ppw[p] = src[p];
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_AUTOPILOT.enabled,
    postsPerWeek: ppw,
    leadDays: typeof o.leadDays === 'number' ? o.leadDays : DEFAULT_AUTOPILOT.leadDays,
    requireApproval: typeof o.requireApproval === 'boolean' ? o.requireApproval : DEFAULT_AUTOPILOT.requireApproval,
    imagesPerPost: typeof o.imagesPerPost === 'number' ? o.imagesPerPost : DEFAULT_AUTOPILOT.imagesPerPost,
    generateMedia: typeof o.generateMedia === 'boolean' ? o.generateMedia : DEFAULT_AUTOPILOT.generateMedia,
    weeklyBudgetUsd: typeof o.weeklyBudgetUsd === 'number' ? o.weeklyBudgetUsd : DEFAULT_AUTOPILOT.weeklyBudgetUsd,
  };
}

function pillarsOf(raw: unknown): Pillar[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is Pillar => Boolean(p && typeof p === 'object' && typeof (p as Pillar).name === 'string'))
    .map((p) => ({ id: String(p.id ?? ''), name: p.name, description: typeof p.description === 'string' ? p.description : '', share: Number(p.share) || 0 }));
}

export function personaRowToDto(row: PersonaRow): PersonaDto {
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    status: row.status,
    tagline: row.tagline,
    niche: row.niche,
    languages: parseJson<string[]>(row.languages_json, ['vi']),
    bio: row.bio,
    appearance: mergeAppearance(parseJson<unknown>(row.appearance_json, {})),
    personality: mergePersonality(parseJson<unknown>(row.personality_json, {})),
    audience: row.audience,
    pillars: pillarsOf(parseJson<unknown>(row.pillars_json, [])),
    identitySource: row.identity_source === 'licensed' ? 'licensed' : 'synthetic',
    consentNote: row.consent_note,
    disclosureText: row.disclosure_text,
    voiceId: row.voice_id,
    brainAgent: row.brain_agent,
    imageModel: row.image_model,
    videoModel: row.video_model,
    realismPreset: REALISM.includes(row.realism_preset) ? row.realism_preset : 'pro-photo',
    consistencyThreshold: row.consistency_threshold,
    autoRejectDrift: row.auto_reject_drift === 1,
    monthlyCapUsd: row.monthly_cap_usd,
    autopilot: mergeAutopilot(parseJson<unknown>(row.autopilot_json, {})),
    coverAssetId: row.cover_asset_id,
    refs: listRefs(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRow(id: string): PersonaRow | null {
  return (kolDb().prepare('SELECT * FROM kol_personas WHERE id = ?').get(id) as PersonaRow | undefined) ?? null;
}

export function getPersona(id: string): PersonaDto | null {
  if (typeof id !== 'string' || !id) return null;
  const row = getRow(id);
  return row ? personaRowToDto(row) : null;
}

export function requirePersona(id: string): PersonaDto {
  const p = getPersona(id);
  if (!p) throw new KolError(404, 'Không tìm thấy KOL.');
  return p;
}

export function listPersonaIds(): string[] {
  return (kolDb().prepare('SELECT id FROM kol_personas ORDER BY created_at').all() as { id: string }[]).map((r) => r.id);
}

// ── Summaries ────────────────────────────────────────────────────────

/** The publish-side numbers. Plain SQL on PUBLISH tables, guarded: never breaks the list. */
function publishNumbers(personaId: string, now: number): Pick<PersonaSummaryDto, 'platforms' | 'followers' | 'postsScheduled' | 'postsPublished30d'> {
  const out = { platforms: [] as Platform[], followers: null as number | null, postsScheduled: 0, postsPublished30d: 0 };
  const db = kolDb();
  try {
    const rows = db.prepare('SELECT DISTINCT platform FROM kol_accounts WHERE persona_id = ? AND enabled = 1').all(personaId) as { platform: string }[];
    out.platforms = rows.map((r) => r.platform).filter((p): p is Platform => (PLATFORMS as string[]).includes(p));
    const f = db.prepare('SELECT SUM(followers) AS s, COUNT(followers) AS n FROM kol_accounts WHERE persona_id = ? AND enabled = 1').get(personaId) as { s: number | null; n: number };
    out.followers = f.n > 0 ? f.s : null;
  } catch { /* table missing or changed */ }
  try {
    out.postsScheduled = (db.prepare("SELECT COUNT(*) AS n FROM kol_posts WHERE persona_id = ? AND status = 'scheduled'").get(personaId) as { n: number }).n;
    out.postsPublished30d = (db.prepare("SELECT COUNT(*) AS n FROM kol_posts WHERE persona_id = ? AND status IN ('published', 'partial') AND published_at >= ?")
      .get(personaId, now - 30 * 86400) as { n: number }).n;
  } catch { /* table missing or changed */ }
  return out;
}

function avatarUrl(row: PersonaRow): string | null {
  const db = kolDb();
  const ref = db.prepare("SELECT id FROM kol_refs WHERE persona_id = ? AND kind = 'anchor' ORDER BY is_primary DESC, sort, created_at LIMIT 1").get(row.id) as { id: string } | undefined;
  if (ref) return mediaUrl('ref', ref.id);
  if (row.cover_asset_id) {
    const a = db.prepare('SELECT id, thumb FROM kol_assets WHERE id = ?').get(row.cover_asset_id) as { id: string; thumb: string | null } | undefined;
    if (a) return a.thumb ? mediaUrl('thumb', a.id) : mediaUrl('asset', a.id);
  }
  const anyRef = db.prepare('SELECT id FROM kol_refs WHERE persona_id = ? ORDER BY sort, created_at LIMIT 1').get(row.id) as { id: string } | undefined;
  return anyRef ? mediaUrl('ref', anyRef.id) : null;
}

const STATUS_ORDER: Record<PersonaStatus, number> = { active: 0, draft: 1, paused: 2, archived: 3 };

export function listPersonaSummaries(): PersonaSummaryDto[] {
  const db = kolDb();
  const rows = db.prepare('SELECT * FROM kol_personas').all() as PersonaRow[];
  const now = nowSec();
  return rows
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.updated_at - a.updated_at)
    .map((row) => {
      const counts = db.prepare(
        `SELECT (SELECT COUNT(*) FROM kol_refs WHERE persona_id = ?) AS refs,
                (SELECT COUNT(*) FROM kol_assets WHERE persona_id = ?) AS assets,
                (SELECT AVG(consistency_score) FROM kol_assets WHERE persona_id = ? AND consistency_score IS NOT NULL AND created_at >= ?) AS avg`,
      ).get(row.id, row.id, row.id, now - 90 * 86400) as { refs: number; assets: number; avg: number | null };
      return {
        id: row.id,
        name: row.name,
        handle: row.handle,
        status: row.status,
        tagline: row.tagline,
        niche: row.niche,
        avatarUrl: avatarUrl(row),
        refCount: counts.refs,
        assetCount: counts.assets,
        ...publishNumbers(row.id, now),
        spendMonthUsd: personaMonthSpend(row.id),
        avgConsistency: counts.avg === null ? null : Math.round(counts.avg),
        autopilot: mergeAutopilot(parseJson<unknown>(row.autopilot_json, {})).enabled,
        updatedAt: row.updated_at,
      };
    });
}

// ── Validation ───────────────────────────────────────────────────────

const s = (max: number, label: string) => z.string({ message: `${label} phải là chuỗi.` }).max(max, `${label} tối đa ${max} ký tự.`);
const list = (max: number, itemMax: number, label: string) => z.array(s(itemMax, label), { message: `${label} phải là danh sách.` }).max(max, `${label} tối đa ${max} mục.`);

const appearanceSchema = z.object({
  gender: s(60, 'Giới tính'), ageRange: s(60, 'Độ tuổi'), ethnicity: s(80, 'Dân tộc / gốc'), face: s(800, 'Khuôn mặt'),
  eyes: s(300, 'Mắt'), skin: s(300, 'Làn da'), hair: s(300, 'Tóc'), body: s(400, 'Vóc dáng'), marks: s(400, 'Dấu hiệu nhận biết'),
  styleKeywords: list(20, 60, 'Từ khóa phong cách'), signatureLook: s(300, 'Phong cách đặc trưng'),
}).partial();

const personalitySchema = z.object({
  traits: list(20, 80, 'Tính cách'), values: list(20, 160, 'Giá trị'), backstory: s(4000, 'Tiểu sử'),
  voiceTone: s(300, 'Giọng điệu'), writingStyle: s(800, 'Cách viết'), catchphrases: list(20, 160, 'Câu cửa miệng'),
  do: list(30, 240, 'Nên làm'), dont: list(30, 240, 'Không làm'),
}).partial();

const pillarSchema = z.object({
  id: z.string().max(60).optional(),
  name: s(80, 'Tên trụ cột').min(1, 'Trụ cột nội dung cần có tên.'),
  description: s(600, 'Mô tả trụ cột').optional(),
  share: z.number({ message: 'Tỉ trọng trụ cột phải là số.' }).min(0, 'Tỉ trọng trụ cột từ 0 đến 100.').max(100, 'Tỉ trọng trụ cột từ 0 đến 100.'),
});

const autopilotSchema = z.object({
  enabled: z.boolean({ message: 'Autopilot bật/tắt phải là true/false.' }),
  postsPerWeek: z.partialRecord(z.enum(['facebook', 'instagram', 'tiktok', 'youtube']), z.number().int().min(0, 'Số bài mỗi tuần từ 0 đến 28.').max(28, 'Số bài mỗi tuần từ 0 đến 28.')),
  leadDays: z.number().int().min(1, 'Số ngày lên lịch trước từ 1 đến 14.').max(14, 'Số ngày lên lịch trước từ 1 đến 14.'),
  requireApproval: z.boolean(),
  imagesPerPost: z.number().int().min(1, 'Số ảnh mỗi bài từ 1 đến 4.').max(4, 'Số ảnh mỗi bài từ 1 đến 4.'),
  generateMedia: z.boolean(),
  weeklyBudgetUsd: z.number().min(0, 'Ngân sách tuần không được âm.').max(10_000, 'Ngân sách tuần quá lớn.'),
}).partial();

export const personaInputSchema = z.object({
  name: s(80, 'Tên KOL'),
  handle: s(40, 'Handle'),
  status: z.enum(STATUSES as [PersonaStatus, ...PersonaStatus[]], { message: 'Trạng thái phải là draft, active, paused hoặc archived.' }),
  tagline: s(200, 'Khẩu hiệu'),
  niche: s(160, 'Lĩnh vực'),
  languages: list(8, 10, 'Ngôn ngữ'),
  bio: s(3000, 'Giới thiệu'),
  appearance: appearanceSchema,
  personality: personalitySchema,
  audience: s(2000, 'Khán giả'),
  pillars: z.array(pillarSchema).max(12, 'Tối đa 12 trụ cột nội dung.'),
  identitySource: z.enum(['synthetic', 'licensed'], { message: 'Nguồn nhân dạng phải là synthetic hoặc licensed.' }),
  consentNote: s(3000, 'Ghi chú đồng ý'),
  disclosureText: s(300, 'Dòng công bố AI'),
  voiceId: s(120, 'Giọng đọc'),
  brainAgent: s(80, 'Agent bộ não'),
  imageModel: s(200, 'Model ảnh'),
  videoModel: s(200, 'Model video'),
  realismPreset: z.enum(REALISM as [RealismPreset, ...RealismPreset[]], { message: 'Kiểu ảnh thật không hợp lệ.' }),
  consistencyThreshold: z.number({ message: 'Ngưỡng nhất quán phải là số.' }).int('Ngưỡng nhất quán phải là số nguyên.'),
  autoRejectDrift: z.boolean({ message: 'Tự loại ảnh lệch mặt phải là true/false.' }),
  monthlyCapUsd: z.number({ message: 'Hạn mức tháng phải là số.' }).min(0, 'Hạn mức tháng không được âm.').max(100_000).nullable(),
  autopilot: autopilotSchema,
  coverAssetId: z.string().max(80).nullable(),
}).partial();

function parseInput(input: unknown): z.infer<typeof personaInputSchema> {
  const r = personaInputSchema.safeParse(input ?? {});
  if (!r.success) throw new KolError(400, r.error.issues[0]?.message ?? 'Dữ liệu KOL không hợp lệ.');
  return r.data;
}

/** Business rules on a full persona. Throws KolError(400) with the first problem. */
export function validatePersona(p: PersonaDto, anchors: number): void {
  if (!p.name.trim()) throw new KolError(400, 'Cần nhập tên KOL.');
  if (p.handle && !/^[a-z0-9._]+$/.test(p.handle)) throw new KolError(400, 'Handle chỉ gồm chữ thường a-z, số, dấu chấm và gạch dưới.');
  if (p.consistencyThreshold < 50 || p.consistencyThreshold > 100) throw new KolError(400, 'Ngưỡng nhất quán phải từ 50 đến 100.');
  const shares = p.pillars.reduce((sum, x) => sum + x.share, 0);
  if (shares > 100 + 1e-9) throw new KolError(400, `Tổng tỉ trọng các trụ cột là ${Math.round(shares)}%, không được vượt 100%.`);
  if (p.identitySource === 'licensed' && !p.consentNote.trim()) {
    throw new KolError(400, 'Nhân vật dựa trên người thật cần ghi chú đồng ý: người đó là ai và văn bản đồng ý nằm ở đâu.');
  }
  if (p.status === 'active') {
    if (!p.disclosureText.trim()) throw new KolError(400, 'KOL chỉ được bật (active) khi có dòng công bố AI.');
    if (anchors < 1) throw new KolError(400, 'KOL chỉ được bật (active) khi có ít nhất một ảnh gốc (anchor).');
  }
  if (p.imageModel) {
    const m = findModel(p.imageModel);
    if (!m || m.kind !== 'image') throw new KolError(400, `Model ảnh "${p.imageModel}" không tồn tại.`);
  }
  if (p.videoModel) {
    const m = findModel(p.videoModel);
    if (!m || m.kind !== 'video') throw new KolError(400, `Model video "${p.videoModel}" không tồn tại.`);
  }
  if (p.coverAssetId) {
    const a = kolDb().prepare('SELECT persona_id FROM kol_assets WHERE id = ?').get(p.coverAssetId) as { persona_id: string } | undefined;
    if (!a || a.persona_id !== p.id) throw new KolError(400, 'Ảnh bìa phải là một ảnh trong thư viện của KOL này.');
  }
}

function normaliseHandle(h: string): string {
  return h.trim().replace(/^@+/, '').toLowerCase();
}

function applyInput(base: PersonaDto, input: z.infer<typeof personaInputSchema>): PersonaDto {
  const next: PersonaDto = { ...base };
  const simple = ['name', 'status', 'tagline', 'niche', 'bio', 'audience', 'identitySource', 'consentNote', 'disclosureText', 'voiceId',
    'brainAgent', 'imageModel', 'videoModel', 'realismPreset', 'consistencyThreshold', 'autoRejectDrift', 'monthlyCapUsd', 'coverAssetId'] as const;
  for (const k of simple) {
    if (input[k] !== undefined) (next as unknown as Record<string, unknown>)[k] = typeof input[k] === 'string' ? (input[k] as string).trim() : input[k];
  }
  if (input.handle !== undefined) next.handle = normaliseHandle(input.handle);
  if (input.languages !== undefined) next.languages = input.languages.map((l) => l.trim()).filter(Boolean);
  if (input.appearance) next.appearance = mergeAppearance({ ...base.appearance, ...input.appearance });
  if (input.personality) next.personality = mergePersonality({ ...base.personality, ...input.personality });
  if (input.autopilot) {
    next.autopilot = mergeAutopilot({ ...base.autopilot, ...input.autopilot, postsPerWeek: input.autopilot.postsPerWeek ?? base.autopilot.postsPerWeek });
  }
  if (input.pillars) {
    next.pillars = input.pillars.map((p) => ({ id: p.id?.trim() || randomUUID().slice(0, 8), name: p.name.trim(), description: (p.description ?? '').trim(), share: p.share }));
  }
  return next;
}

function write(p: PersonaDto, insert: boolean): void {
  const params = [
    p.name, p.handle, p.status, p.tagline, p.niche, JSON.stringify(p.languages), p.bio, JSON.stringify(p.appearance), JSON.stringify(p.personality),
    p.audience, JSON.stringify(p.pillars), p.identitySource, p.consentNote, p.disclosureText, p.voiceId, p.brainAgent, p.imageModel, p.videoModel,
    p.realismPreset, p.consistencyThreshold, p.autoRejectDrift ? 1 : 0, p.monthlyCapUsd, JSON.stringify(p.autopilot), p.coverAssetId, p.updatedAt,
  ];
  if (insert) {
    kolDb().prepare(
      `INSERT INTO kol_personas (name, handle, status, tagline, niche, languages_json, bio, appearance_json, personality_json, audience, pillars_json,
         identity_source, consent_note, disclosure_text, voice_id, brain_agent, image_model, video_model, realism_preset, consistency_threshold,
         auto_reject_drift, monthly_cap_usd, autopilot_json, cover_asset_id, updated_at, id, created_at)
       VALUES (${new Array(27).fill('?').join(', ')})`,
    ).run(...params, p.id, p.createdAt);
  } else {
    kolDb().prepare(
      `UPDATE kol_personas SET name = ?, handle = ?, status = ?, tagline = ?, niche = ?, languages_json = ?, bio = ?, appearance_json = ?,
         personality_json = ?, audience = ?, pillars_json = ?, identity_source = ?, consent_note = ?, disclosure_text = ?, voice_id = ?,
         brain_agent = ?, image_model = ?, video_model = ?, realism_preset = ?, consistency_threshold = ?, auto_reject_drift = ?,
         monthly_cap_usd = ?, autopilot_json = ?, cover_asset_id = ?, updated_at = ? WHERE id = ?`,
    ).run(...params, p.id);
  }
}

function anchorsOf(p: PersonaDto): number {
  return p.refs.filter((r) => r.kind === 'anchor').length;
}

export function createPersona(input: PersonaInput | unknown): PersonaDto {
  const parsed = parseInput(input);
  if (!parsed.name?.trim()) throw new KolError(400, 'Cần nhập tên KOL.');
  const now = nowSec();
  const base: PersonaDto = {
    id: randomUUID(), name: '', handle: '', status: 'draft', tagline: '', niche: '', languages: ['vi'], bio: '',
    appearance: { ...DEFAULT_APPEARANCE }, personality: { ...DEFAULT_PERSONALITY }, audience: '', pillars: [],
    identitySource: 'synthetic', consentNote: '', disclosureText: DEFAULT_DISCLOSURE, voiceId: '', brainAgent: 'main',
    imageModel: '', videoModel: '', realismPreset: 'pro-photo', consistencyThreshold: 80, autoRejectDrift: false, monthlyCapUsd: null,
    autopilot: { ...DEFAULT_AUTOPILOT, postsPerWeek: { ...DEFAULT_AUTOPILOT.postsPerWeek } }, coverAssetId: null, refs: [], createdAt: now, updatedAt: now,
  };
  const next = applyInput(base, parsed);
  validatePersona(next, 0);
  write(next, true);
  return requirePersona(next.id);
}

export function updatePersona(id: string, input: PersonaInput | unknown): PersonaDto {
  const current = requirePersona(id);
  const parsed = parseInput(input);
  const next = applyInput(current, parsed);
  next.updatedAt = nowSec();
  validatePersona(next, anchorsOf(current));
  write(next, false);
  return requirePersona(id);
}

/** DELETE: status → archived. Files, assets and history stay. */
export function archivePersona(id: string): void {
  requirePersona(id);
  kolDb().prepare("UPDATE kol_personas SET status = 'archived', updated_at = ? WHERE id = ?").run(nowSec(), id);
}
