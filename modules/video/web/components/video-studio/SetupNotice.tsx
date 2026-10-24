import { useEffect, useState } from 'preact/hooks';
import { TriangleAlert } from 'lucide-preact';
import { apiGet } from '@/lib/api';

interface Health { ffmpeg: boolean; ffprobe: boolean; hint: string | null; kol: boolean }

/** Shown above the studio while ffmpeg is missing: nothing can be cut or rendered without it. */
export function SetupNotice() {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    let alive = true;
    apiGet<Health>('/api/m/video/health').then((h) => { if (alive) setHealth(h); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  if (!health || (health.ffmpeg && health.ffprobe)) return null;
  return (
    <div role="alert" class="flex items-start gap-2 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,#f59e0b_14%,transparent)] px-4 py-2 text-[12.5px]">
      <TriangleAlert size={15} class="mt-0.5 shrink-0" />
      <span>
        <b>Chưa dựng được video trên máy này.</b> {health.hint ?? 'Chưa tìm thấy ffmpeg.'}
      </span>
    </div>
  );
}
