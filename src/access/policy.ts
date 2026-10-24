import path from 'node:path';
import type { AgentRegistry } from '../agents/contracts.js';
import type { AgentConfig } from '../core/types.js';
import type { BrainService, SkillLibrary } from '../shared/contracts.js';
import { globBaseDir, matchAnyGlob, matchGlob, normalizeRel } from '../shared/glob.js';
import type { AccessPolicy, ConnectionsService, DirGrant, EffectiveAccess, McpGrant } from './contracts.js';

export interface AccessPolicyDeps {
  agents: Pick<AgentRegistry, 'get'>;
  brain: Pick<BrainService, 'folders'>;
  connections: Pick<ConnectionsService, 'get' | 'resolveEnv'>;
  skills: Pick<SkillLibrary, 'resolve'>;
  isModuleEnabled: (moduleId: string) => boolean;
}

export function createAccessPolicy(deps: AccessPolicyDeps): AccessPolicy {
  const { brain, connections, skills, isModuleEnabled } = deps;

  function dirGrants(agent: AgentConfig, kind: 'read' | 'write'): DirGrant[] {
    const out: DirGrant[] = [];
    for (const [folderId, grant] of Object.entries(agent.access.brain)) {
      const globs = grant[kind];
      const folder = brain.folders().find((f) => f.id === folderId);
      if (!folder || !globs.length) continue;
      out.push({ folderId, root: folder.path, globs: [...globs] });
    }
    return out;
  }

  const addDirsOf = (grants: DirGrant[]): string[] => {
    const dirs: string[] = [];
    for (const g of grants) for (const glob of g.globs) dirs.push(path.join(g.root, ...globBaseDir(glob).split('/').filter(Boolean)));
    return dirs;
  };

  function resolve(agent: AgentConfig, task?: { contextProfile?: string }): EffectiveAccess {
    const readDirs = dirGrants(agent, 'read');
    const writeDirs = dirGrants(agent, 'write');

    const mcpServers: McpGrant[] = [];
    const envVars: Record<string, string> = {};
    for (const [id, grant] of Object.entries(agent.access.connections)) {
      const c = connections.get(id);
      if (!c) continue;
      if (c.type === 'mcp') {
        const env = connections.resolveEnv(c);
        if (Object.values(env).some((v) => v === '')) continue; // unresolved secret: do not start a broken server
        mcpServers.push({
          id,
          ...(c.command ? { command: c.command } : {}),
          ...(c.args ? { args: c.args } : {}),
          ...(c.url ? { url: c.url } : {}),
          env,
          allowedTools: grant === true ? ['*'] : [...grant],
        });
      } else if (c.type === 'env') {
        for (const [k, v] of Object.entries(connections.resolveEnv(c))) if (v) envVars[k] = v;
      }
      // composio grants are ignored: modules use Composio server-side
    }

    const moduleScopes: Record<string, string[]> = {};
    for (const [moduleId, scopes] of Object.entries(agent.access.modules)) {
      if (scopes.length && isModuleEnabled(moduleId)) moduleScopes[moduleId] = [...scopes];
    }

    return {
      agentId: agent.id,
      readDirs,
      writeDirs,
      addDirs: [...new Set([...addDirsOf(readDirs), ...addDirsOf(writeDirs)])],
      memory: { ...agent.access.memory },
      mcpServers,
      envVars,
      skills: skills.resolve(agent.access.skills),
      moduleScopes,
      permission: agent.permission,
      tools: task?.contextProfile === 'lean' ? 'none' : 'default',
    };
  }

  function pathAllowed(agentId: string, folderId: string, relPath: string, kind: 'read' | 'write'): boolean {
    const agent = deps.agents.get(agentId);
    const grant = agent?.access.brain[folderId];
    if (!agent || !grant) return false;
    if (!brain.folders().some((f) => f.id === folderId)) return false;
    const rel = normalizeRel(relPath);
    if (rel === null) return false;
    return matchAnyGlob(grant[kind], rel);
  }

  return {
    resolve,
    snapshot(a) {
      const { mcpServers, envVars, skills: sk, ...rest } = a;
      return {
        ...rest,
        mcpServers: mcpServers.map((m) => ({ id: m.id, allowedTools: [...m.allowedTools] })),
        envVars: Object.keys(envVars),
        skills: sk.map((s) => s.id),
      };
    },
    can(agentId, moduleId, scope) {
      const agent = deps.agents.get(agentId);
      if (!agent || !agent.enabled || !isModuleEnabled(moduleId)) return false;
      const scopes = agent.access.modules[moduleId] ?? [];
      return scopes.some((s) => s === '*' || s === scope || matchGlob(s, scope));
    },
    canReadPath: (a, f, p) => pathAllowed(a, f, p, 'read'),
    canWritePath: (a, f, p) => pathAllowed(a, f, p, 'write'),
  };
}
