// Brain folder admin + skill roots, built once per AppDeps (the frozen AppDeps shape has no slot for them).
import path from 'node:path';
import type { AppDeps } from '../core/deps.js';
import { createBrainAdmin, type BrainAdmin } from './brain-admin.js';
import { createSkillRoots, type SkillRoots } from './skill-roots.js';

export interface AdminServices {
  brainAdmin: BrainAdmin;
  skillRoots: SkillRoots;
}

const cache = new WeakMap<AppDeps, AdminServices>();

export function adminServices(deps: AppDeps): AdminServices {
  let s = cache.get(deps);
  if (!s) {
    const { config } = deps;
    s = {
      brainAdmin: createBrainAdmin({
        brain: deps.brain,
        db: deps.db,
        agents: deps.agents,
        configFile: config.brainConfigFile,
        rootDir: config.rootDir,
        forbidden: [config.dataDir, path.join(config.rootDir, 'data')],
      }),
      skillRoots: createSkillRoots({
        library: deps.skills,
        configFile: path.join(config.configDir, 'skills.yaml'),
        rootDir: config.rootDir,
        envDirs: config.skillsDirs,
        brainFolders: () => deps.brain.folders(),
      }),
    };
    cache.set(deps, s);
  }
  return s;
}
