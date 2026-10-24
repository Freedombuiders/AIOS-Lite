export interface AgentAvatarProps {
  agentId: string;
  name?: string;
  size?: number;
  running?: boolean;
  cacheBust?: number | string;
}

function hue(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/** Initial letter on a colour derived from the agent id. */
export function AgentAvatar({ agentId, name, size = 28, running }: AgentAvatarProps) {
  const label = (name || agentId).trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      class="relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: `hsl(${hue(agentId)} 45% 42%)` }}
      title={name || agentId}
    >
      {label}
      {running && <span class="dot dot-success dot-pulse absolute -right-0.5 -bottom-0.5 ring-2 ring-[var(--color-card)]" />}
    </span>
  );
}
