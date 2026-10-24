// Display helpers (Vietnamese). Missing numbers mean "unknown", never zero.
const agentNames = new Map<string, string>();

export function seedAgentNames(agents: Array<{ id: string; name?: string }>): void {
  for (const a of agents) if (a.name) agentNames.set(a.id, a.name);
}

export function resolveAgentName(agentId: string): string {
  return agentNames.get(agentId) ?? agentId;
}

export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || Number.isNaN(usd)) return '—';
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(usd < 10 ? 2 : 1)}`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}p ${s % 60}s`;
  return `${Math.floor(m / 60)}g ${m % 60}p`;
}

/** Accepts ISO strings or unix seconds. */
export function formatRelativeTime(input: string | number | null | undefined, now = Date.now()): string {
  if (input === null || input === undefined || input === '') return '—';
  const t = typeof input === 'number' ? input * 1000 : Date.parse(input);
  if (Number.isNaN(t)) return '—';
  const diff = Math.round((now - t) / 1000);
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? 'trước' : 'nữa';
  if (abs < 45) return diff >= 0 ? 'vừa xong' : 'sắp tới';
  if (abs < 3600) return `${Math.round(abs / 60)} phút ${suffix}`;
  if (abs < 86400) return `${Math.round(abs / 3600)} giờ ${suffix}`;
  if (abs < 86400 * 30) return `${Math.round(abs / 86400)} ngày ${suffix}`;
  return formatDateTime(t);
}

export function formatDateTime(input: string | number | null | undefined): string {
  if (input === null || input === undefined) return '—';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Lowercase + strip Vietnamese diacritics so search ignores accents. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}
