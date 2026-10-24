/** Lessons for the director prompt: the bundled lesson notes plus whatever the module brain knows. */
import path from 'node:path';
import { searchLessons } from './edit/agent/lessons.js';
import { moduleCtx } from './host.js';

export function lessonsFor(query: string): string[] {
  const ctx = moduleCtx();
  if (!ctx) return [];
  const out: string[] = [];
  try {
    const res = searchLessons({ vaultDir: null, query, fallbackDir: path.join(ctx.dir, 'skills', 'video-edit', 'references', 'lessons'), limit: 4 });
    for (const h of res.hits) out.push(`[${h.heading} · ${h.file}]\n${h.excerpt}`);
  } catch { /* no bundled lessons */ }
  try {
    for (const h of ctx.brain.search(`Video Studio ${query}`.trim(), { limit: 3 })) out.push(`[${h.title} · ${h.path}]\n${h.snippet}`);
  } catch { /* brain not configured */ }
  return out;
}
