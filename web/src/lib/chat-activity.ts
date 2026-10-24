// What an agent did while answering one chat turn, shown as
// "Thought for 3s" rows between the paragraphs of its reply. The server
// records it (src/chat-activity.ts) and sends it on assistant_message and
// in chat history; while a turn runs, the view rebuilds the same shape
// from the live progress and assistant_delta events.

export interface TurnActivityStep { id: string; label: string; kind?: string; status?: string; atMs: number }
/** `offset` is the character position in the reply the group sits before. */
export interface TurnActivityGroup { offset: number; startMs: number; durationMs: number; steps: TurnActivityStep[] }
export interface TurnActivity { v: 1; durationMs: number; groups: TurnActivityGroup[] }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** History rows carry the activity as an object (or, from older servers, a
 *  JSON string); anything malformed is dropped rather than half-rendered. */
export function normalizeActivity(raw: unknown): TurnActivity | undefined {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  if (!value || typeof value !== 'object' || !Array.isArray((value as TurnActivity).groups)) return undefined;
  const groups = (value as TurnActivity).groups
    .filter((g) => g && typeof g === 'object')
    .map((g) => ({
      offset: Math.max(0, num(g.offset)),
      startMs: num(g.startMs),
      durationMs: Math.max(0, num(g.durationMs)),
      steps: (Array.isArray(g.steps) ? g.steps : [])
        .filter((s) => s && typeof s.label === 'string')
        .map((s, i) => ({ id: String(s.id ?? i), label: s.label, kind: s.kind, status: s.status, atMs: num(s.atMs) })),
    }));
  if (groups.length === 0) return undefined;
  return { v: 1, durationMs: num((value as TurnActivity).durationMs), groups };
}

export type ReplySegment =
  | { type: 'text'; text: string }
  | { type: 'group'; group: TurnActivityGroup };

/** Move an offset to a place where splitting the markdown is safe: the
 *  end of a paragraph, and never inside a fenced code block. */
function safeSplitPoint(content: string, offset: number): number {
  let at = Math.min(Math.max(0, offset), content.length);
  if (at === 0 || at === content.length) return at;
  const fencesBefore = content.slice(0, at).match(/```/g)?.length ?? 0;
  if (fencesBefore % 2 === 1) {
    const close = content.indexOf('```', at);
    if (close === -1) return content.length;
    at = close + 3;
  }
  // Already on a line break boundary (text before ends a line)?
  if (content[at - 1] === '\n' || content[at] === '\n') return at;
  const nextBreak = content.indexOf('\n', at);
  return nextBreak === -1 ? content.length : nextBreak;
}

/** Interleave reply text with its thought groups. */
export function splitReply(content: string, activity: TurnActivity | undefined): ReplySegment[] {
  if (!activity || activity.groups.length === 0) return content ? [{ type: 'text', text: content }] : [];
  const segments: ReplySegment[] = [];
  let cursor = 0;
  const groups = [...activity.groups].sort((a, b) => a.offset - b.offset);
  for (const group of groups) {
    const at = Math.max(cursor, safeSplitPoint(content, group.offset));
    const text = content.slice(cursor, at);
    if (text.trim()) segments.push({ type: 'text', text });
    segments.push({ type: 'group', group });
    cursor = at;
  }
  const tail = content.slice(cursor);
  if (tail.trim()) segments.push({ type: 'text', text: tail });
  return segments;
}

/** "3s", "1m 05s". Anything under a second still reads as 1s. */
export function formatThoughtDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

// ── Live turn ────────────────────────────────────────────────────────

export interface LiveProgressEvent {
  description: string;
  progressKind?: string;
  status?: string;
  kind?: string;
  toolCallId?: string;
}

/** A turn in flight. Times are absolute (Date.now()) so the view can tick. */
export interface LiveTurn {
  startedAt: number;
  text: string;
  lastTextAt: number;
  /** Groups closed by later text; the open one is `current`. */
  groups: TurnActivityGroup[];
  current: TurnActivityGroup | null;
  agentId?: string;
}

export function startLiveTurn(now = Date.now(), agentId?: string): LiveTurn {
  return { startedAt: now, text: '', lastTextAt: now, groups: [], current: null, agentId };
}

function stepId(ev: LiveProgressEvent, now: number): string {
  if (ev.toolCallId) return `tool:${ev.toolCallId}`;
  if (ev.progressKind === 'plan') return 'plan';
  return `p:${now}:${ev.description}`;
}

export function liveProgress(turn: LiveTurn, ev: LiveProgressEvent, now = Date.now()): LiveTurn {
  const current = turn.current ?? {
    offset: turn.text.length,
    startMs: turn.lastTextAt - turn.startedAt,
    durationMs: 0,
    steps: [],
  };
  const id = stepId(ev, now);
  const idx = current.steps.findIndex((s) => s.id === id);
  let steps: TurnActivityStep[];
  if (idx === -1) {
    steps = [...current.steps, { id, label: ev.description, kind: ev.kind ?? kindFromProgress(ev), status: ev.status, atMs: now - turn.startedAt }];
  } else {
    steps = current.steps.map((s, i) => {
      if (i !== idx) return s;
      const relabel = s.kind === 'subagent' || ev.status === 'failed' || id === 'plan';
      return { ...s, status: ev.status ?? s.status, label: relabel ? ev.description : s.label };
    });
  }
  return { ...turn, current: { ...current, steps: steps.slice(-40) } };
}

function kindFromProgress(ev: LiveProgressEvent): string | undefined {
  if (ev.progressKind === 'plan') return 'plan';
  return undefined;
}

export function liveText(turn: LiveTurn, text: string, now = Date.now()): LiveTurn {
  if (text.length <= turn.text.length) return text === turn.text ? turn : { ...turn, text };
  const groups = turn.current
    ? [...turn.groups, { ...turn.current, durationMs: now - turn.startedAt - turn.current.startMs }]
    : turn.groups;
  return { ...turn, text, lastTextAt: now, groups, current: null };
}
