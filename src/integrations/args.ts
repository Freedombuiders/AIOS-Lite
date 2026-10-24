// Command-line style argument parsing for integration calls: quotes respected, positionals + --flags.
import { IntegrationUsageError, type ParsedArgs } from './types.js';

/** Splits on whitespace; single or double quotes group words, backslash escapes inside double quotes and outside quotes. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (ch === '\\' && i + 1 < input.length) { cur += input[++i]; has = true; continue; }
    if (/\s/.test(ch)) {
      if (has) { tokens.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (quote) throw new IntegrationUsageError('Chuỗi tham số thiếu dấu đóng ngoặc kép.');
  if (has) tokens.push(cur);
  return tokens;
}

/** `--flag value` (next token not starting with `--`), bare `--flag` → true, `--flag=value`; the rest are positionals. */
export function parseArgs(tokens: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.startsWith('--') || token === '--') { positionals.push(token); continue; }
    const eq = token.indexOf('=');
    if (eq > 2) { flags[token.slice(2, eq)] = token.slice(eq + 1); continue; }
    const key = token.slice(2);
    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else { flags[key] = true; }
  }
  return { positionals, flags };
}
