import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Composio } from '@composio/core';
import { loadEnvFile, resolveEnvRefs } from '../core/env.js';
import type { Logger } from '../core/log.js';
import type { Connection } from '../core/types.js';
import type { ConnectionsService } from './contracts.js';

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/);
const envMap = z.record(z.string(), z.string());

const connectionSchema = z.discriminatedUnion('type', [
  z.object({
    id: idSchema,
    type: z.literal('mcp'),
    description: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: envMap.optional(),
  }),
  z.object({ id: idSchema, type: z.literal('env'), description: z.string().optional(), env: envMap }),
  z.object({
    id: idSchema,
    type: z.literal('composio'),
    description: z.string().optional(),
    apiKeyEnv: z.string().min(1),
    toolkits: z.array(z.string()).optional(),
  }),
]);

export interface ConnectionsOptions {
  file: string;
  envFile: string;
  log: Logger;
  /** tests inject these; defaults are process.env, global fetch and the real Composio SDK */
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  createComposio?: (apiKey: string) => Promise<Composio> | Composio;
}

function onPath(cmd: string, env: NodeJS.ProcessEnv): boolean {
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  const dirs = cmd.includes('/') || cmd.includes('\\') ? [''] : (env.PATH ?? '').split(path.delimiter);
  for (const d of dirs) {
    for (const ext of exts) {
      const p = d ? path.join(d, cmd + ext) : cmd + ext;
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return true;
      } catch {
        // keep looking
      }
    }
  }
  return false;
}

export function createConnectionsService(opts: ConnectionsOptions): ConnectionsService {
  const { log } = opts;
  const env = opts.env ?? process.env;
  const doFetch = opts.fetch ?? globalThis.fetch;
  let items: Connection[] = [];
  const composioCache = new Map<string, Composio>();

  function reload(): void {
    loadEnvFile(opts.envFile, env);
    items = [];
    let text: string;
    try {
      text = fs.readFileSync(opts.file, 'utf8');
    } catch {
      return;
    }
    let raw: { connections?: unknown } | null;
    try {
      raw = parse(text) as { connections?: unknown } | null;
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'connections.yaml không phải YAML hợp lệ');
      return;
    }
    const list = Array.isArray(raw?.connections) ? raw.connections : [];
    const seen = new Set<string>();
    for (const entry of list) {
      const p = connectionSchema.safeParse(entry);
      if (!p.success) {
        log.warn({ issue: p.error.issues[0]?.message }, 'connections.yaml: bỏ qua một kết nối sai định dạng');
        continue;
      }
      if (seen.has(p.data.id)) {
        log.warn({ id: p.data.id }, 'connections.yaml: id trùng, bỏ qua');
        continue;
      }
      seen.add(p.data.id);
      items.push(p.data as Connection);
    }
  }

  const resolveEnv = (c: Connection): Record<string, string> => {
    if (c.type === 'composio' || !c.env) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.env)) out[k] = resolveEnvRefs(v, env);
    return out;
  };

  /** names of env variables a connection needs but are empty */
  function missingEnv(c: Connection): string[] {
    if (c.type === 'composio') return env[c.apiKeyEnv] ? [] : [c.apiKeyEnv];
    const missing = new Set<string>();
    for (const [k, v] of Object.entries(c.env ?? {})) {
      if (resolveEnvRefs(v, env)) continue;
      const refs = [...v.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g)].map((m) => m[1]!);
      (refs.length ? refs : [k]).forEach((r) => missing.add(r));
    }
    return [...missing];
  }

  function composioKey(): string | undefined {
    const c = items.find((x) => x.type === 'composio');
    return (c && c.type === 'composio' ? env[c.apiKeyEnv] : undefined) || env.COMPOSIO_API_KEY || undefined;
  }

  reload();

  return {
    reload,
    list: () => items.slice(),
    get: (id) => items.find((c) => c.id === id),
    resolveEnv,
    secret: (name) => env[name] || undefined,

    async composio() {
      const key = composioKey();
      if (!key) throw new Error('Chưa có khoá Composio. Đặt COMPOSIO_API_KEY trong .env.');
      let c = composioCache.get(key);
      if (!c) {
        c = opts.createComposio
          ? await opts.createComposio(key)
          : new (await import('@composio/core')).Composio({ apiKey: key });
        composioCache.set(key, c);
      }
      return c;
    },

    has(idOrType) {
      const matches = items.filter((c) => c.id === idOrType || c.type === idOrType);
      if (matches.some((c) => missingEnv(c).length === 0)) return true;
      return idOrType === 'composio' && Boolean(env.COMPOSIO_API_KEY);
    },

    async test(id) {
      const c = items.find((x) => x.id === id);
      if (!c) return { ok: false, message: `Không có kết nối "${id}" trong connections.yaml.` };
      const missing = missingEnv(c);
      if (missing.length) return { ok: false, message: `Thiếu biến môi trường: ${missing.join(', ')}.` };
      if (c.type === 'composio') return { ok: true, message: 'Đã có khoá Composio.' };
      if (c.type === 'env') return { ok: true, message: 'Đủ giá trị biến môi trường.' };
      if (c.command) {
        return onPath(c.command, env)
          ? { ok: true, message: `Tìm thấy lệnh "${c.command}".` }
          : { ok: false, message: `Không tìm thấy lệnh "${c.command}" trong PATH.` };
      }
      if (c.url) {
        try {
          const res = await doFetch(c.url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
          return { ok: true, message: `Máy chủ phản hồi (HTTP ${res.status}).` };
        } catch {
          return { ok: false, message: 'Không kết nối được tới máy chủ MCP (quá 3 giây hoặc lỗi mạng).' };
        }
      }
      return { ok: false, message: 'Kết nối MCP cần `command` hoặc `url`.' };
    },
  };
}
