#!/usr/bin/env node
// License guard: no 8-line window of upstream ClaudeClaw code may appear in AIOS-Lite.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE = '/Users/tonyhoang/Developer/GitHub/claudeclaw-os';
const INDEX = path.join(ROOT, 'scripts/provenance/upstream-index.txt');
const ALLOW = path.join(ROOT, 'scripts/provenance/allow.txt');
const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.css', '.py', '.sh', '.sql', '.html', '.md', '.json', '.yaml', '.yml']);
const WIN = 8, MAX_BYTES = 1_500_000;
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'data', 'workspaces', '.git']);

const isTrivial = (l) =>
  l.length < 12 || /^[\s\W_]+$/.test(l) ||
  /^import\s.*\sfrom\s/.test(l) || /^import\s*['"]/.test(l) || /^export\s.*\sfrom\s/.test(l) || /^\}\s*from\s/.test(l) ||
  (/^(\/\/|\/\*|\*|#|<!--|--)/.test(l) && l.length < 30);

export function normLines(text) {
  const out = [];
  text.split('\n').forEach((raw, i) => {
    const l = raw.trim().replace(/\s+/g, ' ');
    if (!isTrivial(l)) out.push({ l, n: i + 1 });
  });
  return out;
}
const h = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
export function windows(text) {
  const ls = normLines(text), res = [];
  for (let i = 0; i + WIN <= ls.length; i++) {
    const w = ls.slice(i, i + WIN).map((x) => x.l).join('\n');
    res.push({ hash: h(w), line: ls[i].n, text: w });
  }
  return res;
}
const hasExt = (p) => EXTS.has(path.extname(p).toLowerCase());

export function buildIndex(source, ref = 'upstream/main') {
  const tree = spawnSync('git', ['-C', source, 'ls-tree', '-r', '-l', ref], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (tree.status !== 0) throw new Error(`git ls-tree ${ref} failed: ${tree.stderr}`);
  const blobs = [];
  for (const line of tree.stdout.split('\n')) {
    const m = /^\d+ blob (\w+)\s+(\d+)\t(.+)$/.exec(line);
    if (m && hasExt(m[3]) && +m[2] <= MAX_BYTES && !/(^|\/)(package-lock\.json|node_modules\/)/.test(m[3])) blobs.push(m[1]);
  }
  const cat = spawnSync('git', ['-C', source, 'cat-file', '--batch'], { input: [...new Set(blobs)].join('\n') + '\n', maxBuffer: 1 << 30 });
  if (cat.status !== 0) throw new Error('git cat-file --batch failed');
  const buf = cat.stdout, set = new Set();
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    const [, type, size] = buf.slice(pos, nl).toString().split(' ');
    const n = +size;
    if (type === 'blob') for (const w of windows(buf.slice(nl + 1, nl + 1 + n).toString('utf8'))) set.add(w.hash);
    pos = nl + 1 + n + 1;
  }
  const commit = spawnSync('git', ['-C', source, 'rev-parse', ref], { encoding: 'utf8' }).stdout.trim();
  return { commit, hashes: [...set].sort() };
}

export function loadIndex(file = INDEX) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return new Set(lines.filter((l) => !l.startsWith('#')));
}

function* files(dir, rel = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name) || r === 'web/dist' || r === 'scripts/provenance') continue;
      yield* files(path.join(dir, e.name), r);
    } else if (e.isFile()) yield r;
  }
}

export function check(root, index, allow = new Set()) {
  const hits = [], zalo = [];
  for (const rel of files(root)) {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    if (st.size > MAX_BYTES) continue;
    // Attribution files may name ZaloCRM; code outside modules/zalo may not.
    const ATTRIBUTION = ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md'];
    const scanZalo = !(rel.startsWith('modules/zalo/') || rel.startsWith('docs/') || rel.startsWith('scripts/') || ATTRIBUTION.includes(rel));
    const textual = hasExt(rel);
    if (!textual && !scanZalo) continue;
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    if (scanZalo && text.includes('ZaloCRM')) zalo.push(rel);
    if (!textual) continue;
    for (const w of windows(text)) {
      if (!index.has(w.hash)) continue;
      if (allow.has(w.hash) || allow.has(`${rel}:${w.line}`)) continue;
      hits.push({ file: rel, line: w.line, hash: w.hash, text: w.text });
    }
  }
  return { hits, zalo };
}

function main() {
  const a = process.argv.slice(2);
  const t0 = Date.now();
  if (a.includes('--build-index')) {
    const si = a.indexOf('--source');
    const source = path.resolve(si >= 0 ? a[si + 1] : process.env.AIOS_PORT_SOURCE || DEFAULT_SOURCE);
    const { commit, hashes } = buildIndex(source);
    fs.mkdirSync(path.dirname(INDEX), { recursive: true });
    fs.writeFileSync(INDEX, `# upstream-commit ${commit} window=${WIN} hashes=${hashes.length}\n${hashes.join('\n')}\n`);
    console.log(`index built: commit ${commit.slice(0, 7)}, ${hashes.length} hashes, ${Date.now() - t0} ms`);
    return;
  }
  if (!fs.existsSync(INDEX)) { console.error('missing index; run --build-index first'); process.exit(2); }
  const allow = fs.existsSync(ALLOW) ? new Set(fs.readFileSync(ALLOW, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) : new Set();
  const { hits, zalo } = check(ROOT, loadIndex(), allow);
  for (const x of hits) console.error(`${x.file}:${x.line}\n${x.text.split('\n').map((l) => '    | ' + l).join('\n')}`);
  for (const f of zalo) console.error(`${f}: contains "ZaloCRM" outside modules/zalo, docs, scripts`);
  console.log(`provenance: ${hits.length} hit(s), ${zalo.length} ZaloCRM mention(s), ${Date.now() - t0} ms`);
  process.exit(hits.length || zalo.length ? 1 : 0);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
