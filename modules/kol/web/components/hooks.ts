import { useEffect, useMemo, useState } from 'preact/hooks';
import { apiFail } from '@modules/kol/web/components/shared/ops-shared';
import { useFetch } from '@/lib/useFetch';
import {
  KOL, isActiveGeneration, kolApi,
  type AssetDto, type GenerationDto, type GenerationRequest, type PromptPreviewDto,
} from '@modules/kol/web/lib/kol';

/** Debounced POST /api/m/kol/preview (no spend). Pass null to skip. */
export function usePreview(req: GenerationRequest | null, delayMs = 400) {
  const key = req ? JSON.stringify(req) : '';
  const [preview, setPreview] = useState<PromptPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!key) { setPreview(null); setError(null); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      kolApi.preview(JSON.parse(key) as GenerationRequest)
        .then((p) => { if (!cancelled) { setPreview(p); setError(null); } })
        .catch((err) => { if (!cancelled) setError(apiFail(err).message); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, delayMs);
    return () => { cancelled = true; clearTimeout(t); };
  }, [key, delayMs]);
  return { preview, error, loading };
}

/** Recent generations of a persona, polled every 3 s while any is queued/running. */
export function useGenerations(personaId: string, limit = 24) {
  const path = KOL.generations({ personaId, limit });
  const [active, setActive] = useState(false);
  const res = useFetch<{ generations: GenerationDto[] }>(path, active ? 3000 : 0);
  const list = res.data?.generations ?? [];
  const anyActive = list.some(isActiveGeneration);
  useEffect(() => { setActive(anyActive); }, [anyActive]);
  return { ...res, generations: list, anyActive };
}

/** One generation with its assets, polled every 3 s until it finishes. */
export function useGeneration(id: string | null) {
  const [done, setDone] = useState(false);
  const res = useFetch<{ generation: GenerationDto; assets: AssetDto[] }>(id ? KOL.generation(id) : null, done ? 0 : 3000);
  const g = res.data?.generation;
  const finished = !!g && g.id === id && !isActiveGeneration(g);
  useEffect(() => { setDone(finished); }, [finished, id]);
  return res;
}

/**
 * Assets of a persona by id (latest 60), refreshed whenever `version` changes
 * (e.g. the set of finished generation ids).
 */
export function useAssetIndex(personaId: string, version: string) {
  const [assets, setAssets] = useState<AssetDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    kolApi.assets({ personaId, limit: 60 })
      .then((r) => { if (!cancelled) { setAssets(r.assets); setError(null); } })
      .catch((err) => { if (!cancelled) setError(apiFail(err).message); });
    return () => { cancelled = true; };
  }, [personaId, version]);
  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const patch = (a: AssetDto) => setAssets((cur) => cur.map((x) => (x.id === a.id ? a : x)));
  const drop = (id: string) => setAssets((cur) => cur.filter((x) => x.id !== id));
  return { assets, byId, error, patch, drop };
}
