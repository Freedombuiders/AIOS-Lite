/** Tiny HTML helpers: everything interpolated through `html` is escaped unless it is already `Raw`. */

export class Raw {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function raw(value: string): Raw {
  return new Raw(value);
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };

/** Escape text or an attribute value. */
export function esc(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESC[c]);
}

type Part = Raw | string | number | null | undefined | false | Part[];

function partToString(part: Part): string {
  if (part === null || part === undefined || part === false) return '';
  if (part instanceof Raw) return part.value;
  if (Array.isArray(part)) return part.map(partToString).join('');
  return esc(part);
}

/** Tagged template: strings are escaped, `Raw` values and arrays of them pass through. */
export function html(strings: TemplateStringsArray, ...parts: Part[]): Raw {
  let out = strings[0];
  for (let i = 0; i < parts.length; i++) out += partToString(parts[i]) + strings[i + 1];
  return new Raw(out);
}

/** Join pieces into one Raw (children of an element). */
export function cat(parts: Part[]): Raw {
  return new Raw(partToString(parts));
}

/** Only http(s) urls become links; anything else (javascript:, data:) turns into "#". */
export function safeUrl(url: string | undefined | null): string {
  const u = (url ?? '').trim();
  return /^https?:\/\//i.test(u) ? u : '#';
}

/** `<a>` to a source on another site: new tab, no opener. Unsafe urls render nothing. */
export function extLink(cls: string, url: string | undefined, label: Part): Raw {
  if (!url || safeUrl(url) === '#') return new Raw('');
  return html`<a class="${cls}" href="${safeUrl(url)}" target="_blank" rel="noopener">${label} <span>↗</span></a>`;
}

/** JSON for a `<script type="application/json">`: `<` and line separators escaped so it cannot close the tag. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Small inline source link used by the cards of tabs C and D: "xem ↗" (no span around the arrow). */
export function textLink(cls: string, url: string | undefined, label: string): Raw {
  if (!url || safeUrl(url) === '#') return new Raw('');
  return html`<a class="${cls}" href="${safeUrl(url)}" target="_blank" rel="noopener">${label} ↗</a>`;
}
