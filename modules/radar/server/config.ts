/** Radar configuration: stored as JSON in dashboard setting 'radar.config', deep-merged over the defaults on read. */

import { z } from 'zod';

import { currentContext } from './context.js';
import { getKv as getDashboardSetting, setKv as setDashboardSetting } from './kv.js';
import { defaultRadarConfig } from './defaults.js';
import { LAYER_KEYS, type RadarConfig } from './types.js';

export const CONFIG_KEY = 'radar.config';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Objects merge key by key; arrays and scalars from `over` replace `base`. Unknown keys of `over` are kept. */
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in base ? deepMerge((base as Record<string, unknown>)[k], v) : v;
  }
  return out as T;
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'phải có dạng HH:MM, ví dụ 07:00');
const str = z.string();
const strList = z.array(z.string());

const fbGroup = z.object({
  name: str.min(1, 'tên nhóm không được để trống'),
  url: str.min(1, 'thiếu liên kết nhóm'),
  members: z.number().int().nonnegative().optional(),
  profession: str.optional(),
  mode: z.enum(['auto', 'rsshub', 'apify', 'browser']).optional(),
  enabled: z.boolean().optional(),
});
const fbPage = z.object({ name: str.min(1, 'tên trang không được để trống'), url: str.min(1, 'thiếu liên kết trang'), enabled: z.boolean().optional() });
const topic = z.object({ key: str.min(1), label: str.min(1, 'tên chủ đề không được để trống'), keywords: strList });

const layerSchema = z.object({
  key: z.enum(['vn', 'world', 'nganh']),
  label: str.min(1, 'tên lớp không được để trống'),
  time: hhmm,
  enabled: z.boolean(),
  description: str,
  fbGroups: z.array(fbGroup),
  fbPages: z.array(fbPage),
  instagram: strList,
  adLibrary: z.object({ enabled: z.boolean(), country: str.min(2), queries: strList, pageUrls: strList }),
  x: z.object({ enabled: z.boolean(), accounts: strList, queries: strList, vnCheck: z.boolean() }),
  reddit: z.object({ enabled: z.boolean(), subreddits: strList }),
  hackerNews: z.object({ enabled: z.boolean(), minPoints: z.number().int().nonnegative() }),
  youtube: z.object({ enabled: z.boolean(), channels: z.array(z.object({ name: str, channelId: str })) }),
  tiktok: z.object({ enabled: z.boolean(), queries: strList, accounts: strList }),
  threads: z.object({ enabled: z.boolean(), queries: strList, accounts: strList }),
  github: z.object({ enabled: z.boolean(), queries: strList }),
  news: z.object({ enabled: z.boolean(), rss: strList }),
  professions: strList,
  aiOnly: z.boolean(),
  topics: z.array(topic),
  windowHours: z.number().int().min(1, 'phải từ 1 giờ').max(24 * 30, 'tối đa 720 giờ'),
  firstWindowHours: z.number().int().min(1, 'phải từ 1 giờ').max(24 * 30, 'tối đa 720 giờ'),
  maxPerSource: z.number().int().min(1, 'phải từ 1').max(200, 'tối đa 200'),
  commentPosts: z.number().int().min(0, 'không âm').max(50, 'tối đa 50'),
});

const configSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  timezone: str.refine((tz) => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
  }, 'múi giờ không hợp lệ, ví dụ Asia/Ho_Chi_Minh'),
  owner: z.object({ name: str, channels: strList, about: str }),
  analysisAgentId: str.min(1, 'chưa chọn agent phân tích'),
  aiKeywords: strList,
  buyKeywords: z.object({ intent: strList, price: strList, material: strList }),
  layers: z.object({ vn: layerSchema, world: layerSchema, nganh: layerSchema }),
});

const LABELS: Record<string, string> = {
  time: 'giờ quét', label: 'tên', timezone: 'múi giờ', analysisAgentId: 'agent phân tích', windowHours: 'cửa sổ quét (giờ)',
  firstWindowHours: 'cửa sổ lần quét đầu (giờ)', maxPerSource: 'số bài tối đa mỗi nguồn', commentPosts: 'số bài đọc bình luận',
  layers: 'lớp', owner: 'chủ sở hữu', fbGroups: 'nhóm Facebook', fbPages: 'fanpage', topics: 'chủ đề',
};

export function validateConfig(input: unknown): { ok: true; config: RadarConfig } | { ok: false; error: string } {
  const parsed = configSchema.safeParse(input);
  if (parsed.success) return { ok: true, config: parsed.data as RadarConfig };
  const issue = parsed.error.issues[0];
  const path = issue.path.map((p) => (typeof p === 'number' ? `#${p + 1}` : LABELS[String(p)] ?? String(p))).join(' › ');
  return { ok: false, error: `Cấu hình Radar không hợp lệ ở "${path || 'gốc'}": ${issue.message}` };
}

/** The master switch is the module setting `enabled` (default off); the stored JSON value is only a fallback outside a module. */
function withMasterSwitch(cfg: RadarConfig): RadarConfig {
  const ctx = currentContext();
  if (ctx) cfg.enabled = ctx.settings.get<boolean>('enabled', false) === true;
  return cfg;
}

export function loadConfig(): RadarConfig {
  const defaults = defaultRadarConfig();
  const raw = getDashboardSetting(CONFIG_KEY);
  if (!raw) return withMasterSwitch(defaults);
  try {
    return withMasterSwitch(deepMerge(defaults, JSON.parse(raw)));
  } catch {
    return withMasterSwitch(defaults);
  }
}

export class ConfigError extends Error {}

/** Validates and stores; throws ConfigError (Vietnamese message naming the field) on bad input. */
export function saveConfig(input: unknown): RadarConfig {
  const merged = deepMerge(defaultRadarConfig(), input);
  const result = validateConfig(merged);
  if (!result.ok) throw new ConfigError(result.error);
  for (const k of LAYER_KEYS) result.config.layers[k].key = k;
  setDashboardSetting(CONFIG_KEY, JSON.stringify(result.config));
  return result.config;
}

export function setEnabled(enabled: boolean): RadarConfig {
  currentContext()?.settings.set('enabled', enabled);
  const cfg = loadConfig();
  cfg.enabled = enabled;
  setDashboardSetting(CONFIG_KEY, JSON.stringify(cfg));
  return cfg;
}

export function resetConfig(): RadarConfig {
  const cfg = defaultRadarConfig();
  setDashboardSetting(CONFIG_KEY, JSON.stringify(cfg));
  return cfg;
}
