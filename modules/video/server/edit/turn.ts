/**
 * Which agent directs a Video Studio project and how it is labelled in the UI. The director turn itself
 * lives in agent/director.ts (one lean agent turn through the module context).
 */

import { moduleCtx } from '../host.js';
import type { VideoEditAgent } from './types.js';

const RUNTIME_PROVIDER: Record<string, string> = { claude: 'claude', codex: 'openai', grok: 'grok', hermes: 'hermes', genbot: 'genbot', mock: 'mock' };
const RUNTIME_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok', hermes: 'Hermes', genbot: 'GenBot', mock: 'Mock' };

/** Shown when "tạo video bằng trò chuyện" is asked for: it needs a file-reading agent, which GenBot is not. */
export const VIDEO_CREATE_OFF = 'Tạo video bằng trò chuyện đang tắt: việc này cần agent đọc được file và chạy công cụ (Claude, Codex), mà Open AgenticOS chỉ chạy agent bằng GenBot (chỉ trả lời bằng chữ). Dựng video quay sẵn vẫn dùng được.';

// Legacy agents (claude, codex…) still show here so a project keeps its director's name; the engine refuses to run
// them (GenBot only), and creating from chat is switched off on GenBot (VIDEO_CREATE_OFF).
const agentsOf = () => moduleCtx()?.agents.list().filter((a) => a.enabled) ?? [];

export function resolveDefaultAgentId(): string {
  const wanted = String(moduleCtx()?.settings.get<string>('director_agent', '') ?? '').trim() || process.env.VIDEO_EDIT_AGENT?.trim();
  const ids = new Set(agentsOf().map((a) => a.id));
  if (wanted && ids.has(wanted)) return wanted;
  if (ids.has('video-editor')) return 'video-editor';
  // An agent that may act on the studio (create/produce turns answer with module actions).
  const ctx = moduleCtx();
  const capable = ctx ? agentsOf().find((a) => { try { return ctx.access.can(a.id, 'studio.write'); } catch { return false; } }) : undefined;
  return capable?.id ?? 'main';
}

export function engineLabelFor(type: string): string {
  return RUNTIME_LABEL[Object.keys(RUNTIME_PROVIDER).find((k) => RUNTIME_PROVIDER[k] === type) ?? ''] ?? type;
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
