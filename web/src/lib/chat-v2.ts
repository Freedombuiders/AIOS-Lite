// Pure view logic for the /chat page (model picker, effort, Context sources, attachments, mic, send errors).
// No DOM, no fetch: unit-tested in chat-v2.test.ts.

export type ContextSourceId = "memory" | "agents" | "obsidian" | "team" | "history";

/** What a conversation may pin: never a command, arguments or a base URL. */
export interface ChatProviderChoice {
  type: string;
  model?: string;
  runtimeMode?: string;
  thinkingMode?: string;
  endpoint?: string;
}
export interface ChatSettings {
  provider?: ChatProviderChoice;
  context: { enabled: boolean; sources: ContextSourceId[] };
}
export interface ChatEffective {
  type: string;
  label: string;
  model: string | null;
  modelLabel: string | null;
  overridden: boolean;
}
export interface ChatProviderOption {
  type: string;
  label: string;
  tier: "stable" | "experimental";
}
/** GET /api/chat/conversations/:id/settings */
export interface ChatSettingsResponse {
  settings: ChatSettings;
  effective: ChatEffective;
  providers: ChatProviderOption[];
}
/** GET /api/chat/endpoints → endpoints[] */
export interface ChatEndpoint {
  id: string;
  label: string;
  local: boolean;
  ready: boolean;
  detail: string;
}
/** GET /api/chat/context-sources → sources[] */
export interface ContextSourceInfo {
  id: ContextSourceId;
  label: string;
  count: number | null;
  available: boolean;
}
export interface ModelOption {
  id: string;
  label: string;
  free?: boolean;
}
export interface RuntimeOption {
  id: string;
  label: string;
  current?: boolean;
}
/** GET /api/providers/runtime-options */
export interface RuntimeOptions {
  provider?: string;
  modeLabel?: string;
  thinkingLabel?: string;
  modeOptions?: RuntimeOption[];
  thinkingOptions?: RuntimeOption[];
  error?: string;
}

/** The provider type behind every OpenAI-compatible endpoint (OpenRouter, xAI, Ollama, LM Studio). */
export const COMPAT_TYPE = "openrouter";
export const COMPAT_NOTE = "Các model này chỉ trò chuyện, không dùng công cụ.";
export const SESSION_RESET_NOTICE = "Đã đổi model — cuộc chat tiếp tục với phiên mới.";

/** A settings payload the page can trust (old servers and test stubs answer `{}` or `{ ok: true }`). */
export function isSettingsResponse(value: unknown): value is ChatSettingsResponse {
  const v = value as Partial<ChatSettingsResponse> | null;
  return !!v && typeof v === "object" && !!v.settings && typeof v.settings === "object" && !!v.effective
    && typeof v.effective.type === "string" && Array.isArray(v.providers);
}

const SHORT: Record<string, string> = {
  claude: "Claude",
  openai: "OpenAI",
  gemini: "Gemini",
  opencode: "OpenCode",
  "acp-codex": "Codex",
  "anthropic-compatible": "Z.ai",
  harness: "Harness",
  "hermes-gateway": "Hermes",
  acp: "ACP",
  openrouter: "OpenRouter",
  xai: "xAI",
  ollama: "Ollama",
  lmstudio: "LM Studio",
};
export function shortLabel(id: string, label?: string): string {
  return SHORT[id] || label?.replace(/\s*\(.*\)\s*$/, "") || id;
}

export interface PickerTab {
  /** Provider type, or "ep:<endpoint>" for an OpenAI-compatible endpoint. */
  key: string;
  kind: "provider" | "endpoint";
  type: string;
  endpoint?: string;
  label: string;
  short: string;
  experimental: boolean;
  ready: boolean;
  detail?: string;
  local?: boolean;
}

/**
 * Provider tabs from the settings payload, then one tab per OpenAI-compatible endpoint. The `openrouter`
 * provider is represented by its endpoints; without an endpoint list it stays a plain provider tab.
 */
export function pickerTabs(providers: ChatProviderOption[], endpoints: ChatEndpoint[]): PickerTab[] {
  const tabs: PickerTab[] = providers
    .filter((p) => p.type !== COMPAT_TYPE || !endpoints.length)
    .map((p) => ({
      key: p.type,
      kind: "provider",
      type: p.type,
      label: p.label,
      short: shortLabel(p.type, p.label),
      experimental: p.tier === "experimental",
      ready: true,
    }));
  for (const e of endpoints)
    tabs.push({
      key: `ep:${e.id}`,
      kind: "endpoint",
      type: COMPAT_TYPE,
      endpoint: e.id,
      label: e.label,
      short: shortLabel(e.id, e.label),
      experimental: true,
      ready: e.ready,
      detail: e.detail,
      local: e.local,
    });
  return tabs;
}

/** The tab of the provider answering right now. */
export function currentTabKey(data: Pick<ChatSettingsResponse, "settings" | "effective">, tabs: PickerTab[]): string {
  const type = data.effective.type;
  if (type === COMPAT_TYPE) {
    const key = `ep:${(data.settings.provider?.type === COMPAT_TYPE && data.settings.provider.endpoint) || "openrouter"}`;
    if (tabs.some((t) => t.key === key)) return key;
  }
  return tabs.some((t) => t.key === type) ? type : tabs[0]?.key || type;
}

/** Endpoint id shown for the effective provider (for its mark), or undefined for a regular provider. */
export function effectiveEndpoint(data: Pick<ChatSettingsResponse, "settings" | "effective">): string | undefined {
  if (data.effective.type !== COMPAT_TYPE) return undefined;
  return (data.settings.provider?.type === COMPAT_TYPE && data.settings.provider.endpoint) || "openrouter";
}

/** PATCH body for picking a model on a tab. Plain OpenRouter carries no endpoint. */
export function modelChoice(tab: PickerTab, model: string): ChatProviderChoice {
  return {
    type: tab.type,
    model,
    ...(tab.kind === "endpoint" && tab.endpoint && tab.endpoint !== "openrouter" ? { endpoint: tab.endpoint } : {}),
  };
}

export function filterModels(models: ModelOption[], query: string): ModelOption[] {
  const q = query.trim().toLocaleLowerCase("vi");
  if (!q) return models;
  return models.filter((m) => `${m.label} ${m.id}`.toLocaleLowerCase("vi").includes(q));
}

export function modelChipLabel(effective: ChatEffective): string {
  return effective.modelLabel || effective.model || effective.label;
}

// ── Effort ─────────────────────────────────────────────────────────────

export type EffortField = "runtimeMode" | "thinkingMode";
export interface EffortGroup {
  field: EffortField;
  label: string;
  options: RuntimeOption[];
  current: string;
}

function pickCurrent(options: RuntimeOption[], chosen: string | undefined): string {
  if (chosen !== undefined && options.some((o) => o.id === chosen)) return chosen;
  return (options.find((o) => o.current) ?? options.find((o) => o.id === "") ?? options[0]).id;
}

/** Only effort-like dials belong on the effort chip (Harness's "workspace access" modes do not). */
const EFFORT_IDS = new Set(["", "none", "minimal", "low", "medium", "high", "xhigh", "max", "off", "on", "default", "auto"]);
function effortLike(options: RuntimeOption[]): boolean {
  return options.every((o) => EFFORT_IDS.has(String(o.id ?? "").toLowerCase()));
}

/** Effort/thinking groups the runtime advertises for this provider and model; empty when it has none. */
export function effortGroups(opts: RuntimeOptions | null | undefined, provider?: ChatProviderChoice): EffortGroup[] {
  const groups: EffortGroup[] = [];
  const modeAll = Array.isArray(opts?.modeOptions) ? opts!.modeOptions! : [];
  const thinkingAll = Array.isArray(opts?.thinkingOptions) ? opts!.thinkingOptions! : [];
  const mode = effortLike(modeAll) ? modeAll : [];
  const thinking = effortLike(thinkingAll) ? thinkingAll : [];
  if (mode.length) groups.push({ field: "runtimeMode", label: opts?.modeLabel || "Effort", options: mode, current: pickCurrent(mode, provider?.runtimeMode) });
  if (thinking.length)
    groups.push({ field: "thinkingMode", label: opts?.thinkingLabel || "Thinking", options: thinking, current: pickCurrent(thinking, provider?.thinkingMode) });
  return groups;
}

/** "Default (medium)" → "Medium", "Default" → "Mặc định". */
export function effortShortLabel(label: string): string {
  const m = label.match(/^Default\s*\((.+)\)$/i);
  if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1);
  if (/^default$/i.test(label.trim())) return "Mặc định";
  return label;
}
export function effortMenuLabel(label: string): string {
  return label.replace(/^Default\b/i, "Mặc định");
}

/** 0 (none/off) … 4 (xhigh/max), for the signal-bars icon. */
export function effortLevel(option: RuntimeOption | undefined): number {
  if (!option) return 2;
  const id = (option.id || option.label.match(/\((.+)\)/)?.[1] || "").toLowerCase();
  if (id === "none" || id === "off") return 0;
  if (id === "low" || id === "minimal") return 1;
  if (id === "high" || id === "on") return 3;
  if (id === "xhigh" || id === "max" || id === "extra high") return 4;
  return 2;
}

/** The provider choice an effort change starts from: the pinned one when it is still what answers. */
export function baseChoice(data: Pick<ChatSettingsResponse, "settings" | "effective">): ChatProviderChoice {
  const pinned = data.settings.provider;
  const e = data.effective;
  if (pinned && pinned.type === e.type) return { ...pinned, ...(e.model ? { model: e.model } : {}) };
  return { type: e.type, ...(e.model ? { model: e.model } : {}) };
}

export function effortChoice(base: ChatProviderChoice, field: EffortField, id: string): ChatProviderChoice {
  const next: ChatProviderChoice = { ...base };
  if (id) next[field] = id;
  else delete next[field];
  return next;
}

// ── Context ────────────────────────────────────────────────────────────

export function toggleSource(sources: ContextSourceId[], id: ContextSourceId): ContextSourceId[] {
  return sources.includes(id) ? sources.filter((s) => s !== id) : [...sources, id];
}

// ── Attachments ────────────────────────────────────────────────────────

export const MAX_ATTACHMENTS = 3;
export const MAX_ATTACHMENT_CHARS = 50_000;
export const ATTACH_EXTENSIONS = [".txt", ".md", ".csv", ".json", ".log", ".ts", ".tsx", ".js", ".py", ".html", ".css", ".yaml", ".yml"];
export const ATTACH_ACCEPT = ATTACH_EXTENSIONS.join(",");
/** A UTF-8 character takes at most 4 bytes: a bigger file cannot fit, so it is refused before reading. */
export const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_CHARS * 4;

export interface Attachment {
  name: string;
  text: string;
}

export function attachmentAllowed(name: string): boolean {
  const lower = name.toLowerCase();
  return ATTACH_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Why a file cannot be attached, or null. `count` is how many are already attached. */
export function attachmentProblem(file: { name: string; size?: number; text?: string }, count: number): string | null {
  if (count >= MAX_ATTACHMENTS) return `Mỗi tin nhắn đính kèm tối đa ${MAX_ATTACHMENTS} tệp.`;
  if (!attachmentAllowed(file.name)) return `“${file.name}” không phải tệp văn bản được hỗ trợ.`;
  const tooLong = `“${file.name}” dài quá 50.000 ký tự. Hãy cắt bớt rồi đính kèm lại.`;
  if (file.size !== undefined && file.size > MAX_ATTACHMENT_BYTES) return tooLong;
  if (file.text !== undefined && file.text.length > MAX_ATTACHMENT_CHARS) return tooLong;
  return null;
}

// ── Send / mic errors ──────────────────────────────────────────────────

/** Friendly text for a refused send (429 too_many / busy, or the server's own message). */
export function sendErrorText(body: unknown, fallback: string): string {
  const b = (body && typeof body === "object" ? body : {}) as { error?: unknown; limit?: unknown };
  if (b.error === "too_many") {
    const limit = typeof b.limit === "number" && b.limit > 0 ? b.limit : 3;
    return `Đang có ${limit} cuộc chat trả lời cùng lúc. Chờ một cuộc xong rồi gửi.`;
  }
  if (b.error === "busy") return "Cuộc chat này đang trả lời. Chờ xong rồi gửi tiếp.";
  return typeof b.error === "string" && b.error ? b.error : fallback;
}

export function micErrorText(err: unknown): string {
  const name = (err as { name?: string } | null)?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError")
    return "Trình duyệt chưa cho phép dùng micro. Bật quyền micro cho trang này rồi thử lại.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "Không tìm thấy micro trên máy này.";
  if (name === "NotReadableError") return "Micro đang bị ứng dụng khác dùng.";
  return "Không bật được micro. Thử lại hoặc gõ phím.";
}

const RECORDER_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
/** First container the browser can record, preferring webm; "" lets the browser choose. */
export function recorderMimeType(supported: (type: string) => boolean): string {
  return RECORDER_TYPES.find((t) => {
    try {
      return supported(t);
    } catch {
      return false;
    }
  }) || "";
}
export function audioExtension(type: string): string {
  const base = type.split(";")[0].trim().toLowerCase();
  return base === "audio/ogg" ? "ogg" : base === "audio/mp4" ? "m4a" : base === "audio/mpeg" ? "mp3" : base === "audio/wav" ? "wav" : "webm";
}

/** "0:07", "12:30". */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Transcribed text goes into the draft, never sent: appended after what was typed. */
export function insertTranscript(draft: string, text: string): string {
  const clean = text.trim();
  if (!clean) return draft;
  if (!draft.trim()) return clean;
  return /\s$/.test(draft) ? `${draft}${clean}` : `${draft} ${clean}`;
}

// ── Starters ───────────────────────────────────────────────────────────

/** Empty-state chips: each one fills the composer, the owner finishes and sends. */
export const STARTERS = [
  { label: "Lên kế hoạch hôm nay", prompt: "Lên kế hoạch hôm nay cho tôi: việc nào quan trọng nhất và nên làm theo thứ tự nào?" },
  { label: "Tìm trong bộ nhớ", prompt: "Tìm trong bộ nhớ: " },
  { label: "Cùng nghĩ một ý tưởng", prompt: "Cùng nghĩ một ý tưởng về " },
];
