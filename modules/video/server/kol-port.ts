/**
 * The one door from Video Studio to the KOL module. The KOL module (when enabled) offers its character,
 * generation, spend and posting services as `provides.videoHost` (shape: KolHost below); without it the
 * studio still edits footage and renders, and KOL-only steps explain what is missing.
 */
import type { ModuleContext } from '../../../src/modules/sdk.js';
import { moduleCtx } from './host.js';

export type Aspect = '1:1' | '4:5' | '3:4' | '2:3' | '9:16' | '16:9' | '5:4' | '4:3' | '3:2';

export interface PersonaDto {
  id: string;
  name: string;
  handle: string;
  status: string;
  tagline: string;
  niche: string;
  languages: string[];
  bio: string;
  audience: string;
  personality?: { traits?: string[]; values?: string[]; voiceTone?: string; writingStyle?: string; catchphrases?: string[]; do?: string[]; dont?: string[] };
  pillars: { name: string; description: string }[];
  identitySource: string;
  voiceId: string;
  brainAgent: string;
  avatarUrl?: string | null;
  [k: string]: unknown;
}

export interface KolAsset {
  id: string;
  personaId: string;
  kind: 'image' | 'video' | string;
  status: string;
  url: string;
  thumbUrl: string;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  createdAt: number;
  prompt?: string;
  tags?: string[];
  consistency?: { score?: number | null } | null;
}

export interface KolHost {
  listPersonaSummaries(): PersonaDto[];
  getPersona(id: string): PersonaDto | null;
  listAssets(q: { personaId: string; kind: string; limit?: number }): { assets: KolAsset[] };
  getAsset(id: string): KolAsset | null;
  getAssetFile(id: string): { abs: string; mime: string; kind: string; durationSec: number | null } | null;
  importAssetFromUpload(personaId: string, file: string, opts: { status?: string; tags?: string[]; fileName?: string }): Promise<{ id: string }>;
  createPost(personaId: string, input: Record<string, unknown>, meta: Record<string, unknown>): { id: string };
  loadSettings(): { priceOverrides: Record<string, number>; [k: string]: unknown };
  voiceConfigured(): boolean;
  unitPriceUsd(model: string, opts: { audio?: boolean }, overrides?: Record<string, number>): { usd: number; unit: string | null } | null;
  findModel(id: string): { id: string; durations?: number[]; [k: string]: unknown } | undefined;
  isProviderConfigured(provider: string): boolean;
  getAdapter(provider: string): any;
  requestGeneration(input: Record<string, unknown>, requestedBy: string): { id: string };
  getGeneration(id: string): { status: string; error: string; assetIds: string[]; costUsd: number } | null;
  downloadOutput(out: unknown, kind: string): Promise<{ bytes: Buffer }>;
  admission(spendId: string, estimateUsd: number): void;
  recordSpend(row: Record<string, unknown>): void;
}

let host: KolHost | undefined;
let resolver: (() => KolHost | undefined) | undefined;

/** Bind from the module context: looks the KOL module up lazily so enabling it later just works. */
export function bindKol(ctx: ModuleContext | null): void {
  host = undefined;
  resolver = ctx ? () => ctx.modules.get<{ videoHost?: KolHost }>('kol')?.videoHost : undefined;
}

/** Tests inject a fake host directly. */
export function setKolHost(h: KolHost | undefined): void {
  host = h;
  resolver = undefined;
}

export function kolHost(): KolHost | undefined {
  return host ?? resolver?.();
}

export const kolAvailable = (): boolean => Boolean(kolHost());

export class KolMissingError extends Error {
  constructor() { super('Cần bật module KOL để dùng nhân vật, tạo video AI và đăng bài.'); }
}

const need = (): KolHost => {
  const h = kolHost();
  if (!h) throw new KolMissingError();
  return h;
};

export const listPersonaSummaries = (): PersonaDto[] => kolHost()?.listPersonaSummaries() ?? [];
export const getPersona = (id: string): PersonaDto | null => kolHost()?.getPersona(id) ?? null;
export const listAssets: KolHost['listAssets'] = (q) => kolHost()?.listAssets(q) ?? { assets: [] };
export const getAsset: KolHost['getAsset'] = (id) => kolHost()?.getAsset(id) ?? null;
export const getAssetFile: KolHost['getAssetFile'] = (id) => kolHost()?.getAssetFile(id) ?? null;
export const importAssetFromUpload: KolHost['importAssetFromUpload'] = (p, f, o) => need().importAssetFromUpload(p, f, o);
export const createPost: KolHost['createPost'] = (p, i, m) => need().createPost(p, i, m);
export const loadSettings: KolHost['loadSettings'] = () => kolHost()?.loadSettings() ?? { priceOverrides: {} };
export const voiceConfigured = (): boolean => kolHost()?.voiceConfigured() ?? false;
export const unitPriceUsd: KolHost['unitPriceUsd'] = (m, o, ov) => kolHost()?.unitPriceUsd(m, o, ov) ?? null;
export const findModel: KolHost['findModel'] = (id) => kolHost()?.findModel(id);
export const isProviderConfigured = (provider: string): boolean => kolHost()?.isProviderConfigured(provider) ?? false;
export const getAdapter = (provider: string): any => need().getAdapter(provider);
export const requestGeneration: KolHost['requestGeneration'] = (i, by) => need().requestGeneration(i, by);
export const getGeneration: KolHost['getGeneration'] = (id) => kolHost()?.getGeneration(id) ?? null;
export const downloadOutput: KolHost['downloadOutput'] = (o, k) => need().downloadOutput(o, k);
export const admission: KolHost['admission'] = (s, e) => need().admission(s, e);
export const recordSpend: KolHost['recordSpend'] = (r) => need().recordSpend(r);

// ── Agent turns (module-local: same JSON-answer contract as the KOL writer) ──

export interface AgentTextResult { text: string; model: string; costUsd: number; error?: string }
export interface AgentTurnInput { agentId: string; usageKey: string; system: string; prompt: string }
export type AgentRunner = (input: AgentTurnInput) => Promise<AgentTextResult>;


/** Brain id meaning "Codex on the owner's ChatGPT plan" in the owner's build; here it maps to the main agent. */
export const CHATGPT_BRAIN = '@chatgpt';

/** One lean agent turn through the engine (access, runs and cost still apply). */
export const runKolAgent: AgentRunner = async (input) => {
  const leanCtx = moduleCtx();
  if (!leanCtx) return { text: '', model: '', costUsd: 0, error: 'Module video chưa chạy.' };
  const agentId = !input.agentId || input.agentId === CHATGPT_BRAIN ? 'main' : input.agentId;
  const r = await leanCtx.agents.runLean({
    agentId,
    title: input.usageKey.slice(0, 80),
    prompt: `${input.system}\n\n${input.prompt}`,
  });
  return { text: r.output, model: leanCtx.agents.get(agentId)?.model ?? '', costUsd: r.usage?.costUsd ?? 0, ...(r.ok ? {} : { error: r.error ?? 'Lượt agent thất bại.' }) };
};

export function untrusted(text: string): string {
  return `<untrusted>\n${text.replace(/<\/?untrusted/gi, (m) => m.replace('<', '‹'))}\n</untrusted>`;
}

/** Every JSON object in the agent's answer (fenced or bare), in order. */
export function jsonObjectsOf(raw: string): unknown[] {
  const candidates: string[] = [];
  for (const m of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1].trim());
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    for (let j = i; j < raw.length; j++) {
      const ch = raw[j];
      if (inStr) {
        if (ch === '\\') j++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { candidates.push(raw.slice(i, j + 1)); i = j; break; }
    }
  }
  const out: unknown[] = [];
  for (const c of new Set(candidates.map((x) => x.trim()))) {
    try { out.push(JSON.parse(c)); } catch { /* not JSON */ }
  }
  return out;
}

const list = (a?: string[]) => (a?.length ? a.join(', ') : '(chưa ghi)');

export function personaVoiceBlock(persona: PersonaDto): string {
  const p = persona.personality;
  return [
    `Tên: ${persona.name}${persona.handle ? ` (${persona.handle})` : ''}`,
    `Lĩnh vực: ${persona.niche || '(chưa ghi)'}; khẩu hiệu: ${persona.tagline || '(không có)'}`,
    `Khán giả: ${persona.audience || '(chưa ghi)'}`,
    `Tính cách: ${list(p?.traits)}; giá trị: ${list(p?.values)}`,
    `Giọng điệu: ${p?.voiceTone || '(chưa ghi)'}`,
    `Cách viết: ${p?.writingStyle || '(chưa ghi)'}`,
    `Câu cửa miệng: ${list(p?.catchphrases)}`,
    `Nên: ${list(p?.do)}`,
    `Không bao giờ: ${list(p?.dont)}`,
    `Trụ cột nội dung: ${persona.pillars.map((x) => `${x.name} — ${x.description}`).join(' | ') || '(chưa có)'}`,
  ].join('\n');
}
