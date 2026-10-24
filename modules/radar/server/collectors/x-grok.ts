/** X (Twitter) through the Radar analyst agent (runtime grok, lean turn): its built-in X search returns structured posts. */

import { tmpdir } from 'os';
import path from 'path';
import { loadConfig } from '../config.js';
import { currentContext, requireContext } from '../context.js';
import { logger } from '../log.js';
import { socialHandle } from '../channels.js';
import type { RawItem, SourceStat, VnChatter } from '../types.js';
import { clip } from '../util.js';
import { makeItem, num, obj, str, toIso } from './parse.js';
import type { CollectContext } from './index.js';

export const GROK_TIMEOUT_MS = 4 * 60_000;
const NOT_SIGNED_IN = /not signed in|not logged in|please (log ?in|sign ?in)|login required|unauthenticated|grok login/i;
export const GROK_LOGIN_ERROR = 'Grok chưa đăng nhập: vào Kết nối › Runtime để đăng nhập Grok.';

/** Working folder of the module (browser profile, caches). */
export function radarHome(): string { return path.join(currentContext()?.dataDir ?? path.join(tmpdir(), 'aios-radar'), 'radar'); }

/** Id of the analyst agent that runs X searches, or null when no such agent exists. */
export function analystAgent(): string | null {
  try {
    const id = loadConfig().analysisAgentId;
    return currentContext()?.agents.get(id) ? id : null;
  } catch { return null; }
}

/**
 * Default X reader: one lean turn of the analyst agent. `args` keep the shape of the old CLI call
 * (`-p <prompt> --json-schema <schema>`), so tests can still inject `execGrok`.
 */
export async function defaultExecGrok(args: string[], opts: { timeoutMs: number; signal?: AbortSignal }): Promise<string> {
  const ctx = requireContext();
  const agentId = analystAgent();
  if (!agentId) throw new Error('Chưa có agent radar-analyst: thêm agent từ mẫu của module Radar.');
  const prompt = args[args.indexOf('-p') + 1] ?? '';
  const schema = args[args.indexOf('--json-schema') + 1] ?? '{}';
  const res = await ctx.agents.runLean({
    agentId,
    title: 'Radar: đọc X',
    prompt: `${prompt}\n\nTrả về đúng MỘT đối tượng JSON theo schema sau, không thêm lời giải thích:\n${schema}`,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    meta: { usageKey: 'radar:x' },
  });
  if (!res.ok) {
    const text = res.error ?? '';
    if (NOT_SIGNED_IN.test(text)) throw new Error('Not signed in');
    throw new Error(`agent lỗi: ${clip(text || 'không trả lời', 200)}`);
  }
  if (NOT_SIGNED_IN.test(res.output.slice(0, 400))) throw new Error('Not signed in');
  return res.output;
}

function balancedObjects(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { out.push(text.slice(i, j + 1)); i = j; break; }
    }
    if (out.length >= 20) break;
  }
  return out;
}

function tryParse(s: string): unknown {
  const t = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { return undefined; }
}

/** Finds the first object holding an array under `key`, anywhere in the envelope (strings are parsed too). */
export function findPayload(value: unknown, key: string, depth = 0): Record<string, unknown> | null {
  if (depth > 6 || value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const parsed = tryParse(value);
    if (parsed !== undefined && typeof parsed === 'object') return findPayload(parsed, key, depth + 1);
    for (const b of balancedObjects(value)) {
      const p = tryParse(b);
      const hit = p === undefined ? null : findPayload(p, key, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const v of value) { const hit = findPayload(v, key, depth + 1); if (hit) return hit; }
    return null;
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (Array.isArray(o[key])) return o;
    for (const k of ['structured_output', 'result', 'output', 'text', 'content', 'response', 'message']) {
      if (k in o) { const hit = findPayload(o[k], key, depth + 1); if (hit) return hit; }
    }
    for (const v of Object.values(o)) {
      if (v && typeof v === 'object') { const hit = findPayload(v, key, depth + 1); if (hit) return hit; }
    }
  }
  return null;
}

/** Parses the stdout of `grok --output-format json` (single JSON, NDJSON or text with JSON inside). */
export function parseGrokOutput(stdout: string, key: string): Record<string, unknown> | null {
  const whole = tryParse(stdout);
  if (whole !== undefined) { const hit = findPayload(whole, key); if (hit) return hit; }
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    const p = tryParse(line);
    const hit = p === undefined ? null : findPayload(p, key);
    if (hit) return hit;
  }
  return findPayload(stdout, key);
}

const POSTS_SCHEMA = {
  type: 'object',
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          author: { type: 'string' }, text: { type: 'string' }, url: { type: 'string' }, posted_at: { type: 'string' },
          likes: { type: ['number', 'null'] }, reposts: { type: ['number', 'null'] }, quotes: { type: ['number', 'null'] },
          replies: { type: ['number', 'null'] }, bookmarks: { type: ['number', 'null'] }, views: { type: ['number', 'null'] },
        },
        required: ['author', 'text', 'url', 'posted_at'],
      },
    },
  },
  required: ['posts'],
};

const VN_SCHEMA = {
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      items: { type: 'object', properties: { topic: { type: 'string' }, posts: { type: 'number' }, examples: { type: 'array', items: { type: 'string' } } }, required: ['topic', 'posts', 'examples'] },
    },
    note: { type: 'string' },
  },
  required: ['topics'],
};

function grokArgs(prompt: string, schema: object): string[] {
  return ['-p', prompt, '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--max-turns', '12', '--no-subagents'];
}

export class GrokNotSignedIn extends Error { constructor() { super(GROK_LOGIN_ERROR); } }

async function runGrok(ctx: CollectContext, prompt: string, schema: object): Promise<string> {
  const exec = ctx.deps?.execGrok ?? defaultExecGrok;
  try {
    return await exec(grokArgs(prompt, schema), { timeoutMs: GROK_TIMEOUT_MS, signal: ctx.signal });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (NOT_SIGNED_IN.test(msg)) throw new GrokNotSignedIn();
    throw e;
  }
}

function postsPrompt(sinceIso: string, accounts: string[], queries: string[]): string {
  const parts = [
    'Use your X (Twitter) search to find ORIGINAL posts (no replies, no retweets) published since',
    `${sinceIso}.`,
  ];
  if (accounts.length) parts.push(`Cover posts written by these accounts: ${accounts.map((a) => '@' + a.replace(/^@/, '')).join(', ')}.`);
  if (queries.length) parts.push(`Also cover posts matching these searches: ${queries.map((q) => `"${q}"`).join('; ')}. Prefer the most engaged.`);
  parts.push(
    'Return only real posts you actually saw and the real numbers shown; never invent anything. For each post return: author (handle without @),',
    'text (at most 280 characters), url (https://x.com/<handle>/status/<id>), posted_at (ISO 8601), likes, reposts, quotes, replies, bookmarks, views (use null when unknown).',
    'At most 15 posts per account. Respond with the JSON object only.',
  );
  return parts.join(' ');
}

/** Validated posts from a grok payload: status url required, deduped by url. */
export function mapXPosts(payload: Record<string, unknown> | null, layer: RawItem['layer'], sinceIso?: string): RawItem[] {
  const out = new Map<string, RawItem>();
  for (const p of (payload?.posts as unknown[] | undefined) ?? []) {
    const o = obj(p);
    const url = str(o.url);
    if (!url || !/\/status\/\d+/.test(url)) continue;
    const handle = (str(o.author) ?? /(?:x|twitter)\.com\/([^/]+)\/status/.exec(url)?.[1] ?? '').replace(/^@/, '');
    const postedAt = toIso(o.posted_at);
    if (sinceIso && postedAt && postedAt < sinceIso) continue;
    const item = makeItem({
      layer, kind: 'x', via: 'grok', sourceName: `@${handle || 'x'}`, sourceUrl: handle ? `https://x.com/${handle}` : undefined,
      url, author: handle || undefined, text: str(o.text) ?? '', postedAt,
      metrics: { likes: num(o.likes), reposts: num(o.reposts), quotes: num(o.quotes), replies: num(o.replies), saves: num(o.bookmarks), views: num(o.views) },
    });
    if (!out.has(item.id)) out.set(item.id, item);
  }
  return [...out.values()];
}

export interface XResult { items: RawItem[]; sources: SourceStat[]; notes: string[] }

/** Accounts in batches of six plus one search call. Stops at the first "not signed in". */
export async function collectX(ctx: CollectContext, accounts: string[], queries: string[]): Promise<XResult> {
  const layer = ctx.layer;
  const items = new Map<string, RawItem>();
  const sources: SourceStat[] = [];
  const notes: string[] = [];
  const calls: { label: string; accounts: string[]; queries: string[] }[] = [];
  const clean = accounts.map((a) => socialHandle(a, 'x')).filter(Boolean);
  for (let i = 0; i < clean.length; i += 6) calls.push({ label: 'accounts', accounts: clean.slice(i, i + 6), queries: [] });
  if (queries.length) calls.push({ label: 'queries', accounts: [], queries });
  let loginFailed = false;
  for (const c of calls) {
    if (ctx.signal?.aborted) break;
    const names = c.accounts.length ? c.accounts.map((a) => `@${a}`) : ['X: tìm kiếm'];
    if (loginFailed) { for (const n of names) sources.push({ kind: 'x', name: n, via: 'grok', ok: false, count: 0, error: GROK_LOGIN_ERROR }); continue; }
    try {
      ctx.log(`X: đọc ${c.accounts.length ? c.accounts.length + ' tài khoản' : queries.length + ' từ khoá'} qua Grok…`);
      const stdout = await runGrok(ctx, postsPrompt(ctx.sinceIso, c.accounts, c.queries), POSTS_SCHEMA);
      const payload = parseGrokOutput(stdout, 'posts');
      if (!payload) throw new Error('Grok trả kết quả không đọc được.');
      const got = mapXPosts(payload, layer, ctx.sinceIso);
      for (const it of got) if (!items.has(it.id)) items.set(it.id, it);
      if (c.accounts.length) for (const a of c.accounts) sources.push({ kind: 'x', name: `@${a}`, url: `https://x.com/${a}`, via: 'grok', ok: true, count: got.filter((g) => g.author?.toLowerCase() === a.toLowerCase()).length });
      else sources.push({ kind: 'x', name: 'X: tìm kiếm', via: 'grok', ok: true, count: got.length });
    } catch (e) {
      const login = e instanceof GrokNotSignedIn;
      if (login) { loginFailed = true; notes.push(GROK_LOGIN_ERROR + ' Bỏ qua X.'); }
      else { logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'radar: grok X call failed'); notes.push(`X: không đọc được một phần (${clip(e instanceof Error ? e.message : 'lỗi', 120)}).`); }
      for (const n of names) sources.push({ kind: 'x', name: n, via: 'grok', ok: false, count: 0, error: login ? GROK_LOGIN_ERROR : clip(e instanceof Error ? e.message : 'lỗi', 160) });
    }
  }
  return { items: [...items.values()], sources, notes };
}

/** What Vietnamese-language X discussed about AI in the last N days. Null when grok is unavailable. */
export async function collectVnChatter(ctx: CollectContext, days: number): Promise<VnChatter | null> {
  try {
    const prompt = `Use your X search to see what Vietnamese-language posts discussed about AI (ChatGPT, Claude, Gemini, agents, AI tools, AI courses) in the last ${days} days. `
      + 'Group them into at most 12 topics. For each topic return: topic (short, in Vietnamese), posts (approximate number of posts you saw), examples (up to 3 short real quotes). '
      + 'Never invent posts. You may add a short "note" about limits of what you could see. Respond with the JSON object only.';
    const stdout = await runGrok(ctx, prompt, VN_SCHEMA);
    const payload = parseGrokOutput(stdout, 'topics');
    if (!payload) return null;
    const topics = (payload.topics as unknown[]).map((t) => {
      const o = obj(t);
      return { topic: str(o.topic) ?? '', posts: num(o.posts) ?? 0, examples: Array.isArray(o.examples) ? o.examples.map((x) => str(x)).filter((x): x is string => !!x).slice(0, 3) : [] };
    }).filter((t) => t.topic);
    const note = str(payload.note);
    return { topics, ...(note ? { note } : {}) };
  } catch (e) {
    ctx.log(e instanceof GrokNotSignedIn ? GROK_LOGIN_ERROR : 'X tiếng Việt: không đọc được.');
    return null;
  }
}
