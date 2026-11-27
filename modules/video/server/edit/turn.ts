/**
 * Which agent directs a Video Studio project and how it is labelled in the UI. The director turn itself
 * lives in agent/director.ts (one lean agent turn through the module context).
 */

import { moduleCtx } from '../host.js';
import type { VideoEditAgent } from './types.js';

// Provider names the studio shows per runtime; a legacy codex agent reads as "openai" so old projects keep their provider.
const RUNTIME_PROVIDER: Record<string, string> = { codex: 'openai' };
const PROVIDER_LABEL: Record<string, string> = { genbot: 'GenBot', mock: 'Mock' };

/** Shown when "tạo video bằng trò chuyện" is asked for: it needs a file-reading agent, which GenBot is not. */
export const VIDEO_CREATE_OFF = 'Tạo video bằng trò chuyện đang tắt: việc này cần agent đọc được file và chạy công cụ (Claude, Codex), mà Open AgenticOS chỉ chạy agent bằng GenBot (chỉ trả lời bằng chữ). Dựng video quay sẵn vẫn dùng được.';

// Legacy agents (an engine of an earlier version) still show here so a project keeps its director's name; the engine
// refuses to run them (GenBot only), and creating from chat is switched off on GenBot (VIDEO_CREATE_OFF).
const agentsOf = () => moduleCtx()?.agents.list().filter((a) => a.enabled) ?? [];

export function resolveDefaultAgentId(): string {
  const wanted = String(moduleCtx()?.settings.get<string>('director_agent', '') ?? '').trim() || process.env.VIDEO_EDIT_AGENT?.trim();
  const ids = new Set(agentsOf().map((a) => a.id));
  if (wanted && ids.has(wanted)) return wanted;
  if (ids.has('video-editor')) return 'video-editor';
  // An agent that may act on the studio (create/produce turns answer with module actions).
  const ctx = moduleCtx();
  const capable = ctx ? agentsOf().find((a) => { try { return ctx.access.can(a.id, 'studio.write'); } catch { return false; } }) : undefined;
  return capable?.id ?? ctx?.agents.defaultId?.() ?? '';
}

export function engineLabelFor(type: string): string {
  return PROVIDER_LABEL[type] ?? 'Engine cũ (hãy chuyển sang GenBot)';
}

export function defaultAgentProvider(): { agentId: string; provider: string; engineLabel: string } | null {
  const agentId = resolveDefaultAgentId();
  const agent = agentsOf().find((a) => a.id === agentId);
  if (!agent) return null;
  const provider = RUNTIME_PROVIDER[agent.runtime] ?? agent.runtime;
  return { agentId, provider, engineLabel: engineLabelFor(provider) };
}

export function listVideoAgents(): VideoEditAgent[] {
  const defaultId = resolveDefaultAgentId();
  return agentsOf().map((a) => {
    const provider = RUNTIME_PROVIDER[a.runtime] ?? a.runtime;
    return {
      id: a.id, name: a.name, provider, engineLabel: engineLabelFor(provider),
      ...(a.model ? { model: a.model } : {}), isDefault: a.id === defaultId,
    };
  });
}
