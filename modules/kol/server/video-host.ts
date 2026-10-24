/**
 * `provides.videoHost`: the KOL services the Video module uses (its interface: modules/video/server/kol-port.ts,
 * matched structurally, no video code imported). Media urls are rewritten to the mounted /api/m/kol prefix because
 * the video pages use them directly as <img>/<video> src.
 */
import { getAsset, getAssetFile, importAssetFromUpload, listAssets } from './assets.js';
import { loadSettings } from './core.js';
import { downloadOutput, getGeneration, requestGeneration } from './generations.js';
import { getPersona, listPersonaSummaries } from './personas.js';
import { unitPriceUsd } from './pricing.js';
import { createPost } from './posts.js';
import { findModel, getAdapter, isProviderConfigured } from './providers/index.js';
import { admission, recordSpend } from './spend.js';
import { voiceConfigured } from './voice.js';

const mount = (url: string | null | undefined): string => (url ? url.replace(/^\/api\/kol\//, '/api/m/kol/') : '');

function withUrls<T extends { url: string; thumbUrl: string | null }>(a: T): T & { thumbUrl: string } {
  return { ...a, url: mount(a.url), thumbUrl: mount(a.thumbUrl ?? a.url) };
}

export function createVideoHost() {
  return {
    listPersonaSummaries: () => listPersonaSummaries().flatMap((s) => {
      const p = getPersona(s.id);
      return p ? [{ ...p, avatarUrl: mount(s.avatarUrl) || null }] : [];
    }),
    getPersona: (id: string) => {
      const p = getPersona(id);
      return p ? { ...p, avatarUrl: mount(listPersonaSummaries().find((s) => s.id === id)?.avatarUrl) || null } : null;
    },
    listAssets: (q: Parameters<typeof listAssets>[0]) => ({ assets: listAssets(q).assets.map(withUrls) }),
    getAsset: (id: string) => {
      const a = getAsset(id);
      return a ? withUrls(a) : null;
    },
    getAssetFile,
    importAssetFromUpload: async (personaId: string, file: string, opts: Parameters<typeof importAssetFromUpload>[2]) =>
      importAssetFromUpload(personaId, file, opts),
    createPost: (personaId: string, input: Parameters<typeof createPost>[1], meta: Parameters<typeof createPost>[2]) => createPost(personaId, input, meta),
    loadSettings,
    voiceConfigured,
    unitPriceUsd,
    findModel: (id: string) => findModel(id) ?? undefined,
    isProviderConfigured: (provider: string) => isProviderConfigured(provider as never),
    getAdapter: (provider: string) => getAdapter(provider as never),
    requestGeneration,
    getGeneration,
    downloadOutput: (out: unknown, kind: string) => downloadOutput(out as never, kind as never),
    admission,
    recordSpend,
  };
}
