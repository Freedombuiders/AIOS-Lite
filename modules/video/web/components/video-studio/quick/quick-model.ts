// Dựng nhanh: pure helpers behind the three screens (template filters, Thiết lập defaults and
// summaries, Đang dựng rows). No API calls and no signals here, so tests can feed plain data.
import type { QuickForm, TemplateSummary } from '@modules/video/web/lib/video-edit/quick-api';
import type {
  ProjectStep, QuickSettings, StepKey, StepStatus, VideoJob, VideoProject, VideoProjectSummary,
} from '@modules/video/web/lib/video-edit/types';

// ── Mẫu edit ──────────────────────────────────────────────────────────────────

/** Lowercase without Vietnamese marks, so "kien thuc" finds "Kiến thức". */
export function searchKey(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().trim();
}

export interface TemplateFilter { id: string; label: string }

/** Tất cả, Đã cài, then every tag, most used first (ties in card order). */
export function templateFilters(list: TemplateSummary[]): TemplateFilter[] {
  const count = new Map<string, number>();
  for (const t of sortTemplates(list)) for (const tag of t.tags) count.set(tag, (count.get(tag) ?? 0) + 1);
  const tags = [...count.keys()].sort((a, b) => (count.get(b) ?? 0) - (count.get(a) ?? 0));
  return [{ id: 'all', label: 'Tất cả' }, { id: 'installed', label: 'Đã cài' }, ...tags.map((tag) => ({ id: `tag:${tag}`, label: tag }))];
}

/** Template packs first, the wrapped legacy styles after; installed first within each. */
export function sortTemplates(list: TemplateSummary[]): TemplateSummary[] {
  const rank = (t: TemplateSummary) => (t.legacy ? 2 : 0) + (t.installed ? 0 : 1);
  return list.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map((x) => x.t);
}

export function filterTemplates(list: TemplateSummary[], filter: string, query: string): TemplateSummary[] {
  const q = searchKey(query);
  return sortTemplates(list).filter((t) => {
    if (filter === 'installed' && !t.installed) return false;
    if (filter.startsWith('tag:') && !t.tags.includes(filter.slice(4))) return false;
    return !q || searchKey([t.name, t.description, ...t.tags].join(' ')).includes(q);
  });
}

export type TemplateBadge = { label: string; tone: 'installed' | 'pro' | 'free' };

export function templateBadge(t: TemplateSummary): TemplateBadge {
  if (t.installed) return { label: 'Đã cài', tone: 'installed' };
  return t.tier === 'pro' ? { label: 'PRO', tone: 'pro' } : { label: 'Miễn phí', tone: 'free' };
}

/** The first installed template pack, else the first template. */
export function defaultTemplateId(list: TemplateSummary[]): string {
  return sortTemplates(list)[0]?.id ?? '';
}

// ── Thiết lập ─────────────────────────────────────────────────────────────────

export const CUT_LEVELS: readonly { id: QuickSettings['cutLevel']; label: string; hint: string }[] = [
  { id: 'nhe', label: 'Nhẹ', hint: 'Chỉ cắt lặng trên 0,8 giây, giữ nhịp thở' },
  { id: 'vua', label: 'Vừa', hint: 'Cắt lặng trên 0,4 giây và từ đệm' },
  { id: 'sat', label: 'Sát', hint: 'Bỏ gần hết chỗ lặng, nhịp nhanh' },
];

export const MUSIC_MODES: readonly { id: QuickSettings['music']['mode']; label: string; hint: string }[] = [
  { id: 'ai', label: 'AI chọn theo mẫu', hint: 'Theo mood của mẫu, tự giảm khi đang nói, nốt cuối trùng kết video' },
  { id: 'pick', label: 'Chọn bài trong thư viện', hint: 'Kho của tôi và nhạc CC0 có sẵn' },
  { id: 'none', label: 'Không dùng nhạc', hint: 'Chỉ giữ giọng nói và tiếng động' },
];

export function defaultForm(templateId: string, note = ''): QuickForm {
  return {
    autoCut: true,
    cutLevel: 'vua',
    templateId,
    assets: [],
    music: { mode: 'ai', duck: true, snapToBeat: false, endOnFinal: true },
    stock: true,
    note,
  };
}

/** Thiết lập reopened after an AI edit starts from what was sent last time. */
export function formFromQuick(q: QuickSettings): QuickForm {
  return {
    autoCut: q.autoCut,
    cutLevel: q.cutLevel,
    templateId: q.templateId,
    assets: q.assets.map((a) => ({ assetId: a.assetId, hint: a.hint ?? '' })),
    music: { ...q.music },
    stock: q.stock,
    note: q.note ?? '',
  };
}

const cutLabel = (level: QuickSettings['cutLevel']) => CUT_LEVELS.find((l) => l.id === level)?.label.toLowerCase() ?? '';

export interface PlanLine { label: string; hint: string; on: boolean }

/** The "AI sẽ làm" column. */
export function aiPlanLines(form: QuickForm, template: TemplateSummary | undefined): PlanLine[] {
  const total = form.assets.length;
  const described = form.assets.filter((a) => a.hint.trim()).length;
  const free = total - described;
  const assetHint = !total ? 'Chưa thêm tư liệu'
    : !described ? 'AI tự chọn chỗ chèn'
      : free ? `${described} có mô tả, ${free} để AI tự chọn chỗ` : `${described} có mô tả`;
  const scenes = !template?.legacy;
  return [
    { label: 'Chép lời tiếng Việt', hint: 'Mốc thời gian từng từ', on: true },
    { label: 'Cắt vấp và khoảng lặng', hint: form.autoCut ? `Mức ${cutLabel(form.cutLevel)}` : 'Đã tắt: giữ nguyên video', on: form.autoCut },
    { label: 'Chữ theo nhịp nói', hint: template ? `Theo mẫu ${template.name}` : 'Theo mẫu đã chọn', on: true },
    { label: 'Cảnh minh hoạ', hint: scenes ? 'Khi bạn kể quy trình hoặc so sánh trước–sau' : 'Mẫu cơ bản không có cảnh minh hoạ', on: scenes },
    { label: total ? `Chèn ${total} tư liệu của bạn` : 'Chèn tư liệu của bạn', hint: assetHint, on: total > 0 },
    { label: 'Tìm thêm cảnh trám', hint: form.stock ? 'Kho của tôi → Pexels' : 'Đã tắt', on: form.stock },
    { label: 'Nhạc và tiếng động', hint: form.music.mode === 'none' ? 'Chỉ tiếng động' : form.music.mode === 'pick' ? 'Bài bạn chọn' : 'AI chọn theo mẫu', on: true },
  ];
}

/** One line next to the AI edit button: "2 tư liệu · nhạc AI chọn · tự cắt vừa". */
export function setupSummary(form: QuickForm): string {
  const n = form.assets.length;
  const music = form.music.mode === 'none' ? 'không nhạc' : form.music.mode === 'pick' ? 'nhạc tự chọn' : 'nhạc AI chọn';
  return [n ? `${n} tư liệu` : 'không tư liệu', music, form.autoCut ? `tự cắt ${cutLabel(form.cutLevel)}` : 'không cắt'].join(' · ');
}

// ── Danh sách dự án ───────────────────────────────────────────────────────────

export type StatusTone = 'done' | 'running' | 'waiting' | 'failed' | 'idle';

export function projectStatus(p: Pick<VideoProjectSummary, 'busy' | 'status'>): { label: string; tone: StatusTone } {
  if (p.busy) return { label: 'AI đang dựng', tone: 'running' };
  switch (p.status) {
    case 'done': return { label: 'Đã xuất', tone: 'done' };
    case 'rendering': return { label: 'Đang xuất', tone: 'running' };
    case 'working': return { label: 'Đang xử lý', tone: 'running' };
    case 'waiting_approval': return { label: 'Chờ bạn xem', tone: 'waiting' };
    case 'failed': return { label: 'Lỗi', tone: 'failed' };
    default: return { label: 'Nháp', tone: 'idle' };
  }
}

/** 28.43 -> "28,4 giây" */
export function formatSeconds(sec: number): string {
  return `${(Math.round(sec * 10) / 10).toFixed(1).replace('.', ',')} giây`;
}

// ── Đang dựng ─────────────────────────────────────────────────────────────────

export type RowState = 'done' | 'running' | 'waiting' | 'pending' | 'failed' | 'skipped';

export interface ProgressRow {
  id: 'ingest' | 'transcribe' | 'cut' | 'direct' | 'broll' | 'audio' | 'preview';
  title: string;
  state: RowState;
  evidence: string;
  /** "09:41" when done, "đang chạy" while running. */
  when: string;
  /** 0..100 while running, when known. */
  percent?: number;
}

const ROW_STATE: Record<StepStatus, RowState> = {
  pending: 'pending', running: 'running', waiting: 'waiting', done: 'done', failed: 'failed', skipped: 'skipped', unavailable: 'skipped',
};

function clock(iso: string | undefined): string {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '';
}

const lastLog = (s: ProjectStep | undefined) => s?.log?.[s.log.length - 1]?.text;
const live = (j: VideoJob) => j.status === 'queued' || j.status === 'running';

/** The plan made for this AI edit is in: everything before the preview is finished. */
export function quickReady(p: VideoProject, jobs: VideoJob[] = []): boolean {
  if (!p.plan || !p.planVersion || p.busy || jobs.some((j) => j.projectId === p.id && live(j))) return false;
  const step = (k: StepKey) => p.steps.find((s) => s.key === k);
  if (['ingest', 'transcribe', 'analyze', 'direct'].some((k) => step(k as StepKey)?.status === 'running')) return false;
  if (p.quick?.mode === 'manual') return true;
  const direct = step('direct');
  if (direct?.status !== 'done') return false;
  // A director turn from before this AI edit does not count.
  return !p.quick?.startedAt || !direct.finishedAt || direct.finishedAt >= p.quick.startedAt;
}

export function progressRows(p: VideoProject, jobs: VideoJob[] = []): ProgressRow[] {
  const step = (k: StepKey) => p.steps.find((s) => s.key === k);
  const jobFor = (k: StepKey) => jobs.filter((j) => j.projectId === p.id && j.kind === k && live(j)).pop();
  const ready = quickReady(p, jobs);
  const quick = p.quick;
  const plan = p.plan;

  const fromStep = (id: ProgressRow['id'], title: string, k: StepKey, fallback: string, doneEvidence?: string): ProgressRow => {
    const s = step(k);
    const state = ROW_STATE[s?.status ?? 'pending'];
    const progress = s?.progress ?? (state === 'running' ? jobFor(k)?.progress : undefined);
    const evidence = state === 'failed' ? s?.error || s?.summary || fallback
      : state === 'running' ? jobFor(k)?.message || lastLog(s) || s?.summary || fallback
        : state === 'done' ? doneEvidence || s?.summary || lastLog(s) || fallback
          : s?.summary || fallback;
    return {
      id, title, state, evidence,
      when: state === 'running' ? 'đang chạy' : state === 'done' ? clock(s?.finishedAt) : '',
      ...(state === 'running' && progress !== undefined ? { percent: Math.round(progress * 100) } : {}),
    };
  };

  const source = p.source;
  const ingest = fromStep('ingest', 'Nhận video', 'ingest',
    source ? `${source.width}×${source.height} · ${formatSeconds(source.durationSec)}` : 'Chờ video tải lên');
  const transcribe = fromStep('transcribe', 'Chép lời tiếng Việt', 'transcribe', 'Có mốc thời gian từng từ');

  const cutDone = plan && quick?.autoCut !== false && plan.outputDurationSec < plan.sourceDurationSec
    ? `${formatSeconds(plan.sourceDurationSec)} → ${formatSeconds(plan.outputDurationSec)} · bỏ ${plan.cutWords.length} từ`
    : undefined;
  let cut = fromStep('cut', 'Cắt vấp và khoảng lặng', 'analyze', quick ? `Mức ${cutLabel(quick.cutLevel)}` : 'Tìm chỗ lặng, từ đệm và câu nói lại', ready ? cutDone : undefined);
  if (quick && !quick.autoCut) cut = { ...cut, state: cut.state === 'done' ? 'skipped' : cut.state, evidence: 'Đã tắt: giữ nguyên video' };

  const manual = quick?.mode === 'manual';
  const directTitle = manual ? 'Máy dựng theo mẫu' : 'Đạo diễn AI dựng theo mẫu';
  let direct = fromStep('direct', directTitle, 'direct', manual ? 'Bỏ qua đạo diễn AI: máy đặt chữ và phụ đề theo mẫu' : 'Đặt chữ theo nhịp nói, cảnh minh hoạ và zoom theo luật của mẫu');
  if (manual && ready && direct.state !== 'done') direct = { ...direct, state: 'done', evidence: `Bản dựng v${p.planVersion} theo mẫu` };
  if (!manual && direct.state === 'done' && !ready && quick?.startedAt && (step('direct')?.finishedAt ?? '') < quick.startedAt) {
    direct = { ...direct, state: 'pending', when: '', evidence: 'Chờ các bước trước xong' };
  }

  // Cut, effects and audio steps of the ticket are filled at export; until then the plan is the evidence.
  const assets = quick?.assets.length ?? 0;
  const brollPending = `${assets ? `${assets} tư liệu của bạn` : 'Chưa có tư liệu'} · ${quick?.stock === false ? 'không tìm thêm' : 'tìm thêm trong Kho của tôi và Pexels nếu thiếu'}`;
  const brolls = plan?.brolls.filter((b) => b.enabled).length ?? 0;
  const broll = derived('broll', 'Cảnh trám', 'effects', brollPending,
    brolls ? `${brolls} cảnh trám${assets ? ` · ${assets} tư liệu của bạn` : ''}` : 'Không cần cảnh trám');

  const musicMode = quick?.music.mode ?? 'ai';
  const audioPending = musicMode === 'none' ? 'Không dùng nhạc nền' : `${musicMode === 'pick' ? 'Bài bạn chọn' : 'AI chọn theo mẫu'}${quick?.music.duck === false ? '' : ' · tự giảm nhạc khi đang nói'}`;
  const audio = derived('audio', 'Nhạc và tiếng động', 'audio', audioPending,
    `${plan?.music ? `Có nhạc nền${plan.music.duck ? ' · tự giảm khi đang nói' : ''}` : 'Không nhạc nền'} · ${plan?.sfx.length ?? 0} tiếng động`);

  const preview: ProgressRow = ready
    ? { id: 'preview', title: 'Dựng bản xem trước', state: 'done', evidence: `Đã có bản xem trước v${p.planVersion} · chưa xuất video`, when: '' }
    : { id: 'preview', title: 'Dựng bản xem trước', state: 'pending', evidence: 'Chưa xuất video: bạn xem, chỉnh rồi mới bấm Xuất', when: '' };

  return [ingest, transcribe, cut, direct, broll, audio, preview];

  function derived(id: ProgressRow['id'], title: string, k: StepKey, pending: string, done: string): ProgressRow {
    const row = fromStep(id, title, k, pending);
    if (row.state !== 'pending') return row;
    return ready ? { ...row, state: 'done', evidence: done } : row;
  }
}

export type ProgressStage = 'running' | 'ready' | 'failed' | 'stopped';

export function progressStage(p: VideoProject, rows: ProgressRow[], jobs: VideoJob[] = []): ProgressStage {
  if (rows.some((r) => r.state === 'failed')) return 'failed';
  if (quickReady(p, jobs)) return 'ready';
  const working = p.busy || rows.some((r) => r.state === 'running') || jobs.some((j) => j.projectId === p.id && live(j));
  return working || !p.quick ? 'running' : 'stopped';
}
