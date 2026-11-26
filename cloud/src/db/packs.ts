/** D1 rows and JSON shapes for packs and releases. */
import type { ApiPack, ApiRelease } from '../../../packages/api-types/src/index';
import type { Env } from '../env';
import type { PackManifest, PackModule } from '../packs/format';
import { compareSemver } from '../packs/format';

export type ReleaseStatus = 'pending' | 'draft' | 'published' | 'yanked';

export interface PackRow {
  id: string;
  module: PackModule;
  name: string;
  summary: string | null;
  industry: string | null;
  cover_key: string | null;
  visibility: 'public' | 'unlisted';
  created_at: number;
  updated_at: number;
}

export interface ReleaseRow {
  id: string;
  pack_id: string;
  version: string;
  r2_key: string;
  size: number | null;
  sha256: string | null;
  signature: string | null;
  key_id: string | null;
  manifest_json: string | null;
  notes_count: number | null;
  status: ReleaseStatus;
  created_at: number;
  published_at: number | null;
  yanked_at: number | null;
}

function iso(ms: number): string;
function iso(ms: number | null): string | null;
function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** Where an admin's upload lands; finalize copies it to `r2_key`, so the signed upload URL can never overwrite a checked release. */
export const incomingKey = (releaseId: string) => `incoming/packs/${releaseId}.zip`;
export const releaseKey = (packId: string, version: string) => `packs/${packId}/${version}.zip`;

export function manifestOf(r: ReleaseRow): PackManifest | null {
  return r.manifest_json ? (JSON.parse(r.manifest_json) as PackManifest) : null;
}

export function releaseJson(r: ReleaseRow): ApiRelease {
  const m = manifestOf(r);
  return {
    id: r.id,
    version: r.version,
    status: r.status,
    size: r.size,
    sha256: r.sha256,
    notesCount: r.notes_count,
    keyId: r.key_id,
    minAppVersion: m?.minAppVersion ?? null,
    license: m?.license ?? null,
    author: m?.author ?? null,
    createdAt: iso(r.created_at),
    publishedAt: iso(r.published_at),
    yankedAt: iso(r.yanked_at),
  };
}

export async function packJson(env: Env, p: PackRow): Promise<ApiPack> {
  return {
    id: p.id,
    module: p.module,
    name: p.name,
    summary: p.summary,
    industry: p.industry,
    visibility: p.visibility,
    coverUrl: p.cover_key ? await env.blobs.presignGet(p.cover_key, 24 * 3600) : null,
    createdAt: iso(p.created_at),
    updatedAt: iso(p.updated_at),
  };
}

/** The newest published (not yanked) release by semver. */
export function latestPublished(releases: ReleaseRow[]): ReleaseRow | undefined {
  return releases.filter((r) => r.status === 'published').sort((a, b) => compareSemver(b.version, a.version))[0];
}

export async function releasesOf(env: Env, packIds: string[]): Promise<Map<string, ReleaseRow[]>> {
  const out = new Map<string, ReleaseRow[]>();
  for (let i = 0; i < packIds.length; i += 50) {
    const chunk = packIds.slice(i, i + 50);
    const { results } = await env.db.prepare(
      `SELECT * FROM pack_releases WHERE pack_id IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).all<ReleaseRow>();
    for (const r of results) out.set(r.pack_id, [...(out.get(r.pack_id) ?? []), r]);
  }
  return out;
}
