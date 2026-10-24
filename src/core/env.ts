import fs from 'node:fs';
import path from 'node:path';

/** Parse a .env file into a map. Lines: KEY=value, # comments, optional quotes. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function readEnvFile(file: string): Record<string, string> {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** Load .env into process.env without overriding values that are already set. */
export function loadEnvFile(file: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const [k, v] of Object.entries(readEnvFile(file))) {
    if (env[k] === undefined) env[k] = v;
  }
}

/** Set or replace KEY=value in a .env file (creates it), and in process.env. */
export function setEnvKey(file: string, key: string, value: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`invalid env key: ${key}`);
  if (/[\r\n]/.test(value)) throw new Error('env value must be a single line');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const line = `${key}=${/[\s#"']/.test(value) ? JSON.stringify(value) : value}`;
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.replace(/^export\s+/, '').startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = line;
  else {
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(line, '');
  }
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
  env[key] = value;
}

/** Resolve `$NAME` / `${NAME}` references against an env map. Unknown names become ''. */
export function resolveEnvRefs(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (_, name: string) => env[name] ?? '');
}
