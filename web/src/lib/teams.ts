// Types and small helpers for Gói Team, Chợ Agent and Đề xuất cải tiến (docs/dev/API-teams.md).
import type { RuntimeId } from '@core/types';

export const RUNTIMES: RuntimeId[] = ['claude', 'codex', 'grok', 'hermes', 'mock'];

export interface TeamInputDecl { key: string; label: string; description: string; kind: 'plain' | 'secret'; required: boolean; defaultValue: string }
export interface TeamAgentDecl { id: string; name: string; description: string; runtime: RuntimeId | null; model: string | null; skills: string[]; fileCount: number }
export interface TeamSummary {
  slug: string; name: string; version: string; description: string; tags: string[]; manager: string;
  agents: TeamAgentDecl[]; schedules: { id: string; agent: string; cron: string; tz: string | null }[];
  requiredSkills: string[]; prerequisites: string[]; inputs: TeamInputDecl[]; warnings: string[];
  source: { kind: 'catalog' | 'import'; id: string };
}
export interface InstallRecord { at: string; slug: string; name: string; agents: string[]; schedules: number; skills: string[] }
export interface TeamsList { items: TeamSummary[]; imported: TeamSummary[]; problems: { name: string; errors: string[] }[]; history: InstallRecord[] }

export type Strategy = 'rename' | 'skip';
export interface AgentPlan { pkgId: string; name: string; description: string; finalId: string; action: 'create' | 'skip'; collision: boolean; runtime: RuntimeId; model: string | null; skills: string[]; files: string[]; reportsTo: string | null }
export interface InstallPlan {
  team: { slug: string; name: string; version: string; description: string; manager: string; prerequisites: string[]; body: string };
  strategy: Strategy;
  agents: AgentPlan[];
  schedules: { id: string; name: string; finalAgentId: string; cron: string; tz: string; willCreate: boolean; skipReason: string | null }[];
  skills: { id: string; bundled: boolean; exists: boolean }[];
  inputs: (TeamInputDecl & { provided: boolean })[];
  missingInputs: string[];
  warnings: string[];
  blockers: string[];
  canInstall: boolean;
}
export interface InstallResult {
  slug: string; name: string;
  agents: { pkgId: string; id: string; name: string; runtime: RuntimeId }[];
  skills: string[];
  schedules: { id: number; name: string; agentId: string; cron: string }[];
  warnings: string[]; nextSteps: string[];
}

export interface MarketField { key: string; label: string; required: boolean; multiline: boolean; placeholder: string; help: string; defaultValue: string }
export interface MarketTemplate {
  id: string; name: string; category: string; description: string; outcome: string; capabilities: string[]; examples: string[];
  fields: MarketField[]; skills: { id: string; name: string; description: string }[];
}
export interface MarketPreview {
  templateId: string; agentId: string; name: string; runtime: RuntimeId;
  files: { path: string; kind: 'persona' | 'knowledge' | 'skill'; description: string; content: string }[];
  newSkills: string[]; existingSkills: string[]; missingRequired: string[]; warnings: string[];
}
export interface MarketCatalog { templates: MarketTemplate[]; teams: TeamSummary[] }

export type RecoArm = 'agents' | 'work' | 'skills' | 'brain' | 'modules';
export type RecoStatus = 'new' | 'cart' | 'done' | 'skipped';
export interface Reco {
  id: string; arm: RecoArm; title: string; benefit: string; actionText: string; actionKind: 'task' | 'grant-brain' | 'add-module';
  effort: 'xs' | 's' | 'm' | 'l'; priority: 1 | 2 | 3; evidence: string[]; status: RecoStatus; result: string | null; decidedAt: string | null;
}
export interface RecosList { items: Reco[]; counts: Record<string, number> }

export const ARM_LABEL: Record<RecoArm, string> = { agents: 'Agent', work: 'Công việc', skills: 'Skill', brain: 'Second Brain', modules: 'Module' };
export const EFFORT_LABEL: Record<Reco['effort'], string> = { xs: 'rất nhanh', s: 'nhanh', m: 'vừa', l: 'lâu' };
export const PRIORITY_LABEL: Record<Reco['priority'], string> = { 1: 'Ưu tiên cao', 2: 'Ưu tiên vừa', 3: 'Ưu tiên thấp' };

export function downloadBase64(filename: string, base64: string, mime = 'application/zip'): void {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('Không đọc được file.'));
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.readAsDataURL(file);
  });
}
