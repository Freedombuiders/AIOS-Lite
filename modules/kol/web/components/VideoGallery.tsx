/**
 * Campaign videos of one KOL (kol-videos/personas/<kol>/<campaign>/ on disk, served by
 * /api/m/kol/videos). Lists every campaign; a KOL without videos gets a one-line empty state.
 */
import { useEffect, useState } from 'preact/hooks';
import { Film } from 'lucide-preact';
import { Pill } from '@/components/Pill';
import { media } from '@modules/kol/web/lib/kol';
import { useFetch } from '@/lib/useFetch';

type VariantKey = 'a' | 'b' | 'c';
type VideoStatus = 'draft' | 'ready' | 'published';

interface VideoAsset {
  id: string;
  variant: VariantKey;
  name: string;
  duration: number;
  resolution: string;
  aspectRatio: string;
  status: VideoStatus;
  script: string;
  tone: string;
  url: string;
}

interface VideoLibrary {
  campaign: string;
  title: string;
  description: string;
  totalVariants: number;
  pendingVariants: VariantKey[];
  variants: VideoAsset[];
  metadata: { eventDate: string; eventLocation: string; targetAudience: string[] };
}

const STATUS: Record<VideoStatus, { label: string; tone: 'done' | 'medium' | 'accent' }> = {
  ready: { label: 'Sẵn sàng', tone: 'done' },
  draft: { label: 'Bản nháp', tone: 'medium' },
  published: { label: 'Đã đăng', tone: 'accent' },
};

function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function CampaignCard({ library }: { library: VideoLibrary }) {
  const [selected, setSelected] = useState<VariantKey | null>(library.variants[0]?.variant ?? null);
  useEffect(() => setSelected(library.variants[0]?.variant ?? null), [library.campaign]);
  const video = library.variants.find((v) => v.variant === selected) ?? null;
  const { eventDate, eventLocation, targetAudience } = library.metadata;
  const meta = [eventLocation, eventDate && fmtDate(eventDate)].filter(Boolean).join(' · ');

  return (
    <div class="rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] p-3">
      <div class="mb-3">
        <h3 class="text-[13.5px] font-semibold text-[var(--color-text)]">{library.title}</h3>
        {meta && <p class="text-[12px] text-[var(--color-text-muted)]">{meta}</p>}
      </div>

      <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
        <div class="min-w-0">
          {video ? (
            <>
              <video
                key={video.id}
                src={media(video.url)}
                controls
                preload="metadata"
                class="block w-full max-h-[440px] rounded bg-black object-contain"
              />
              <div class="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
                <Pill tone={STATUS[video.status].tone}>{STATUS[video.status].label}</Pill>
                {video.duration > 0 && <span>{video.duration.toFixed(1)} giây</span>}
                {video.resolution && <span>· {video.resolution}</span>}
                {video.aspectRatio && <span>· {video.aspectRatio}</span>}
              </div>
              {video.script && (
                <p class="mt-2 rounded bg-[var(--color-card)] p-2 text-[12.5px] leading-relaxed text-[var(--color-text)]">{video.script}</p>
              )}
              {video.tone && <p class="mt-1 text-[11.5px] text-[var(--color-text-faint)]">Giọng điệu: {video.tone}</p>}
            </>
          ) : (
            <p class="py-6 text-center text-[12.5px] text-[var(--color-text-muted)]">Chưa có video nào được dựng cho chiến dịch này.</p>
          )}
        </div>

        <div class="flex flex-col gap-2">
          {library.variants.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => setSelected(v.variant)}
              aria-pressed={selected === v.variant}
              class={`rounded border px-2.5 py-2 text-left text-[12.5px] transition-colors ${
                selected === v.variant
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-text)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-control-hover)]'
              }`}
            >
              <span class="font-medium">Phiên bản {v.variant.toUpperCase()}</span>
              <span class="block truncate text-[11.5px] text-[var(--color-text-faint)]">{v.name}</span>
            </button>
          ))}
          {library.pendingVariants.length > 0 && (
            <p class="text-[11.5px] text-[var(--color-text-faint)]">
              Chưa dựng: {library.pendingVariants.map((k) => `phiên bản ${k.toUpperCase()}`).join(', ')}
            </p>
          )}
          {targetAudience.length > 0 && (
            <div class="flex flex-wrap gap-1 pt-1">
              {targetAudience.map((t) => <Pill key={t} tone="neutral">{t.replace(/_/g, ' ')}</Pill>)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function VideoGallery({ kolId }: { kolId: string }) {
  const { data, loading, error } = useFetch<{ campaigns: VideoLibrary[] }>(`/api/m/kol/videos/${encodeURIComponent(kolId)}`);
  const campaigns = data?.campaigns ?? [];

  if (loading && !data) return <p class="py-4 text-[12.5px] text-[var(--color-text-muted)]">Đang tải video…</p>;
  if (error) return <p class="py-4 text-[12.5px] text-[var(--color-status-failed)]">Không tải được video chiến dịch: {error}</p>;
  if (!campaigns.length) {
    return (
      <p class="flex items-center gap-2 py-2 text-[12.5px] text-[var(--color-text-muted)]">
        <Film size={14} aria-hidden="true" /> KOL này chưa có video chiến dịch nào.
      </p>
    );
  }
  return (
    <div class="flex flex-col gap-3">
      {campaigns.map((c) => <CampaignCard key={c.campaign} library={c} />)}
    </div>
  );
}
