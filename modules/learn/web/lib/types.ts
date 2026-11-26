// Shapes of /api/m/learn responses (server: modules/learn/server/routes.ts and stats.ts). Keep in step with them.

export type SyncState = 'ok' | 'no-folder' | 'folder-missing' | 'no-marketing';

export interface SyncStatus {
  state: SyncState;
  folder: string;
  cursor: number;
  backfilledFolder: string | null;
  notes: number;
  lastRunAt: number | null;
  lastError: string | null;
}

export interface Cell {
  n: number;
  posts: number;
  medianEr: number | null;
  lowSample: boolean;
  notTried: boolean;
  unmeasured: boolean;
}

export interface Group extends Cell {
  key: string;
  label: string;
}

export interface Axis {
  key: string;
  label: string;
}

export interface PostRow {
  path: string;
  title: string;
  format: string;
  formatLabel: string;
  pillar: string;
  hook: string;
  hookLabel: string;
  length: string | null;
  publishedAt: string | null;
  reach: number | null;
  er: number | null;
  measured: string[];
}

export interface ContentLabStats {
  moc: string;
  days: number;
  platform: string;
  totals: { posts: number; measured: number };
  matrix: { rows: Axis[]; cols: Axis[]; cells: Cell[][] };
  byHook: Group[];
  byLength: Group[];
  posts: PostRow[];
}

export interface MocOption {
  value: string;
  label: string;
}

export interface ContentLabDto {
  status: SyncStatus;
  dir: string;
  mocs: MocOption[];
  stats: ContentLabStats | null;
}

export interface Sample {
  n: number;
  medianEr: number | null;
  lowSample: boolean;
}

export interface PostComparison {
  moc: string;
  mocLabel: string;
  er: number | null;
  reach: number | null;
  others: Sample;
  sameFormat: Sample & { label: string };
  diffPct: number | null;
}

export interface PostDto {
  folder: string;
  path: string;
  data: Record<string, unknown>;
  body: string;
  comparison: PostComparison | null;
  mocs: MocOption[];
  days: number;
}

export interface BrainFolderView {
  id: string;
  name: string;
  path: string;
}

// ── learning loop (server: routes-loop.ts, playbook.ts, weekly.ts, score-draft.ts) ─────────────────────────────

export type LessonState = 'gia-thuyet' | 'dang-thu' | 'da-kiem-chung' | 'bi-bac-bo';
export type Area = 'noi-dung' | 'cham-khach' | 'quang-cao';

export interface EvidenceView {
  link: string;
  path: string | null;
  title: string | null;
  live: boolean;
  er: number | null;
}

export interface TrialView {
  posts: number;
  measured: number;
  threshold: number;
  medianEr: number | null;
  channelMedian: number | null;
  channelN: number;
  moc: string;
  label: string;
  verdict: 'chua-du' | 'dat' | 'khong-dat' | 'on-dinh' | 'giam';
  recent: Array<{ path: string; title: string; er: number | null; below: boolean | null }>;
}

export interface LessonView {
  path: string;
  title: string;
  summary: string;
  state: LessonState;
  stateLabel: string;
  area: Area | null;
  areaLabel: string;
  platform: string;
  usedBy: string[];
  evidence: EvidenceView[];
  liveEvidence: number;
  ruleText: string[];
  trial: TrialView | null;
  ownerVerified: boolean;
  proposedBy: string | null;
  changedAt: string | null;
}

export interface PlaybookDto {
  folder: string;
  dir: string;
  moc: string;
  minEvidence: number;
  states: Array<{ key: LessonState; label: string }>;
  lessons: LessonView[];
  agents: Array<{ id: string; name: string; canRead: boolean }>;
}

export interface ProposalView {
  id: number;
  kind: 'new' | 'transition';
  path: string;
  title: string;
  from: LessonState | null;
  to: LessonState | null;
  reason: string;
  proposedBy: string;
  createdAt: number;
  lesson: LessonView | null;
}

export interface DraftStats {
  botDrafts: number;
  sentUnchanged: number;
  sentEdited: number;
  discarded: number;
  notDelivered: number;
  open: number;
  unchangedRate: number | null;
}

export interface WeekPoint {
  year: number;
  week: number;
  from: string;
  to: string;
  posts: number;
  measured: number;
  medianEr: number | null;
  drafts: DraftStats | null;
  running: boolean;
}

export interface LessonChange {
  path: string;
  title: string;
  from: LessonState | null;
  to: LessonState;
  actor: string;
  reason: string;
  at: number;
}

export interface LoopDto {
  folder: string;
  moc: string;
  mocLabel: string;
  careEnabled: boolean;
  weeks: WeekPoint[];
  counts: Record<LessonState, number>;
  lessons: number;
  inUse: number;
  measuredPosts: number;
  posts: number;
  changes: LessonChange[];
  testing: Array<{ path: string; title: string; measured: number; threshold: number; label: string }>;
  pending: number;
}

export interface WeeklyRow {
  year: number;
  week: number;
  path: string;
  from: string;
  to: string;
  medianEr: number | null;
  posts: number | null;
  newLessons: number | null;
  approved: boolean;
}

export interface PlanLine {
  viec: string;
  ly_do: string;
  agent?: string;
}

export interface WeeklyNoteDto {
  year: number;
  week: number;
  path: string;
  from: string;
  to: string;
  data: Record<string, unknown>;
  body: string;
  plan: PlanLine[];
  approved: boolean;
  tasks: Array<{ line: number; taskId: number }>;
}

export interface RuleCheck {
  rule: string;
  ok: boolean | null;
  text: string;
}

export interface ScoreDto {
  state: 'ok' | 'no-folder';
  matched: number;
  checkable: number;
  lessons: Array<{ path: string; title: string; checks: RuleCheck[]; result: 'khop' | 'chua-khop' | 'chua-ro' }>;
  unchecked: Array<{ path: string; title: string }>;
  hook: { moDau: string | null; label: string | null; source: 'cache' | 'agent' | 'none'; note: string | null };
  needsHook: boolean;
}
