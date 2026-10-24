// Turns <aios-*> directive tags in agent output into short labels so raw markup never reaches the UI.
export type DirectiveSegment = { kind: 'text'; text: string } | { kind: 'chip'; label: string };

const TAG = /<aios-(task|memory|status|action)\b([^>]*)>([\s\S]*?)<\/aios-\1>/gi;
// An opening tag whose closing half has not streamed in yet (or a stray closing tag).
const DANGLING = /<\/?aios-(?:task|memory|status|action)\b[\s\S]*$|<\/?aios(?:-[a-z]*)?$|<\/?$/i;

function attr(src: string, name: string): string | undefined {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(src);
  return m ? (m[1] ?? m[2]) : undefined;
}

function label(kind: string, a: string): string {
  switch (kind.toLowerCase()) {
    case 'task': return `Giao việc cho ${attr(a, 'to') ?? 'agent khác'}`;
    case 'memory': return attr(a, 'scope')?.toLowerCase() === 'team' ? 'Ghi nhớ cho cả nhóm' : 'Ghi nhớ';
    case 'status': return 'Xin duyệt';
    default: return `Hành động ${[attr(a, 'module'), attr(a, 'name')].filter(Boolean).join('.')}`.trim();
  }
}

export function splitDirectives(input: string): DirectiveSegment[] {
  const out: DirectiveSegment[] = [];
  let last = 0;
  for (const m of input.matchAll(TAG)) {
    if (m.index > last) out.push({ kind: 'text', text: input.slice(last, m.index) });
    out.push({ kind: 'chip', label: label(m[1]!, m[2] ?? '') });
    last = m.index + m[0].length;
  }
  let rest = input.slice(last);
  const open = /<aios-(task|memory|status|action)\b([^>]*)>?/i.exec(rest);
  if (open && open.index !== undefined) {
    // streaming: the tag opened but has no end yet, show it as a chip while it is being written
    if (open.index > 0) out.push({ kind: 'text', text: rest.slice(0, open.index) });
    out.push({ kind: 'chip', label: label(open[1]!, open[2] ?? '') });
    rest = '';
  } else {
    rest = rest.replace(DANGLING, '');
  }
  if (rest) out.push({ kind: 'text', text: rest });
  return out;
}

/** Plain text with every directive removed (for finished results). */
export function stripDirectives(input: string): string {
  return splitDirectives(input).filter((s) => s.kind === 'text').map((s) => (s as { text: string }).text).join('').trim();
}
