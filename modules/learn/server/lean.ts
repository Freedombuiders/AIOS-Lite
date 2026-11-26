// Small helpers around the one-turn agent runs of this module (weekly prose, opening type of a draft).
import type { LeanRunInput, LeanRunResult } from '../../../src/modules/sdk.js';

export type RunLean = (input: LeanRunInput) => Promise<LeanRunResult>;

/** The first JSON object in an agent's answer (it may wrap it in a code fence or a sentence). */
export function firstJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const src = fenced ? fenced[1]! : text;
  const start = src.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(src.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** One line of agent text for a note: no newlines, no HTML comments or markers, clipped. */
export function cleanLine(v: unknown, max = 300): string {
  if (typeof v !== 'string') return '';
  const s = v.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?aios[^>]*>/gi, '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
