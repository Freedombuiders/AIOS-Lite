// Small display helpers care needs (timestamps are unix milliseconds). Local so care does not reach into other modules.

function pad(n: number): string { return String(n).padStart(2, '0'); }

/** `14:05` today, `24/10 14:05` on another day. */
export function clockTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hm}`;
}

/** `24/10/2026 14:05`. */
export function fullTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `vừa xong`, `5 phút`, `3 giờ`, `2 ngày`, then the date. */
export function relTime(ms: number | null | undefined, now = Date.now()): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'vừa xong';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} phút`;
  if (s < 86400) return `${Math.round(s / 3600)} giờ`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} ngày`;
  const d = new Date(ms);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
