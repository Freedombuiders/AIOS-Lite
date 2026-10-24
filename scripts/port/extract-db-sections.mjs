#!/usr/bin/env node
// Extract the owner's marker-delimited SQL/TS sections from the source src/db.ts.
//
// Marker forms (SQL lines start "-- @", TS lines "// @"):
//   @<prefix>-schema[:name]      inside the createSchema SQL template
//   @<prefix>-db[:name]          module-level TS functions
//   @<prefix>-migrations[:name]  steps inside runMigrations
// Boundary rule (verified against db.ts):
//   A section STARTS at its marker line (marker line included) and ENDS just before
//   the first of: (a) the next marker line of ANY prefix/kind, (b) for schema: the
//   line containing the closing backtick of the SQL template, (c) for migrations:
//   the first blank line after content, (d) EOF (db sections).
//   Trailing blank lines are trimmed. Runs of >= 3 consecutive non-trivial lines (trimmed
//   length >= 12) that also appear consecutively in upstream/main:src/db.ts are
//   reported (exit 2); with --exclude-flagged they are dropped.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// the private source repo the port came from; set AIOS_PORT_SOURCE or keep it next to this repo
const DEFAULT_SOURCE = process.env.AIOS_PORT_SOURCE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'claudeclaw-os');
const MARKER = /^\s*(?:--|\/\/)\s*@([a-z0-9]+)-(schema|db|migrations)(?::([\w-]+))?\s*$/;
const ANY_MARKER = /^\s*(?:--|\/\/)\s*@[a-z0-9]+-(?:schema|db|migrations)\b/;

export function parseSections(text) {
  const lines = text.split('\n');
  const secs = [];
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER.exec(lines[i]);
    if (!m) continue;
    const [, prefix, kind, name = ''] = m;
    let end = lines.length, hasContent = false;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (ANY_MARKER.test(l)) { end = j; break; }
      if (kind === 'schema' && l.includes('`')) { end = j; break; }
      if (kind === 'migrations') {
        if (l.trim() === '') { if (hasContent) { end = j; break; } } else hasContent = true;
      }
    }
    while (end > i + 1 && lines[end - 1].trim() === '') end--;
    secs.push({ prefix, kind, name, start: i + 1, end, lines: lines.slice(i, end) });
  }
  return secs;
}

export function listMarkers(text) {
  const byPrefix = {}, byKind = {};
  for (const s of parseSections(text)) {
    byPrefix[`@${s.prefix}`] = (byPrefix[`@${s.prefix}`] || 0) + 1;
    const k = `@${s.prefix}-${s.kind}`;
    byKind[k] = (byKind[k] || 0) + 1;
  }
  return { byPrefix, byKind };
}

export function parseTables(sql) {
  const tables = new Set(), virtual = new Set(), indexes = [];
  for (const m of sql.matchAll(/CREATE\s+VIRTUAL\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/gi)) virtual.add(m[1]);
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/gi)) tables.add(m[1]);
  for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s+ON\s+["`]?(\w+)/gi)) indexes.push({ name: m[1], table: m[2] });
  return { tables: [...tables], virtualTables: [...virtual], indexes };
}

const norm = (l) => l.trim().replace(/\s+/g, ' ');
const git = (source, args) => spawnSync('git', ['-C', source, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });

// A line is flagged only when it sits in a run of >= 3 consecutive non-trivial lines
// (trimmed length >= 12) that also appears consecutively in upstream db.ts; single
// boilerplate lines ("id INTEGER PRIMARY KEY,") would otherwise drown the report.
const RUN = 3;
function nontrivial(lines) {
  const r = [];
  lines.forEach((l, i) => { const n = norm(l); if (n.length >= 12) r.push({ n, i }); });
  return r;
}
export function extract(text, upstreamText, prefixes, { excludeFlagged = false } = {}) {
  const upNT = nontrivial(upstreamText.split('\n')).map((x) => x.n);
  const up = new Set();
  for (let i = 0; i + RUN <= upNT.length; i++) up.add(upNT.slice(i, i + RUN).join('\n'));
  const secs = parseSections(text).filter((s) => prefixes.includes(s.prefix));
  const flagged = [];
  const out = { schema: [], db: [], migrations: [] };
  for (const s of secs) {
    const nt = nontrivial(s.lines), bad = new Set();
    for (let i = 0; i + RUN <= nt.length; i++) {
      if (up.has(nt.slice(i, i + RUN).map((x) => x.n).join('\n'))) for (let k = 0; k < RUN; k++) bad.add(nt[i + k].i);
    }
    const kept = [];
    s.lines.forEach((l, k) => {
      if (bad.has(k)) {
        flagged.push({ section: `@${s.prefix}-${s.kind}${s.name ? ':' + s.name : ''}`, line: s.start + k, text: l.trim() });
        if (excludeFlagged) return;
      }
      kept.push(l);
    });
    out[s.kind].push(kept.join('\n'));
  }
  return { out, flagged, count: secs.length };
}

function main() {
  const a = process.argv.slice(2);
  const val = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const prefixes = a.flatMap((x, i) => (x === '--prefix' ? [a[i + 1]] : []));
  const source = path.resolve(val('--source') || process.env.AIOS_PORT_SOURCE || DEFAULT_SOURCE);
  const text = fs.readFileSync(path.join(source, 'src/db.ts'), 'utf8');
  if (a.includes('--list')) {
    const { byPrefix, byKind } = listMarkers(text);
    console.log('Marker prefixes:'); for (const [k, v] of Object.entries(byPrefix)) console.log(`  ${k}: ${v}`);
    console.log('By kind:'); for (const [k, v] of Object.entries(byKind)) console.log(`  ${k}: ${v}`);
    return;
  }
  const outDir = val('--out');
  if (!prefixes.length || !outDir) { console.error('usage: extract-db-sections.mjs --prefix zalo [--prefix email] --out <dir> | --list'); process.exit(2); }
  const upRes = git(source, ['show', 'upstream/main:src/db.ts']);
  if (upRes.status !== 0) { console.error('cannot read upstream/main:src/db.ts'); process.exit(1); }
  const { out, flagged, count } = extract(text, upRes.stdout, prefixes, { excludeFlagged: a.includes('--exclude-flagged') });
  if (!count) { console.error(`no sections for prefixes: ${prefixes}`); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true });
  const hdr = (what) => `// ${what}\n// Extracted verbatim from GỐC src/db.ts (prefixes: ${prefixes.join(', ')}).\n// The original module-level \`db\` handle must be replaced by an injected handle.\n\n`;
  const schema = out.schema.join('\n\n') + '\n';
  fs.writeFileSync(path.join(outDir, 'schema.sql'), schema);
  fs.writeFileSync(path.join(outDir, 'store.extracted.ts'), hdr('DB access functions') + out.db.join('\n\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'migrations.extracted.ts'), hdr('Migration steps (inside runMigrations; `database` is the handle there)') + out.migrations.join('\n\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'tables.json'), JSON.stringify(parseTables(schema), null, 2) + '\n');
  const t = parseTables(schema);
  console.log(`sections=${count} tables=${t.tables.concat(t.virtualTables).join(', ')}`);
  if (flagged.length) {
    console.error(`WARNING ${flagged.length} line(s) also exist in upstream db.ts:`);
    for (const f of flagged) console.error(`  ${f.section} L${f.line}: ${f.text}`);
    process.exitCode = 2;
  }
}
import { fileURLToPath } from 'node:url';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
