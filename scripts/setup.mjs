#!/usr/bin/env node
// `npm run setup -- [options]`: runs install.sh (macOS, Linux) or install.ps1 (Windows) from the repo root,
// passing the options through. Kept in plain JavaScript so it runs before `npm ci`.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const run =
  process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'install.ps1'), ...args], { cwd: root, stdio: 'inherit' })
    : spawnSync('bash', [path.join(root, 'install.sh'), ...args], { cwd: root, stdio: 'inherit' });
if (run.error) {
  console.error(`Không chạy được trình cài: ${run.error.message}`);
  process.exit(1);
}
process.exit(run.status ?? 1);
