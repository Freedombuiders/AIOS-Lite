import { FacebookIcon, InstagramIcon, LinkedInIcon, TikTokIcon, YouTubeIcon } from '@/components/BrandIcons';
import { platformMeta } from '@/lib/social-platforms';

const ICONS = { facebook: FacebookIcon, youtube: YouTubeIcon, instagram: InstagramIcon, tiktok: TikTokIcon, linkedin: LinkedInIcon };

/** The platform's brand mark, drawn at `size` px so it stays readable at a glance. */
export function PlatformBadge({ platform, size = 24 }: { platform?: string | null; size?: number }) {
  const p = platformMeta(platform);
  const Icon = ICONS[p.id];
  return (
    <span title={p.name} class="shrink-0 inline-flex" style={{ width: size, height: size }}>
      <Icon size={size} />
    </span>
  );
}
