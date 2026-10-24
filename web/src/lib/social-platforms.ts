/** The social platforms the app knows about. Content only exists for Facebook today; the rest are ready for when it does. */
export type SocialPlatform = 'facebook' | 'youtube' | 'instagram' | 'tiktok' | 'linkedin';

export const PLATFORMS: { id: SocialPlatform; name: string; mark: string; color: string }[] = [
  { id: 'facebook', name: 'Facebook', mark: 'f', color: '#4c8dff' },
  { id: 'youtube', name: 'YouTube', mark: '▶', color: '#ff5a4f' },
  { id: 'instagram', name: 'Instagram', mark: 'IG', color: '#c77dff' },
  { id: 'tiktok', name: 'TikTok', mark: '♪', color: '#2ee6c8' },
  { id: 'linkedin', name: 'LinkedIn', mark: 'in', color: '#3aa0e8' },
];

export const platformMeta = (id: string | null | undefined) => PLATFORMS.find((p) => p.id === id) ?? PLATFORMS[0];
