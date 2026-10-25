// Template registry for Dựng nhanh: built-in packs in modules/video/templates/<id>/ (always installed),
// packs the owner adds in <data>/video-edit/templates/<id>/, and the 21 legacy VideoStyles wrapped as
// `style:<id>` (legacy: true, rendered with the old overlays). Every template.json is checked with zod;
// a broken pack is left out of the list and reported with the reason, never half-loaded.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PROJECT_ROOT, STORE_DIR } from '../../paths.js';
import { VIDEO_STYLES } from '../catalog/styles.js';
import type { StyleGroup, VideoStyle } from '../types.js';
import type { CaptionStyle, ComponentDef, PropDef, TemplateManifest, TemplateSummary } from './types.js';

export const LEGACY_PREFIX = 'style:';
const MANIFEST_FILE = 'template.json';
const INSTALLED_FILE = 'installed.json';

export class TemplateError extends Error {
  constructor(public status: 400 | 404 | 422, message: string, public code?: string) {
    super(message);
  }
}

// ── Manifest schema ────────────────────────────────────────────────────────────

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'chỉ gồm chữ thường, số và dấu gạch ngang');
/** Prop ids double as HyperFrames variable ids, so camelCase is fine. */
const propId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/, 'bắt đầu bằng chữ, chỉ gồm chữ, số, - và _');
const color = z.string().regex(/^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\))$/, 'màu dạng #RRGGBB hoặc rgba(...)');
const text = (max: number) => z.string().trim().min(1).max(max);
/** A file inside the pack: relative, no "..", no hidden segments. */
const packFile = z.string().min(1).max(200).refine(
  (p) => !path.isAbsolute(p) && !p.includes('\0') && !p.includes('\\') && p.split('/').every((s) => s && s !== '..' && !s.startsWith('.')),
  'phải là đường dẫn tương đối bên trong thư mục mẫu',
);
const aspect = z.enum(['9:16', '16:9', '1:1', '4:5']);

const propDefSchema = z.object({
  type: z.enum(['text', 'markup', 'list', 'number', 'color', 'asset']),
  label: text(80),
  required: z.boolean().optional(),
  maxWords: z.number().int().min(1).max(60).optional(),
  maxLines: z.number().int().min(1).max(10).optional(),
  maxItems: z.number().int().min(1).max(20).optional(),
}).strict();

const componentSchema = z.object({
  kind: z.enum(['beat', 'scene', 'graphic', 'broll-frame']),
  label: text(80),
  file: packFile.refine((f) => f.endsWith('.html'), 'block phải là tệp .html'),
  runtime: z.enum(['gsap', 'lottie', 'three', 'animejs', 'css', 'waapi', 'typegpu']),
  props: z.record(propId, propDefSchema),
  duration: z.object({ min: z.number().positive().max(120), max: z.number().positive().max(120), default: z.number().positive().max(120) }).strict()
    .refine((d) => d.min <= d.default && d.default <= d.max, 'cần min ≤ default ≤ max'),
  animations: z.array(slug).max(20).optional(),
  safeZone: z.object({ top: z.number().min(0).max(50), bottom: z.number().min(0).max(50) }).strict().optional(),
  useWhen: text(400).optional(),
  avoidWhen: text(400).optional(),
}).strict();

const captionSchema = z.object({
  pos: z.number().min(0).max(1),
  maxWidthPct: z.number().min(20).max(100),
  align: z.enum(['center', 'left']),
  font: z.object({ family: text(80), sizePct: z.number().min(1).max(20), weight: z.number().int().min(100).max(900), upper: z.boolean().optional() }).strict(),
  fill: color,
  stroke: z.object({ color, width: z.number().min(0).max(20) }).strict().optional(),
  shadow: z.string().max(120).regex(/^[^;{}<>]*$/).optional(),
  box: z.object({ color, padding: z.number().min(0).max(80), radius: z.number().min(0).max(80) }).strict().optional(),
  highlight: z.object({ color, mode: z.enum(['color', 'box', 'pop']) }).strict(),
  maxWordsPerChunk: z.number().int().min(1).max(8),
}).strict();

export const manifestSchema = z.object({
  id: slug,
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'dạng 1.0.0'),
  name: text(80),
  description: text(400),
  tags: z.array(text(40)).max(12),
  tier: z.enum(['free', 'pro']),
  aspects: z.array(aspect).min(1),
  poster: packFile.optional(),
  preview: packFile.optional(),
  styleId: z.string().max(40).refine((id) => VIDEO_STYLES.some((s) => s.id === id), 'không có phong cách này').optional(),
  tokens: z.object({
    fonts: z.object({ title: text(80), sub: text(80), caption: text(80) }).strict(),
    colors: z.record(slug, color),
  }).strict(),
  captions: captionSchema,
  components: z.record(slug, componentSchema).refine((c) => Object.keys(c).length > 0, 'cần ít nhất một component'),
  animations: z.array(z.object({ id: slug, label: text(60), sound: z.string().max(120).optional() }).strict()).max(20),
  sounds: z.object({
    density: z.enum(['none', 'low', 'medium', 'high']),
    transition: z.string().max(120).optional(),
    click: z.string().max(120).optional(),
  }).strict(),
  rules: packFile,
  license: z.object({ source: text(200), attribution: text(500).optional() }).strict().optional(),
  legacy: z.boolean().optional(),
}).strict().superRefine((m, ctx) => {
  const presets = m.animations.map((a) => a.id);
  if (new Set(presets).size !== presets.length) ctx.addIssue({ code: 'custom', path: ['animations'], message: 'id hiệu ứng bị trùng' });
  for (const [id, c] of Object.entries(m.components)) {
    for (const a of c.animations ?? []) {
      if (!presets.includes(a)) ctx.addIssue({ code: 'custom', path: ['components', id, 'animations'], message: `hiệu ứng "${a}" không có trong danh sách animations` });
    }
  }
});

function describeIssues(err: z.ZodError): string {
  return err.issues.slice(0, 4).map((i) => `${i.path.join('.') || '(gốc)'}: ${i.message}`).join('; ');
}

/**
 * Read and check one pack folder. Throws TemplateError(422) with a Vietnamese reason: bad JSON, schema
 * violations (field path + message), an id that differs from the folder, or a referenced file missing.
 */
export function loadTemplateDir(dir: string): TemplateManifest {
  const folder = path.basename(dir);
  const fail = (why: string): never => { throw new TemplateError(422, `Mẫu "${folder}": ${why}`, 'bad_manifest'); };
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8')); } catch (err) {
    return fail((err as NodeJS.ErrnoException).code === 'ENOENT' ? `thiếu ${MANIFEST_FILE}.` : `${MANIFEST_FILE} không phải JSON hợp lệ.`);
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) return fail(`${MANIFEST_FILE} chưa hợp lệ — ${describeIssues(parsed.error)}.`);
  const manifest = parsed.data as TemplateManifest;
  if (manifest.id !== folder) fail(`id "${manifest.id}" phải trùng tên thư mục.`);
  const files = [manifest.rules, manifest.poster, manifest.preview, ...Object.values(manifest.components).map((c) => c.file)];
  for (const f of files) if (f && !safeFile(dir, f)) fail(`không thấy tệp ${f}.`);
  return manifest;
}

/** Absolute path of `rel` when it is a regular file inside `dir` (symlinks resolved), else null. */
export function safeFile(dir: string, rel: string): string | null {
  if (!rel || rel.includes('\0') || path.isAbsolute(rel) || rel.split(/[\\/]/).some((s) => s === '..' || s.startsWith('.'))) return null;
  try {
    const base = fs.realpathSync(dir);
    const file = fs.realpathSync(path.resolve(base, rel));
    if (!file.startsWith(base + path.sep) || !fs.statSync(file).isFile()) return null;
    return file;
  } catch {
    return null;
  }
}

// ── Legacy styles ──────────────────────────────────────────────────────────────

const GROUP_TAG: Record<StyleGroup, string> = { teach: 'Kiến thức', sell: 'Bán hàng', life: 'Đời sống', cinema: 'Giải trí' };
const EXTRA_TAGS: Record<string, string[]> = {
  kienthuc: ['Talking head'], congnghe: ['Talking head'], quyen: ['Talking head'], podcast: ['Talking head'],
  bds: ['Bất động sản'], tamsu: ['Thương hiệu cá nhân'], showcase: ['Thương hiệu cá nhân'],
};
/** Card text drawn when a template has no poster. */
const LEGACY_SAMPLE: Record<string, [kicker: string, title: string]> = {
  kienthuc: ['MẸO NHỎ', 'Bạn có biết?'], huongdan: ['BƯỚC 1', 'Mở phần cài đặt'], giaoduc: ['CHƯƠNG 1', 'Khái niệm cốt lõi'],
  congnghe: ['REVIEW', 'TOOL AI MỚI'], taichinh: ['LÃI KÉP', '+12% mỗi năm'], podcast: ['TẬP 12', 'Câu chuyện khởi nghiệp'],
  review: ['ĐÁNH GIÁ', 'Có đáng tiền?'], sanpham: ['ƯU ĐÃI', 'CHỐT ĐƠN NGAY'], bds: ['CĂN HỘ', 'Căn góc hai mặt thoáng'],
  thoitrang: ['LOOKBOOK', 'Phối đồ đi làm'], amthuc: ['MÓN NGON', 'Bún chả 35K'], quyen: ['DINH DƯỠNG', 'Ăn gì buổi sáng?'],
  vlog: ['MỘT NGÀY', '7:00 sáng · Đà Lạt'], tamsu: ['CÂU CHUYỆN', 'Điều mình ước biết sớm hơn'], dulich: ['ĐIỂM ĐẾN', 'Hội An về đêm'],
  thethao: ['THỬ THÁCH', '30 ngày plank'], sukien: ['HẬU TRƯỜNG', 'Workshop tháng 10'], dienanh: ['TRAILER', 'Một ngày không quên'],
  tintuc: ['ĐIỂM TIN', 'Tin nóng hôm nay'], hai: ['TRÊN MẠNG', 'Ai cũng từng như vậy'], showcase: ['TRƯỚC – SAU', 'Kết quả sau 30 ngày'],
};

/** Old caption style ids → CaptionStyle, matching what pipeline/composition.ts draws for them. */
function legacyCaptions(style: VideoStyle): CaptionStyle {
  const id = style.captionStyle.replace(/^caption:/, '');
  const accent = style.palette.highlight;
  const base: CaptionStyle = {
    pos: id === 'behind-subject' ? 0.44 : 0.8, maxWidthPct: 88, align: 'center',
    font: { family: style.fontCaption ?? 'Be Vietnam Pro', sizePct: 6.5, weight: 800 },
    fill: '#FFFFFF', shadow: '0 5px 18px rgba(0,0,0,0.9)',
    highlight: { color: accent, mode: 'color' }, maxWordsPerChunk: 3,
  };
  if (id === 'highlight-bar') base.highlight.mode = 'box';
  if (id === 'outline-highlight') base.stroke = { color: '#000000', width: 3 };
  if (id === 'boxed') base.box = { color: 'rgba(10,10,14,0.72)', padding: 14, radius: 18 };
  if (id === 'pair-words') base.maxWordsPerChunk = 2;
  if (id === 'single-word-pop') { base.maxWordsPerChunk = 1; base.highlight.mode = 'pop'; }
  if (id === 'bold-uppercase') { base.font = { ...base.font, sizePct: 7.2, upper: true }; }
  return base;
}

export function legacyManifest(style: VideoStyle): TemplateManifest {
  return {
    id: `${LEGACY_PREFIX}${style.id}`,
    version: '1.0.0',
    name: style.name,
    description: style.description,
    tags: [GROUP_TAG[style.group], ...(EXTRA_TAGS[style.id] ?? [])],
    tier: 'free',
    aspects: ['9:16', '16:9', '1:1', '4:5'],
    styleId: style.id,
    tokens: {
      fonts: { title: style.fontHeading, sub: style.fontCaption ?? 'Be Vietnam Pro', caption: style.fontCaption ?? 'Be Vietnam Pro' },
      colors: { bg: style.palette.bg, text: style.palette.text, accent: style.palette.highlight },
    },
    captions: legacyCaptions(style),
    components: {},
    animations: [],
    sounds: { density: style.sfxDensity },
    rules: '',
    license: { source: 'AIOS-Lite' },
    legacy: true,
  };
}

/** The six overlay effects old plans use (pipeline/composition.ts), with the props each one reads. */
const LEGACY_OVERLAYS: [effect: string, label: string, props: string][] = [
  ['two-tier-title', 'Tiêu đề hai tầng', 'small, big'],
  ['keyword-pop', 'Từ khoá bật lên', 'text'],
  ['big-number', 'Số lớn', 'value, label'],
  ['stacked-list', 'Danh sách xếp tầng', 'title, items'],
  ['compare-ab', 'So sánh A | B', 'labelA, textA, labelB, textB'],
  ['cta-button', 'Nút kêu gọi', 'text, sub'],
];

// ── Installed list ─────────────────────────────────────────────────────────────

/** Ids the owner installed (POST /templates/:id/install); built-in packs are always installed. */
export interface InstalledStore { get(): string[]; set(ids: string[]): void }

/** GĐ1: a small settings file next to the owner's packs, <userDir>/installed.json. */
export function fileInstalledStore(userDir: () => string): InstalledStore {
  const file = () => path.join(userDir(), INSTALLED_FILE);
  return {
    get() {
      try {
        const data = JSON.parse(fs.readFileSync(file(), 'utf8')) as { installed?: unknown };
        return Array.isArray(data.installed) ? data.installed.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        return [];
      }
    },
    set(ids) {
      fs.mkdirSync(userDir(), { recursive: true });
      const temp = `${file()}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ installed: ids }, null, 1), { mode: 0o600 });
      fs.renameSync(temp, file());
    },
  };
}

// ── Registry ───────────────────────────────────────────────────────────────────

export interface TemplateRegistryOptions {
  /** Default: <repo>/modules/video/templates. */
  builtinDir?: () => string;
  /** Default: <data>/video-edit/templates. */
  userDir?: () => string;
  installed?: InstalledStore;
  /** Prefix of the files route used for posterUrl/previewUrl. Default /api/m/video/edit/templates. */
  filesBase?: string;
}

interface Entry { manifest: TemplateManifest; dir: string | null; builtin: boolean }

export interface TemplateRegistry {
  list(): TemplateSummary[];
  get(id: string): TemplateManifest | null;
  dir(id: string): string | null;
  /** Broken packs found in the last scan, with the reason. */
  problems(): { id: string; error: string }[];
  forPrompt(id: string): string;
  componentHtml(id: string, componentId: string): string;
  /** Absolute path of a file of the pack, or null when outside the pack / missing. */
  file(id: string, name: string): string | null;
  install(id: string): TemplateSummary;
}

const defaultBuiltinDir = () => path.join(PROJECT_ROOT, 'modules', 'video', 'templates');
const defaultUserDir = () => path.join(STORE_DIR, 'video-edit', 'templates');

export function createTemplateRegistry(options: TemplateRegistryOptions = {}): TemplateRegistry {
  const builtinDir = options.builtinDir ?? defaultBuiltinDir;
  const userDir = options.userDir ?? defaultUserDir;
  const installed = options.installed ?? fileInstalledStore(userDir);
  const filesBase = options.filesBase ?? '/api/m/video/edit/templates';
  const cache = new Map<string, { mtimeMs: number; size: number; result: TemplateManifest | TemplateError }>();
  const legacy: Entry[] = VIDEO_STYLES.map((s) => ({ manifest: legacyManifest(s), dir: null, builtin: true }));
  let lastProblems: { id: string; error: string }[] = [];

  function loadCached(dir: string): TemplateManifest | TemplateError {
    const file = path.join(dir, MANIFEST_FILE);
    let stat: fs.Stats | null = null;
    try { stat = fs.statSync(file); } catch { /* missing: loadTemplateDir reports it */ }
    const hit = cache.get(dir);
    if (stat && hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.result;
    let result: TemplateManifest | TemplateError;
    try { result = loadTemplateDir(dir); } catch (err) {
      result = err instanceof TemplateError ? err : new TemplateError(422, `Mẫu "${path.basename(dir)}": không đọc được.`, 'bad_manifest');
    }
    if (stat) cache.set(dir, { mtimeMs: stat.mtimeMs, size: stat.size, result });
    return result;
  }

  function scan(): Entry[] {
    const out: Entry[] = [];
    const problems: { id: string; error: string }[] = [];
    const seen = new Set<string>();
    for (const [base, builtin] of [[builtinDir(), true], [userDir(), false]] as const) {
      let names: string[] = [];
      try { names = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort(); } catch { /* no folder yet */ }
      for (const name of names) {
        const dir = path.join(base, name);
        const result = loadCached(dir);
        if (result instanceof TemplateError) { problems.push({ id: name, error: result.message }); continue; }
        if (seen.has(result.id)) { problems.push({ id: name, error: `Mẫu "${name}": trùng id với một mẫu cài sẵn, bỏ qua.` }); continue; }
        seen.add(result.id);
        out.push({ manifest: result, dir, builtin });
      }
    }
    lastProblems = problems;
    return [...out, ...legacy];
  }

  const find = (id: string): Entry | undefined => scan().find((e) => e.manifest.id === id);
  const need = (id: string): Entry => {
    const entry = find(id);
    if (!entry) throw new TemplateError(404, 'Không tìm thấy mẫu này.', 'not_found');
    return entry;
  };

  function summary(e: Entry, owned: Set<string>): TemplateSummary {
    const m = e.manifest;
    const fileUrl = (f: string | undefined) => (f && e.dir ? `${filesBase}/${encodeURIComponent(m.id)}/files/${f.split('/').map(encodeURIComponent).join('/')}` : undefined);
    const style = m.styleId ? VIDEO_STYLES.find((s) => s.id === m.styleId) : undefined;
    const legacySample = m.legacy && style ? LEGACY_SAMPLE[style.id] : undefined;
    const colors = m.tokens.colors;
    const posterUrl = fileUrl(m.poster);
    const previewUrl = fileUrl(m.preview);
    return {
      id: m.id, name: m.name, description: m.description, tags: m.tags, tier: m.tier,
      installed: (e.builtin && !m.legacy) || owned.has(m.id),
      legacy: Boolean(m.legacy),
      ...(posterUrl ? { posterUrl } : {}),
      ...(previewUrl ? { previewUrl } : {}),
      sample: {
        ...(legacySample ? { kicker: legacySample[0] } : m.tags[0] ? { kicker: m.tags[0].toUpperCase() } : {}),
        title: legacySample?.[1] ?? m.name,
        font: m.tokens.fonts.title,
        color: colors.accent ?? colors.highlight ?? colors.text ?? '#FFFFFF',
        tone: colors.tone ?? colors.bg ?? '#111111',
      },
    };
  }

  function list(): TemplateSummary[] {
    const owned = new Set(installed.get());
    return scan().map((e) => summary(e, owned));
  }

  function forPrompt(id: string): string {
    const { manifest: m, dir } = need(id);
    const style = m.styleId ? VIDEO_STYLES.find((s) => s.id === m.styleId) : undefined;
    const lines: string[] = [`## Mẫu edit: ${m.name} (${m.id})`, m.description];
    if (style) lines.push(`Phong cách nền: ${style.name} · nhịp cắt ${style.cutPace} · nhạc ${style.musicMoods.join(', ') || 'không'} · tiếng động ${style.sfxDensity}.`);
    if (m.legacy) {
      lines.push('', '### Luật của mẫu', style?.promptNotes ?? '');
      lines.push('', '### Hiệu ứng (mẫu cơ bản: chỉ dùng overlays, không dùng beats/scenes)');
      for (const [effect, label, props] of LEGACY_OVERLAYS) lines.push(`- ${effect}: ${label}. Props: ${props}.`);
    } else {
      const rulesFile = dir ? safeFile(dir, m.rules) : null;
      const rules = rulesFile ? fs.readFileSync(rulesFile, 'utf8').trim() : '';
      if (rules) lines.push('', '### Luật của mẫu', rules);
      lines.push('', '### Component (ghi đúng id vào `component`)');
      for (const [cid, c] of Object.entries(m.components)) lines.push(componentLine(cid, c, m));
      if (m.animations.length) {
        lines.push('', '### Hiệu ứng vào (`animIn`)');
        lines.push(m.animations.map((a) => `${a.id} (${a.label}${a.sound ? `, tiếng ${a.sound}` : ''})`).join(' · '));
      }
    }
    const cap = m.captions;
    lines.push('', '### Phụ đề',
      `${cap.font.family} ${cap.font.weight}, tối đa ${cap.maxWordsPerChunk} từ một lần, tô ${cap.highlight.color} cho từ khoá (${cap.highlight.mode}); ghi từ khoá vào captions.highlight.`);
    lines.push('', `### Âm thanh: mật độ ${m.sounds.density}${m.sounds.transition ? `, chuyển cảnh ${m.sounds.transition}` : ''}${m.sounds.click ? `, click ${m.sounds.click}` : ''}.`);
    return lines.join('\n');
  }

  function componentHtml(id: string, componentId: string): string {
    const { manifest, dir } = need(id);
    const def = manifest.components[componentId];
    const file = def && dir ? safeFile(dir, def.file) : null;
    if (!file) throw new TemplateError(404, `Mẫu "${id}" không có component "${componentId}".`, 'no_component');
    return fs.readFileSync(file, 'utf8');
  }

  function install(id: string): TemplateSummary {
    const entry = need(id);
    const owned = new Set(installed.get());
    if (!owned.has(id) && !(entry.builtin && !entry.manifest.legacy)) {
      owned.add(id);
      installed.set([...owned]);
    }
    return summary(entry, owned);
  }

  return {
    list,
    get: (id) => find(id)?.manifest ?? null,
    dir: (id) => find(id)?.dir ?? null,
    problems: () => { scan(); return lastProblems; },
    forPrompt,
    componentHtml,
    file: (id, name) => { const e = find(id); return e?.dir ? safeFile(e.dir, name) : null; },
    install,
  };
}

function propLine(name: string, p: PropDef): string {
  const limits = [
    p.maxWords ? `≤${p.maxWords} từ` : '', p.maxLines ? `≤${p.maxLines} dòng` : '', p.maxItems ? `≤${p.maxItems} mục` : '',
  ].filter(Boolean).join(', ');
  return `${name}${p.required ? '*' : ''} (${p.type}${limits ? `, ${limits}` : ''})`;
}

function componentLine(id: string, c: ComponentDef, m: TemplateManifest): string {
  const props = Object.entries(c.props).map(([k, p]) => propLine(k, p)).join('; ');
  const anims = c.animations ?? m.animations.map((a) => a.id);
  const parts = [
    `- ${id} — ${c.label} (${c.kind}), ${c.duration.min}–${c.duration.max}s, mặc định ${c.duration.default}s.`,
    props ? `Props: ${props}.` : '',
    c.kind !== 'broll-frame' && anims.length ? `animIn: ${anims.join(', ')}.` : '',
    c.useWhen ? `Dùng khi: ${c.useWhen}` : '',
    c.avoidWhen ? `Tránh: ${c.avoidWhen}` : '',
  ];
  return parts.filter(Boolean).join(' ');
}

// ── Default registry (module data dir) ─────────────────────────────────────────

const registry = createTemplateRegistry();

export const listTemplates = (): TemplateSummary[] => registry.list();
export const getTemplate = (id: string): TemplateManifest | null => registry.get(id);
export const templateDir = (id: string): string | null => registry.dir(id);
/** rules.md + components, props and presets, in Vietnamese, for the director prompt. */
export const templateForPrompt = (id: string): string => registry.forPrompt(id);
/** The HyperFrames sub-composition HTML of one component. Throws TemplateError(404) when unknown. */
export const componentHtml = (id: string, componentId: string): string => registry.componentHtml(id, componentId);
