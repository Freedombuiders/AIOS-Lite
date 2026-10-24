import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { buildIndex, check, windows } from '../check-provenance.mjs';

const code = (p) => Array.from({ length: 12 }, (_, i) => `const ${p}Value${i} = compute(${i}, 'argument-${p}');`).join('\n') + '\n';

test('index hits copied code, ignores original and allowlist', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-src-'));
  execSync('git init -q && git config user.email a@b && git config user.name t', { cwd: src });
  fs.writeFileSync(path.join(src, 'a.ts'), code('up'));
  execSync('git add -A && git commit -qm x && git update-ref refs/remotes/upstream/main HEAD', { cwd: src });
  const { hashes } = buildIndex(src);
  assert.ok(hashes.length >= 5);
  const index = new Set(hashes);
  const tgt = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-tgt-'));
  fs.mkdirSync(path.join(tgt, 'src')); fs.mkdirSync(path.join(tgt, 'modules/zalo'), { recursive: true }); fs.mkdirSync(path.join(tgt, 'node_modules'));
  fs.writeFileSync(path.join(tgt, 'src/own.ts'), code('mine'));
  fs.writeFileSync(path.join(tgt, 'node_modules/n.ts'), code('up'));
  fs.writeFileSync(path.join(tgt, 'modules/zalo/z.ts'), '// ZaloCRM ok here\n');
  assert.equal(check(tgt, index).hits.length, 0);
  fs.writeFileSync(path.join(tgt, 'src/copied.ts'), '// header\n' + code('up').replace(/  +/g, ' '));
  const r = check(tgt, index);
  assert.ok(r.hits.length >= 5);
  assert.equal(r.hits[0].file, 'src/copied.ts');
  assert.equal(r.hits[0].line, 2);
  const allow = new Set(r.hits.map((h) => `${h.file}:${h.line}`));
  assert.equal(check(tgt, index, allow).hits.length, 0);
  fs.writeFileSync(path.join(tgt, 'src/leak.ts'), '// from ZaloCRM project\n');
  assert.deepEqual(check(tgt, index, allow).zalo, ['src/leak.ts']);
});
test('trivial lines are skipped', () => {
  const t = "import a from 'x';\n}\n// short\n" + code('q');
  assert.equal(windows(t)[0].line, 4);
});
