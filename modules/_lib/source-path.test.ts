import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourcePath } from './source-path.js';

describe('sourcePath', () => {
  it('maps dist/modules/<id>/… to modules/<id>/… when the compiled copy has no such file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srcpath-'));
    fs.mkdirSync(path.join(root, 'modules/m/migrations'), { recursive: true });
    fs.writeFileSync(path.join(root, 'modules/m/migrations/001.sql'), 'select 1;');
    const fromDist = new URL('../migrations/001.sql', pathToFileURL(path.join(root, 'dist/modules/m/server/schema.js')));
    expect(sourcePath(fromDist)).toBe(path.join(root, 'modules/m/migrations/001.sql'));
  });

  it('keeps a path that exists, and one outside dist', () => {
    const here = new URL(import.meta.url);
    expect(sourcePath(here)).toBe(path.resolve(new URL(import.meta.url).pathname));
    const outside = new URL('file:///nowhere/x.sql');
    expect(sourcePath(outside)).toBe('/nowhere/x.sql');
  });
});
