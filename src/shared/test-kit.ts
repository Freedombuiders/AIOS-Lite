// Test helpers for the agents/access/shared layers (not part of the build).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentRegistry } from '../agents/registry.js';
import { migrateCore, openDb } from '../core/db.js';
import { createEventBus } from '../core/events.js';
import { createLogger } from '../core/log.js';
import { createBrainService } from './brain.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function tmpDir(prefix = 'aios-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function memDb() {
  const db = openDb(':memory:');
  migrateCore(db);
  return db;
}

export const testLog = createLogger({ level: 'silent' });
export const testBus = () => createEventBus();

export function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A temp repo with the sample brain config (3 folders) and its own notes. */
export function sampleBrain(db = memDb()) {
  const root = tmpDir();
  fs.cpSync(path.join(REPO_ROOT, 'brain'), path.join(root, 'brain'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'config'), path.join(root, 'config'), { recursive: true });
  const brain = createBrainService({ db, configFile: path.join(root, 'config', 'brain.yaml'), rootDir: root, log: testLog });
  return { root, db, brain };
}

export function tempRegistry() {
  const root = tmpDir();
  const agentsDir = path.join(root, 'agents');
  fs.mkdirSync(agentsDir);
  return { root, agentsDir, workspacesDir: path.join(root, 'workspaces'), registry: (r = { agentsDir, workspacesDir: path.join(root, 'workspaces') }) => createAgentRegistry(r) };
}
