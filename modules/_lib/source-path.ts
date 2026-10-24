import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Path of a non-code file of a module (migrations/*.sql, skills/…), from a URL relative to the calling file.
 * `tsc` only compiles .ts into dist/modules/<id>/server, so when the code runs from dist the file is read
 * from the source folder modules/<id>/ instead.
 *   sourcePath(new URL('../migrations/001_init.sql', import.meta.url))
 */
export function sourcePath(url: URL): string {
  const p = fileURLToPath(url);
  if (fs.existsSync(p)) return p;
  const marker = `${path.sep}dist${path.sep}modules${path.sep}`;
  const i = p.lastIndexOf(marker);
  return i < 0 ? p : p.slice(0, i) + `${path.sep}modules${path.sep}` + p.slice(i + marker.length);
}
