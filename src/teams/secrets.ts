// Ported from paperclipai/paperclip@1b4c803 server/src/services/company-portability.ts (MIT),
// isSensitiveEnvKey and the env-to-input extraction (~L555-670).
// Changes: also scrubs free text (bot tokens, API keys, account ids, absolute paths, emails) because a
// agent persona is prose, not an env map; every hit becomes a declared package input and the report
// never contains the original value.

import type { TeamInputDecl } from './types.js';

type TeamInputKind = TeamInputDecl['kind'];

export function isSensitiveEnvKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return (
    normalized === 'key' ||
    normalized.endsWith('_key') ||
    normalized.endsWith('-key') ||
    normalized === 'token' ||
    normalized.endsWith('_token') ||
    normalized.endsWith('-token') ||
    normalized.includes('apikey') ||
    normalized.includes('api_key') ||
    normalized.includes('api-key') ||
    normalized.includes('access_token') ||
    normalized.includes('access-token') ||
    normalized.includes('auth') ||
    normalized.includes('auth_token') ||
    normalized.includes('auth-token') ||
    normalized.includes('authorization') ||
    normalized.includes('bearer') ||
    normalized.includes('secret') ||
    normalized.includes('passwd') ||
    normalized.includes('password') ||
    normalized.includes('credential') ||
    normalized.includes('jwt') ||
    normalized.includes('privatekey') ||
    normalized.includes('private_key') ||
    normalized.includes('private-key') ||
    normalized.includes('cookie') ||
    normalized.includes('connectionstring')
  );
}

export interface Redaction {
  agent: string;
  file: string;
  kind: 'secret' | 'bot_token' | 'account_id' | 'path' | 'email';
  input: string;
}

interface Pattern { kind: Redaction['kind']; re: RegExp }

// Order matters: tokens first (they start with digits), then paths and emails, then bare numeric ids.
const PATTERNS: Pattern[] = [
  { kind: 'bot_token', re: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g },
  { kind: 'secret', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'secret', re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'secret', re: /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/g },
  { kind: 'secret', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'secret', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { kind: 'secret', re: /\bEAA[A-Za-z0-9]{20,}\b/g },
  { kind: 'secret', re: /(?<=\bBearer\s)[A-Za-z0-9._~+/=-]{16,}/g },
  { kind: 'path', re: /(?:\/Users\/|\/home\/)[^\s"'`)<>\]]+/g },
  { kind: 'path', re: /\b[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\s"'`)<>\]]+/g },
  { kind: 'email', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { kind: 'account_id', re: /(?<![\w.:-])\d{9,}(?![\w-]|\.\w)/g },
];

const KEY_VALUE_RE = /\b([A-Za-z0-9_-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_-]*)(\s*[=:]\s*)(["'`]?)([A-Za-z0-9._~+/=-]{12,})\3/g;

const NAME_BY_KIND: Record<Redaction['kind'], string> = {
  secret: 'SECRET',
  bot_token: 'BOT_TOKEN',
  account_id: 'ACCOUNT_ID',
  path: 'PATH',
  email: 'EMAIL',
};

const placeholder = (key: string) => `{{input.${key}}}`;
const isPlaceholderValue = (v: string) => v.includes('{{') || /^[<$[]/.test(v) || /^(?:x+|\*+|\.\.\.)$/i.test(v);

/** Collects the inputs and the redaction report for one export. */
export class Scrubber {
  readonly inputs = new Map<string, TeamInputDecl>();
  readonly redactions: Redaction[] = [];
  private readonly byValue = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  private readonly roots: string[];

  constructor(extraRoots: string[] = []) {
    this.roots = [...new Set([...extraRoots].filter((r) => r && r.length > 3 && r !== '/'))]
      .sort((a, b) => b.length - a.length);
  }

  private declare(key: string, kind: TeamInputKind, label: string, description: string, agent: string | null): void {
    if (this.inputs.has(key)) return;
    this.inputs.set(key, { key, label, description, kind, required: false, defaultValue: '' });
  }

  private inputFor(kind: Redaction['kind'], value: string, agent: string, file: string): string {
    const dedupe = `${kind}\0${value}`;
    let key = this.byValue.get(dedupe);
    if (!key) {
      const n = (this.counters.get(kind) ?? 0) + 1;
      this.counters.set(kind, n);
      key = `${NAME_BY_KIND[kind]}_${n}`;
      this.byValue.set(dedupe, key);
      const where = `${agent}/${file}`;
      const inputKind: TeamInputKind = kind === 'secret' ? 'secret' : 'plain';
      const label = {
        secret: 'Khóa bí mật', bot_token: 'Token bot', account_id: 'Mã tài khoản', path: 'Đường dẫn trên máy', email: 'Địa chỉ email',
      }[kind];
      this.declare(key, inputKind, `${label} ${n}`, `Giá trị gốc đã được gỡ khỏi gói (${where}). Nhập giá trị cho máy này, hoặc để trống.`, null);
    }
    this.redactions.push({ agent, file, kind, input: key });
    return key;
  }

  /** Scrub free text; returns text with `{{input.KEY}}` in place of each hit. */
  text(input: string, agent: string, file: string): string {
    let out = input;
    for (const root of this.roots) {
      if (!out.includes(root)) continue;
      const rest = new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\s"'\`)<>\\]]*`, 'g');
      out = out.replace(rest, (m) => `{{input.${this.inputFor('path', m, agent, file)}}}`);
    }
    out = out.replace(KEY_VALUE_RE, (m, name: string, sep: string, quote: string, value: string) => {
      if (isPlaceholderValue(value)) return m;
      return `${name}${sep}${quote}{{input.${this.inputFor('secret', value, agent, file)}}}${quote}`;
    });
    for (const { kind, re } of PATTERNS) {
      out = out.replace(re, (m, ...rest) => {
        const offset = rest[rest.length - 2] as number;
        // Never rewrite inside an existing placeholder.
        const open = out.lastIndexOf('{{', offset);
        if (open !== -1 && out.indexOf('}}', open) >= offset) return m;
        return `{{input.${this.inputFor(kind, m, agent, file)}}}`;
      });
    }
    return out;
  }

  /** Scrub every string in a parsed yaml value; values under sensitive keys are replaced wholesale. */
  value<T>(input: T, agent: string, file: string, trail: string[] = []): T {
    if (typeof input === 'string') return this.text(input, agent, file) as unknown as T;
    if (Array.isArray(input)) return input.map((v, i) => this.value(v, agent, file, [...trail, String(i)])) as unknown as T;
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim() && isSensitiveEnvKey(k) && !isPlaceholderValue(v)) {
          const key = `${agent}_${[...trail, k].join('_')}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
          this.declare(key, 'secret', `Giá trị "${k}" của ${agent}`, `Khóa nhạy cảm trong ${file}; giá trị gốc đã được gỡ.`, null);
          this.redactions.push({ agent, file, kind: 'secret', input: key });
          out[k] = placeholder(key);
        } else {
          out[k] = this.value(v, agent, file, [...trail, k]);
        }
      }
      return out as T;
    }
    return input;
  }
}
