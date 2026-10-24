/**
 * Reply rules storage: DEFAULT_REPLY_RULES ← Page config ← post overrides.
 * Validation lives here so routes and tests share it.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { z } from 'zod';

import { sourcePath } from '../../../_lib/source-path.js';
import { PROJECT_ROOT } from '../compat.js';
import { deleteFbReplyRule, getFbReplyRuleJson, putFbReplyRule } from '../store.js';
import { DEFAULT_REPLY_RULES, type ReplyRuleConfig } from '../types.js';

const keywordList = z.array(z.string()).max(400)
  .transform((list) => [...new Set(list.map((s) => s.trim()).filter(Boolean))])
  .refine((list) => list.length <= 200 && list.every((s) => s.length <= 100), 'Tối đa 200 từ khóa, mỗi từ khóa 100 ký tự');
const idLike = /^[\w.-]+$/;

const SHAPE = {
  enabled: z.boolean(),
  minWords: z.number().int().min(0).max(200),
  questionMark: z.boolean(),
  onlyIfNotRepliedHours: z.number().int().min(1).max(720).nullable(),
  agentId: z.string().min(1).max(64).regex(idLike),
  skill: z.string().max(64).regex(/^[\w.-]*$/),
  contextPost: z.boolean(),
  contextVoice: z.boolean(),
  contextFaqPath: z.string().max(500),
  contextThread: z.number().int().min(0).max(20),
  instructions: z.string().max(4000),
  sendMode: z.enum(['auto', 'delay', 'draft']),
  delayBeforeSendMinutes: z.number().min(0).max(1440),
  maxPerHour: z.number().int().min(1).max(500),
  delayMinMinutes: z.number().min(0).max(1440),
  delayMaxMinutes: z.number().min(0).max(1440),
  maxPerUserPerPost: z.number().int().min(1).max(20),
  hideLinks: z.boolean(),
  spamKeywords: keywordList,
  complaintKeywords: keywordList,
  notify: z.enum(['telegram', 'zalo', 'none']),
  pollMinutes: z.number().int().min(2).max(120),
  maxPostAgeDays: z.number().int().min(1).max(60),
} satisfies Record<keyof ReplyRuleConfig, z.ZodType>;

const PATCH_SCHEMA = z.object(SHAPE).partial().strict();

export type RulePatchResult = { ok: true; value: Partial<ReplyRuleConfig> } | { ok: false; error: string };

/** Validates a rules patch from the dashboard. Unknown keys and out-of-range values are rejected. */
export function parseRulePatch(input: unknown): RulePatchResult {
  const parsed = PATCH_SCHEMA.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data as Partial<ReplyRuleConfig> };
  const issue = parsed.error.issues[0];
  const where = issue.path.length ? issue.path.join('.') : 'config';
  return { ok: false, error: `Cấu hình không hợp lệ (${where}): ${issue.message}` };
}

/** Keeps only the valid fields of a stored patch, so one bad value never discards the rest. */
function lenientPatch(raw: unknown): Partial<ReplyRuleConfig> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const field = (SHAPE as Record<string, z.ZodType>)[key];
    if (!field) continue;
    const parsed = field.safeParse(value);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as Partial<ReplyRuleConfig>;
}

function readScope(scope: string): Partial<ReplyRuleConfig> | null {
  const json = getFbReplyRuleJson(scope);
  if (json === undefined) return null;
  try { return lenientPatch(JSON.parse(json)); } catch { return {}; }
}

export const pageScope = (pageId: string): string => `page:${pageId}`;
export const postScope = (postId: string): string => `post:${postId}`;

export function loadPageRules(pageId: string): ReplyRuleConfig {
  return { ...DEFAULT_REPLY_RULES, ...(readScope(pageScope(pageId)) ?? {}) };
}

/** The overrides stored for a post, or null when it inherits everything. */
export function loadPostOverrides(postId: string): Partial<ReplyRuleConfig> | null {
  return readScope(postScope(postId));
}

export function effectiveRules(pageId: string, postId?: string | null): ReplyRuleConfig {
  const page = loadPageRules(pageId);
  if (!postId) return page;
  return { ...page, ...(loadPostOverrides(postId) ?? {}) };
}

export function savePageRules(pageId: string, patch: Partial<ReplyRuleConfig>): void {
  const merged = { ...(readScope(pageScope(pageId)) ?? {}), ...patch };
  putFbReplyRule(pageScope(pageId), pageId, null, JSON.stringify(merged));
}

export function savePostOverrides(pageId: string, postId: string, patch: Partial<ReplyRuleConfig>): void {
  const merged = { ...(readScope(postScope(postId)) ?? {}), ...patch };
  putFbReplyRule(postScope(postId), pageId, postId, JSON.stringify(merged));
}

export function dropPostOverrides(postId: string): boolean {
  return deleteFbReplyRule(postScope(postId));
}

// ── FAQ file and skill text ──────────────────────────────────────────

export const FAQ_MAX_BYTES = 20 * 1024;
const FAQ_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.csv', '.json']);
const FAQ_FORBIDDEN = /(^|[\\/])\.(env|ssh|aws|gnupg|netrc)|id_rsa|id_ed25519|\.pem$|\.key$/i;

/**
 * Reads the Page's FAQ/product file (first 20 KB) for the agent. Only plain
 * text-like files are read, never dotfiles that commonly hold credentials:
 * the text can end up in a public reply, so the path is a trust boundary.
 */
export function readFaqFile(faqPath: string, baseDir?: string): string {
  const raw = faqPath.trim();
  if (!raw) return '';
  const expanded = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(baseDir ?? PROJECT_ROOT, expanded);
  try {
    const real = fs.realpathSync(resolved);
    if (!FAQ_EXTENSIONS.has(path.extname(real).toLowerCase()) || FAQ_FORBIDDEN.test(real) || FAQ_FORBIDDEN.test(resolved)) return '';
    const stat = fs.statSync(real);
    if (!stat.isFile()) return '';
    const fd = fs.openSync(real, 'r');
    try {
      const buf = Buffer.alloc(Math.min(stat.size, FAQ_MAX_BYTES));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

const MODULE_SKILLS_DIR = sourcePath(new URL('../../skills', import.meta.url));

function skillDirs(): string[] {
  return [path.join(PROJECT_ROOT, 'skills'), MODULE_SKILLS_DIR];
}

/** Names of the skills that have a SKILL.md, for the rules screen's picker. */
export function listSkillNames(): string[] {
  const names = new Set<string>();
  for (const dir of skillDirs()) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'SKILL.md'))) names.add(entry.name);
      }
    } catch { /* directory missing */ }
  }
  return [...names].sort();
}

/** SKILL.md body (frontmatter stripped) to embed in the system prompt, or '' when the skill does not exist. */
export function readSkillText(skill: string): string {
  if (!/^[\w.-]+$/.test(skill)) return '';
  for (const dir of skillDirs()) {
    const file = path.join(dir, skill, 'SKILL.md');
    try {
      const text = fs.readFileSync(file, 'utf-8');
      return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
    } catch { /* try the next directory */ }
  }
  return '';
}
