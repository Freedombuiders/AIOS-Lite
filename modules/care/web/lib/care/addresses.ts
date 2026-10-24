// Email address helpers for the reply composer. Deliberately small: the server validates the
// final addresses again (connector contract), this only builds a faithful preview.

export function extractAddress(raw: string): string {
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(raw);
  return (angle ? angle[1] : raw).trim();
}

export function normalizeAddress(raw: string): string {
  return extractAddress(raw).toLowerCase();
}

export function uniqueAddresses(list: Iterable<string>, exclude: ReadonlySet<string> = new Set()): string[] {
  const seen = new Set<string>(exclude);
  const out: string[] = [];
  for (const raw of list) {
    const addr = extractAddress(raw);
    const key = addr.toLowerCase();
    if (!addr || seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

const NO_REPLY = /(^|[._-])(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster)([._-]|@)/i;

export function looksAutomated(address: string): boolean {
  return NO_REPLY.test(extractAddress(address));
}

export function replySubject(subject: string | undefined | null): string {
  const base = (subject ?? '').trim().replace(/^((re|fwd?|trả lời)\s*:\s*)+/i, '').trim();
  return base ? `Re: ${base}` : 'Re:';
}
