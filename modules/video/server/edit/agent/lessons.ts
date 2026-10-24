/**
 * The video director's "brain": markdown lessons in the Obsidian vault.
 *
 *   Video Studio/Bai-hoc/**           shared lessons (any channel)
 *   Video Studio/<other>/**           shared too, except Kenh/
 *   Video Studio/Kenh/<slug>/**       lessons and taste of one channel profile
 *
 * `video-cli lessons search` returns the matching sections (file + heading + excerpt). Read-only, plain
 * filesystem walk, diacritics-insensitive.
 */

import fs from 'node:fs';
import path from 'node:path';

export const VAULT_ROOT_FOLDER = 'Video Studio';
export const VAULT_CHANNEL_FOLDER = 'Video Studio/Kenh';
export const VAULT_SHARED_LESSONS = 'Video Studio/Bai-hoc';

export type LessonScope = 'all' | 'shared' | 'channel';

export interface LessonHit {
  /** Vault-relative path. */
  file: string;
  heading: string;
  scope: 'shared' | 'channel' | 'builtin';
  score: number;
  excerpt: string;
}

export function normalize(text: string): string {
  return text.replace(/đ/g, 'd').replace(/Đ/g, 'D').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function tokens(query: string): string[] {
  return [...new Set(normalize(query).split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
}

function walkMarkdown(dir: string, out: string[], depth = 0): void {
  if (depth > 6) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMarkdown(full, out, depth + 1);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full);
  }
}

interface Section { heading: string; body: string }

export function splitSections(markdown: string, fallbackTitle: string): Section[] {
  const text = markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
  const sections: Section[] = [];
  let heading = fallbackTitle;
  let body: string[] = [];
  let inFence = false;
  const flush = () => {
    const joined = body.join('\n').trim();
    if (joined) sections.push({ heading, body: joined });
  };
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) inFence = !inFence;
    const m = !inFence ? /^(#{1,4})\s+(.+?)\s*$/.exec(line) : null;
    if (m) {
      flush();
      heading = m[2];
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

function scoreSection(section: Section, file: string, qTokens: string[]): number {
  const head = normalize(`${section.heading} ${path.basename(file, '.md')}`);
  const body = normalize(section.body);
  let score = 0;
  let matched = 0;
  for (const t of qTokens) {
    const inHead = head.includes(t);
    const inBody = body.includes(t);
    if (inHead) score += 3;
    if (inBody) score += 1;
    if (inHead || inBody) matched++;
  }
  // Reward sections that cover most of the query, not just one word.
  if (qTokens.length > 1) score += (matched / qTokens.length) * 2;
  return score;
}

export interface SearchLessonsInput {
  vaultDir: string | null;
  query: string;
  /** Channel profile slug; enables the per-channel folder. */
  profileSlug?: string | null;
  scope?: LessonScope;
  limit?: number;
  /** Bundled lessons used when the vault has no "Video Studio" folder yet. */
  fallbackDir?: string | null;
}

export interface SearchLessonsResult {
  vault: string | null;
  searched: string[];
  hits: LessonHit[];
  note?: string;
}

const EXCERPT_CHARS = 900;

export function searchLessons(input: SearchLessonsInput): SearchLessonsResult {
  const scope = input.scope ?? 'all';
  const limit = Math.max(1, Math.min(input.limit ?? 6, 20));
  const qTokens = tokens(input.query);
  const searched: string[] = [];
  const jobs: { root: string; base: string; scope: LessonHit['scope']; exclude?: string }[] = [];

  const videoRoot = input.vaultDir ? path.join(input.vaultDir, VAULT_ROOT_FOLDER) : null;
  const hasVaultFolder = !!videoRoot && fs.existsSync(videoRoot);
  if (hasVaultFolder && input.vaultDir) {
    if (scope !== 'channel') {
      jobs.push({ root: videoRoot!, base: input.vaultDir, scope: 'shared', exclude: path.join(videoRoot!, 'Kenh') });
      searched.push(VAULT_ROOT_FOLDER);
    }
    if (scope !== 'shared' && input.profileSlug) {
      const channelDir = path.join(videoRoot!, 'Kenh', input.profileSlug);
      if (fs.existsSync(channelDir)) {
        jobs.push({ root: channelDir, base: input.vaultDir, scope: 'channel' });
        searched.push(`${VAULT_CHANNEL_FOLDER}/${input.profileSlug}`);
      }
    }
  } else if (scope !== 'channel' && input.fallbackDir && fs.existsSync(input.fallbackDir)) {
    jobs.push({ root: input.fallbackDir, base: path.dirname(input.fallbackDir), scope: 'builtin' });
    searched.push(path.basename(input.fallbackDir));
  }

  const hits: LessonHit[] = [];
  for (const job of jobs) {
    const files: string[] = [];
    walkMarkdown(job.root, files);
    for (const file of files) {
      if (job.exclude && (file === job.exclude || file.startsWith(job.exclude + path.sep))) continue;
      let text: string;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const rel = path.relative(job.base, file).split(path.sep).join('/');
      for (const section of splitSections(text, path.basename(file, '.md'))) {
        // An empty query lists sections (the agent browsing); otherwise require at least one token.
        const score = qTokens.length ? scoreSection(section, file, qTokens) : 1;
        if (score <= 0) continue;
        hits.push({
          file: rel,
          heading: section.heading,
          scope: job.scope,
          // A channel's own lesson beats a shared one of equal relevance.
          score: Math.round((score + (job.scope === 'channel' ? 0.5 : 0)) * 10) / 10,
          excerpt: section.body.length > EXCERPT_CHARS ? `${section.body.slice(0, EXCERPT_CHARS).trimEnd()}…` : section.body,
        });
      }
    }
  }
  hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  const note = !input.vaultDir
    ? 'Không tìm thấy vault Obsidian; chỉ tra được bài học dựng sẵn (nếu có).'
    : !hasVaultFolder
      ? `Vault chưa có thư mục "${VAULT_ROOT_FOLDER}"; đã tra bài học dựng sẵn thay thế.`
      : jobs.length === 0
        ? 'Không có thư mục nào để tra với phạm vi này.'
        : hits.length === 0
          ? 'Không có bài học khớp. Thử từ khoá ngắn hơn hoặc đổi cách nói.'
          : undefined;
  return { vault: input.vaultDir, searched, hits: hits.slice(0, limit), ...(note ? { note } : {}) };
}

/** Vault-relative target of `lessons add`. */
export function lessonPath(opts: { profileSlug?: string | null; shared?: boolean; fileName: string }): string {
  const safe = normalize(opts.fileName.replace(/\.md$/i, '')).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'bai-hoc';
  if (opts.shared || !opts.profileSlug) return `${VAULT_SHARED_LESSONS}/${safe}.md`;
  return `${VAULT_CHANNEL_FOLDER}/${opts.profileSlug}/bai-hoc/${safe}.md`;
}
