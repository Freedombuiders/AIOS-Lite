interface BrandIconProps {
  size?: number;
  class?: string;
}

/** Local vector marks stay crisp in both the full sidebar and the icon rail. */
export function ZaloIcon({ size = 26, class: className }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" class={className} fill="none" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#0068FF" />
      <path d="M5 7h22v15a4 4 0 0 1-4 4H12l-6 3 1-5a5 5 0 0 1-2-4V7Z" fill="white" />
      <g fill="#0068FF" transform="translate(1 1) scale(.88)">
        <path d="M8 12h6v1.5l-4 5h4V20H8v-1.5l4-5H8V12Z" />
        <path fill-rule="evenodd" d="M18 14a3 3 0 1 0 0 6c.7 0 1.3-.3 1.7-.8v.8H21v-6h-1.3v.8c-.4-.5-1-.8-1.7-.8Zm.2 1.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z" clip-rule="evenodd" />
        <path d="M22 12h1.5v8H22z" />
        <path fill-rule="evenodd" d="M27 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 1.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z" clip-rule="evenodd" transform="translate(-1)" />
      </g>
    </svg>
  );
}

export function FacebookIcon({ size = 26, class: className }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" class={className} fill="none" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#0866FF" />
      <path d="M18.5 32V19.5h4.2l.6-4.9h-4.8v-3.1c0-1.4.4-2.4 2.4-2.4h2.6V4.7c-.5-.1-2-.2-3.8-.2-3.7 0-6.2 2.3-6.2 6.4v3.7H9.3v4.9h4.2V32h5Z" fill="white" />
    </svg>
  );
}

export function YouTubeIcon({ size = 26, class: className }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" class={className} fill="none" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#FF0000" />
      <rect x="4.5" y="8.5" width="23" height="15" rx="4.5" fill="white" />
      <path d="M13.5 12.5v7l6-3.5-6-3.5Z" fill="#FF0000" />
    </svg>
  );
}

export function InstagramIcon({ size = 26, class: className }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" class={className} fill="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="ig-grad" x1="3" y1="29" x2="29" y2="3" gradientUnits="userSpaceOnUse">
          <stop stop-color="#FFC857" />
          <stop offset=".35" stop-color="#F9423B" />
          <stop offset=".7" stop-color="#C13584" />
          <stop offset="1" stop-color="#6A3DE8" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#ig-grad)" />
      <rect x="7" y="7" width="18" height="18" rx="5.5" stroke="white" stroke-width="2.4" />
      <circle cx="16" cy="16" r="4.2" stroke="white" stroke-width="2.4" />
      <circle cx="21.4" cy="10.6" r="1.4" fill="white" />
    </svg>
  );
}

export function TikTokIcon({ size = 26, class: className }: BrandIconProps) {
  const note = 'M17.5 6h3.2c.3 2.5 1.8 4.1 4.3 4.4v3.2c-1.6 0-3.1-.5-4.3-1.4v6.5a6.2 6.2 0 1 1-6.2-6.2c.3 0 .6 0 .9.1v3.3a3 3 0 1 0 2.1 2.8V6Z';
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" class={className} fill="none" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#000000" />
      <path d={note} fill="#25F4EE" transform="translate(-1 -1)" />
      <path d={note} fill="#FE2C55" transform="translate(1 1)" />
      <path d={note} fill="white" />
    </svg>
  );
}

export function LinkedInIcon({ size = 26, class: className }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" class={className} fill="none" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#0A66C2" />
      <circle cx="9.6" cy="9.8" r="2.2" fill="white" />
      <rect x="7.6" y="13.2" width="4" height="11.2" fill="white" />
      <path d="M14 13.2h3.8v1.6c.7-1.1 2-1.9 3.8-1.9 3.5 0 4.4 2.3 4.4 5.4v6.1h-4v-5.4c0-1.4-.1-2.7-1.8-2.7-1.8 0-2.2 1.3-2.2 2.7v5.4h-4V13.2Z" fill="white" />
    </svg>
  );
}

export function WhopIcon({ size = 26, class: className }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" class={className} fill="none" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#FA4616" />
      <path d="M5.5 11.5 9.8 21l4.3-9.5M12.8 11.5l4.3 9.5 4.3-9.5M20.1 11.5l4.3 9.5 2.6-5.8" stroke="white" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
