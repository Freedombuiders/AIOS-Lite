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
