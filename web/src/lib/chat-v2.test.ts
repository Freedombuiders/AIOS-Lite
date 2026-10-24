import { describe, expect, it } from "vitest";
import {
  attachmentProblem,
  baseChoice,
  currentTabKey,
  effectiveEndpoint,
  effortChoice,
  effortGroups,
  effortLevel,
  effortMenuLabel,
  effortShortLabel,
  filterModels,
  formatClock,
  insertTranscript,
  isSettingsResponse,
  MAX_ATTACHMENT_CHARS,
  modelChoice,
  pickerTabs,
  recorderMimeType,
  audioExtension,
  sendErrorText,
  micErrorText,
  toggleSource,
  type ChatSettingsResponse,
} from "./chat-v2";

const providers = [
  { type: "claude", label: "Claude", tier: "stable" as const },
  { type: "openai", label: "OpenAI", tier: "stable" as const },
  { type: "openrouter", label: "OpenRouter", tier: "experimental" as const },
];
const endpoints = [
  { id: "openrouter", label: "OpenRouter", local: false, ready: true, detail: "Đã có khoá API." },
  { id: "xai", label: "xAI (Grok)", local: false, ready: false, detail: "Thêm XAI_API_KEY vào cấu hình máy chủ." },
  { id: "ollama", label: "Ollama (máy này)", local: true, ready: true, detail: "Đang chạy trên máy này." },
];
const data = (over: Partial<ChatSettingsResponse> = {}): ChatSettingsResponse => ({
  settings: { context: { enabled: true, sources: ["memory"] } },
  effective: { type: "claude", label: "Claude", model: "claude-opus-5-5", modelLabel: "Opus 5.5", overridden: false },
  providers,
  ...over,
});

describe("picker tabs", () => {
  it("lists providers, then endpoints in place of the openrouter provider", () => {
    const tabs = pickerTabs(providers, endpoints);
    expect(tabs.map((t) => t.key)).toEqual(["claude", "openai", "ep:openrouter", "ep:xai", "ep:ollama"]);
    expect(tabs.map((t) => t.short)).toEqual(["Claude", "OpenAI", "OpenRouter", "xAI", "Ollama"]);
    expect(tabs.find((t) => t.key === "ep:xai")).toMatchObject({ ready: false, detail: "Thêm XAI_API_KEY vào cấu hình máy chủ.", type: "openrouter" });
  });
  it("keeps the openrouter provider tab when the server has no endpoint list", () => {
    expect(pickerTabs(providers, []).map((t) => t.key)).toEqual(["claude", "openai", "openrouter"]);
  });
  it("finds the current tab, including an endpoint", () => {
    const tabs = pickerTabs(providers, endpoints);
    expect(currentTabKey(data(), tabs)).toBe("claude");
    const onXai = data({
      settings: { provider: { type: "openrouter", endpoint: "xai", model: "grok-4" }, context: { enabled: true, sources: [] } },
      effective: { type: "openrouter", label: "OpenRouter", model: "grok-4", modelLabel: "grok-4", overridden: true },
    });
    expect(currentTabKey(onXai, tabs)).toBe("ep:xai");
    expect(effectiveEndpoint(onXai)).toBe("xai");
    expect(effectiveEndpoint(data())).toBeUndefined();
  });
  it("builds the PATCH choice: plain OpenRouter carries no endpoint", () => {
    const tabs = pickerTabs(providers, endpoints);
    expect(modelChoice(tabs[0], "claude-sonnet-5")).toEqual({ type: "claude", model: "claude-sonnet-5" });
    expect(modelChoice(tabs[2], "deepseek/x")).toEqual({ type: "openrouter", model: "deepseek/x" });
    expect(modelChoice(tabs[4], "llama3")).toEqual({ type: "openrouter", model: "llama3", endpoint: "ollama" });
  });
  it("filters models by label or id", () => {
    const models = [{ id: "gpt-6-astra", label: "GPT-6 Astra" }, { id: "gpt-5.5", label: "GPT-5.5" }];
    expect(filterModels(models, "astra")).toEqual([models[0]]);
    expect(filterModels(models, " 5.5 ")).toEqual([models[1]]);
    expect(filterModels(models, "")).toEqual(models);
  });
  it("only trusts a full settings payload", () => {
    expect(isSettingsResponse({ ok: true })).toBe(false);
    expect(isSettingsResponse({})).toBe(false);
    expect(isSettingsResponse(data())).toBe(true);
  });
});

describe("effort", () => {
  const claude = {
    modeLabel: "Effort",
    thinkingLabel: "Thinking",
    modeOptions: [
      { id: "", label: "Default (medium)" },
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra high" },
    ],
    thinkingOptions: [],
  };
  it("uses runtime modes first, then thinking options", () => {
    const groups = effortGroups(claude);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ field: "runtimeMode", current: "" });
    expect(effortGroups(claude, { type: "claude", runtimeMode: "high" })[0].current).toBe("high");
    const openai = effortGroups({ thinkingLabel: "Reasoning effort", modeOptions: [], thinkingOptions: [{ id: "", label: "Default (medium)" }, { id: "low", label: "Low" }] });
    expect(openai[0]).toMatchObject({ field: "thinkingMode", label: "Reasoning effort" });
    expect(effortGroups({ modeOptions: [], thinkingOptions: [] })).toEqual([]);
    // Harness advertises workspace-access modes, which are not an effort dial.
    expect(effortGroups({ modeLabel: "Workspace access", modeOptions: [{ id: "workspace-write", label: "Read and write workspace" }], thinkingOptions: [] })).toEqual([]);
    expect(effortGroups(null)).toEqual([]);
  });
  it("labels and levels", () => {
    expect(effortShortLabel("Default (medium)")).toBe("Medium");
    expect(effortShortLabel("Default")).toBe("Mặc định");
    expect(effortShortLabel("Extra high")).toBe("Extra high");
    expect(effortMenuLabel("Default (high)")).toBe("Mặc định (high)");
    expect(effortLevel({ id: "", label: "Default (medium)" })).toBe(2);
    expect(effortLevel({ id: "none", label: "None" })).toBe(0);
    expect(effortLevel({ id: "low", label: "Low" })).toBe(1);
    expect(effortLevel({ id: "high", label: "High" })).toBe(3);
    expect(effortLevel({ id: "max", label: "Max" })).toBe(4);
  });
  it("changes only the chosen field on top of the provider that answers", () => {
    const base = baseChoice(data());
    expect(base).toEqual({ type: "claude", model: "claude-opus-5-5" });
    expect(effortChoice(base, "runtimeMode", "high")).toEqual({ type: "claude", model: "claude-opus-5-5", runtimeMode: "high" });
    expect(effortChoice({ ...base, runtimeMode: "high" }, "runtimeMode", "")).toEqual(base);
    const pinned = data({
      settings: { provider: { type: "openrouter", endpoint: "ollama", model: "llama3", thinkingMode: "low" }, context: { enabled: true, sources: [] } },
      effective: { type: "openrouter", label: "OpenRouter", model: "llama3", modelLabel: null, overridden: true },
    });
    expect(baseChoice(pinned)).toEqual({ type: "openrouter", endpoint: "ollama", model: "llama3", thinkingMode: "low" });
  });
});

describe("context, attachments, send and mic", () => {
  it("toggles a source", () => {
    expect(toggleSource(["memory", "agents"], "agents")).toEqual(["memory"]);
    expect(toggleSource(["memory"], "obsidian")).toEqual(["memory", "obsidian"]);
  });
  it("refuses a fourth file, a binary type and anything past 50,000 characters", () => {
    expect(attachmentProblem({ name: "a.md", text: "x" }, 0)).toBeNull();
    expect(attachmentProblem({ name: "a.md", text: "x" }, 3)).toMatch(/tối đa 3 tệp/);
    expect(attachmentProblem({ name: "photo.png", size: 10 }, 0)).toMatch(/không phải tệp văn bản/);
    expect(attachmentProblem({ name: "big.txt", text: "x".repeat(MAX_ATTACHMENT_CHARS + 1) }, 0)).toMatch(/50\.000 ký tự/);
    expect(attachmentProblem({ name: "huge.log", size: MAX_ATTACHMENT_CHARS * 4 + 1 }, 0)).toMatch(/50\.000 ký tự/);
    expect(attachmentProblem({ name: "ok.YAML", size: 100 }, 1)).toBeNull();
  });
  it("explains a refused send", () => {
    expect(sendErrorText({ error: "too_many", limit: 3 }, "x")).toBe("Đang có 3 cuộc chat trả lời cùng lúc. Chờ một cuộc xong rồi gửi.");
    expect(sendErrorText({ error: "busy" }, "x")).toMatch(/đang trả lời/);
    expect(sendErrorText({ error: "Không tìm thấy agent x" }, "x")).toBe("Không tìm thấy agent x");
    expect(sendErrorText(null, "POST failed")).toBe("POST failed");
  });
  it("mic helpers", () => {
    expect(micErrorText({ name: "NotAllowedError" })).toMatch(/quyền micro/);
    expect(micErrorText({ name: "NotFoundError" })).toMatch(/Không tìm thấy micro/);
    expect(recorderMimeType((t) => t === "audio/webm")).toBe("audio/webm");
    expect(recorderMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(recorderMimeType(() => false)).toBe("");
    expect(audioExtension("audio/webm;codecs=opus")).toBe("webm");
    expect(audioExtension("audio/mp4")).toBe("m4a");
    expect(formatClock(7)).toBe("0:07");
    expect(formatClock(750)).toBe("12:30");
    expect(insertTranscript("", " xin chào ")).toBe("xin chào");
    expect(insertTranscript("Ghi chú:", "mua sữa")).toBe("Ghi chú: mua sữa");
    expect(insertTranscript("a ", "b")).toBe("a b");
    expect(insertTranscript("giữ nguyên", "  ")).toBe("giữ nguyên");
  });
});
