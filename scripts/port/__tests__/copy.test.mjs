import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { runManifest, appendLog } from '../copy.mjs';

function mkRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-src-'));
  const sh = (c) => execSync(c, { cwd: d, stdio: 'pipe' });
  sh('git init -q && git config user.email a@b && git config user.name t');
  fs.mkdirSync(path.join(d, 'src/x'), { recursive: true });
  fs.writeFileSync(path.join(d, 'src/logger.ts'), 'export const a = 1;\n');
  sh('git add -A && git commit -qm up && git branch upstream-main-tmp && git update-ref refs/remotes/upstream/main HEAD');
  fs.writeFileSync(path.join(d, 'src/x/own.ts'), 'export const own = 2;\n');
  fs.writeFileSync(path.join(d, 'src/x/own.test.ts'), 'test\n');
  return d;
}

test('copies fork-only files, honours drop, no overwrite', () => {
  const src = mkRepo(), tgt = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-tgt-'));
  const m = { module: 'm', entries: [{ from: 'src/x', to: 'modules/m/server', kind: 'A', note: 'n' }], drop: [{ from: 'src/x/own.test.ts', reason: 'tests' }] };
  const r = runManifest(m, { source: src, targetRoot: tgt });
  assert.equal(r.copied, 1);
  assert.ok(fs.existsSync(path.join(tgt, 'modules/m/server/own.ts')));
  assert.ok(!fs.existsSync(path.join(tgt, 'modules/m/server/own.test.ts')));
  appendLog(m, r, { targetRoot: tgt });
  assert.match(fs.readFileSync(path.join(tgt, 'modules/m/PORTING.md'), 'utf8'), /\| src\/x\/own.ts \| modules\/m\/server\/own.ts \| A \| n \|/);
  fs.writeFileSync(path.join(tgt, 'modules/m/server/own.ts'), 'edited');
  const r2 = runManifest(m, { source: src, targetRoot: tgt });
  assert.equal(r2.copied, 0); assert.equal(r2.existing.length, 1);
  assert.equal(fs.readFileSync(path.join(tgt, 'modules/m/server/own.ts'), 'utf8'), 'edited');
  runManifest(m, { source: src, targetRoot: tgt, force: true });
  assert.equal(fs.readFileSync(path.join(tgt, 'modules/m/server/own.ts'), 'utf8'), 'export const own = 2;\n');
});

test('refuses upstream file and writes nothing', () => {
  const src = mkRepo(), tgt = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-tgt-'));
  const m = { module: 'm', entries: [{ from: 'src/x', to: 'a' }, { from: 'src/logger.ts', to: 'b/logger.ts' }] };
  const r = runManifest(m, { source: src, targetRoot: tgt });
  assert.deepEqual(r.refused, ['src/logger.ts']);
  assert.ok(!fs.existsSync(path.join(tgt, 'a')));
});

test('a manifest that lands in core logs to docs/dev/port, not modules/<id>', () => {
  const tgt = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-tgt-'));
  const m = { module: 'core-x', entries: [{ from: 'src/x', to: 'src/x', kind: 'B', note: '' }] };
  appendLog(m, { rows: [] }, { targetRoot: tgt });
  assert.ok(fs.existsSync(path.join(tgt, 'docs/dev/port/core-x.PORTING.md')));
  assert.ok(!fs.existsSync(path.join(tgt, 'modules/core-x')));
});
