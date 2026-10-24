/** Shared data for the Video Studio views (cast + engines), and the Kết nối tab. */
import { useEffect, useState } from 'preact/hooks';

import '@modules/video/web/styles/video-production.css';
import { productionApi } from '@modules/video/web/lib/video-production-api';
import type { CastMember, EngineStatus } from '@modules/video/web/lib/video-production';
import { ConnectionsPanel } from './ConnectionsPanel';

export function useStudioData() {
  const [cast, setCast] = useState<CastMember[] | null>(null);
  const [engines, setEngines] = useState<EngineStatus[] | null>(null);
  const reload = () => {
    productionApi.cast().then((r) => setCast(r.cast)).catch(() => setCast([]));
    productionApi.engines().then((r) => setEngines(r.engines)).catch(() => setEngines([]));
  };
  useEffect(reload, []);
  return { cast, engines, reload };
}

export function ConnectionsStudio() {
  const { cast, engines, reload } = useStudioData();
  return <div class="vp"><ConnectionsPanel cast={cast} engines={engines} onChanged={reload} /></div>;
}
