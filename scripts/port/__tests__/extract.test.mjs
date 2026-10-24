import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSections, extract, parseTables, listMarkers } from '../extract-db-sections.mjs';

const src = `const s = \`
  CREATE TABLE IF NOT EXISTS base_table (id INTEGER);
  -- @foo-schema:a
  CREATE TABLE IF NOT EXISTS foo_a (id INTEGER);
  CREATE INDEX IF NOT EXISTS idx_foo ON foo_a(id);
  -- @foo-schema:b
  CREATE VIRTUAL TABLE IF NOT EXISTS foo_fts USING fts5(x);
  CREATE TABLE IF NOT EXISTS base_table (id INTEGER);
  \`;
  // @foo-migrations:a
  addColumnIfMissing(database, 'foo_a', 'x', 'TEXT');
  addColumnIfMissing(database, 'foo_a', 'y', 'TEXT');

  other();
// @foo-db:core
export function getFoo() { return db.prepare('select 1 from foo_a').get(); }
// @bar-db
export function bar() { return 1 + 1 + 1 + 1; }
`;
test('sections and boundaries', () => {
  const s = parseSections(src);
  assert.equal(s.length, 5);
  assert.equal(s[1].lines.length, 3); // stops before the closing backtick
  assert.equal(s[2].lines.length, 3); // blank line ends migrations
  assert.equal(s[3].lines.length, 2);
});
test('extract, flag upstream lines, tables', () => {
  const up = 'x1 = 1;\n  CREATE TABLE IF NOT EXISTS base_table (id INTEGER);\n  \\`;\n';
  const r = extract(src, up, ['foo']);
  assert.equal(r.flagged.length, 0); // single shared line is not a run
  const up3 = src.split('\n').slice(1, 8).join('\n');
  const r2 = extract(src, up3, ['foo'], { excludeFlagged: true });
  assert.ok(extract(src, up3, ['foo']).flagged.length >= 3);
  assert.ok(!r2.out.schema.join('').includes('foo_a (id'));
  assert.ok(!r.out.db.join('').includes('bar()'));
  const t = parseTables(r.out.schema.join('\n'));
  assert.deepEqual(t.tables.sort(), ['base_table', 'foo_a']);
  assert.deepEqual(t.virtualTables, ['foo_fts']);
  assert.deepEqual(t.indexes, [{ name: 'idx_foo', table: 'foo_a' }]);
});
test('list', () => {
  assert.equal(listMarkers(src).byPrefix['@foo'], 4);
});
