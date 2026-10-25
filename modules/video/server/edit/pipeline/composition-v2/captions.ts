// Captions of a template plan: the template's CaptionStyle (with the owner's caption overrides on top), words
// grouped into short cues that never cross a cut.
//
// chunkWords is adapted from video-use (https://github.com/browser-use/video-use) helpers/render.py
// chunk_words, MIT License, Copyright (c) 2026 Browser Use (full notice: THIRD_PARTY_NOTICES.md).
import type { CaptionStyle, TranscriptWord } from '../../types.js';
import { normWord } from '../analyze.js';
import type { Segment } from '../plan.js';
import { r3 } from '../tools.js';
import { cssFont, cssValue, esc } from './util.js';

/** Target words per cue; a cue shorter than CHUNK_MIN_S reads as a flash, so it may grow to the style's maximum. */
const CHUNK_WORDS = 2;
const CHUNK_MIN_S = 0.35;
/** A gap this long between two words ends the cue. */
const CHUNK_PAUSE_S = 0.3;
const PUNCT_BREAK = /[.,!?;:…]$/u;
/**
 * whisper.cpp writes Vietnamese with almost no punctuation but capitalises the first word of a sentence, so a
 * title-case word ("Đó", "Thì") starts a new cue. Names in caps ("AI", "ChatGPT") have more capitals and do not.
 */
const SENTENCE_START = /^\p{Lu}[\p{Ll}\p{M}]*$/u;

/** A filler the transcriber inserted where there is sound but no word (T3): cuttable, never captioned. */
export const isSynthetic = (w: object) => (w as { synthetic?: boolean }).synthetic === true;

/**
 * Words → caption cues. A cue closes on trailing punctuation, a pause before the next word or a next word that
 * starts a sentence; otherwise at
 * CHUNK_WORDS words, unless it would be on screen for less than CHUNK_MIN_S, then at `maxWords`.
 */
export function chunkWords<W extends Pick<TranscriptWord, 'text' | 'start' | 'end'>>(words: W[], maxWords: number): W[][] {
  const list = words.filter((w) => w.text.trim());
  const most = Math.max(1, Math.floor(maxWords));
  const target = Math.min(CHUNK_WORDS, most);
  const chunks: W[][] = [];
  let current: W[] = [];
  list.forEach((w, i) => {
    current.push(w);
    const next = list[i + 1];
    const gap = next ? next.start - w.end : 0;
    const dur = w.end - current[0].start;
    const sentence = Boolean(next && SENTENCE_START.test(next.text.trim()));
    if (!next || PUNCT_BREAK.test(w.text.trim()) || gap >= CHUNK_PAUSE_S || sentence || current.length >= most || (current.length >= target && dur >= CHUNK_MIN_S)) {
      chunks.push(current);
      current = [];
    }
  });
  return chunks;
}

/** The template's style with the owner's overrides (overrides.json `captions`, top-level keys replaced). */
export function captionStyle(base: CaptionStyle, owner?: Partial<CaptionStyle> | null): CaptionStyle {
  if (!owner) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(owner)) if (value !== undefined && value !== null) out[key] = value;
  return out as unknown as CaptionStyle;
}

export interface CaptionCue {
  id: string;
  start: number;
  end: number;
  words: { text: string; at: number; key: boolean }[];
}

/** Cues in output seconds, one segment at a time so a cue never spans a cut; each holds until the next one. */
export function captionCues(
  words: TranscriptWord[], segments: Segment[], cut: Set<number>, highlight: string[], maxWords: number, total: number,
): CaptionCue[] {
  const keys = new Set<string>();
  for (const h of highlight) for (const part of h.split(/\s+/)) { const n = normWord(part); if (n) keys.add(n); }
  const cues: CaptionCue[] = [];
  for (const seg of segments) {
    const inSeg = words.filter((x) => !cut.has(x.i) && !isSynthetic(x) && x.start >= seg.start - 0.001 && x.start < seg.end);
    for (const chunk of chunkWords(inSeg, maxWords)) {
      const start = seg.out + (chunk[0].start - seg.start);
      const end = seg.out + (Math.min(chunk[chunk.length - 1].end, seg.end) - seg.start);
      cues.push({
        id: `cap${cues.length}`, start, end: Math.max(end, start + 0.25),
        words: chunk.map((x) => ({ text: x.text, at: seg.out + (x.start - seg.start), key: keys.has(normWord(x.text)) })),
      });
    }
  }
  cues.forEach((c, k) => {
    const next = cues[k + 1];
    const end = Math.min(c.end + 0.08, next && next.start >= c.start ? next.start : total, total);
    c.end = Math.max(c.start + 0.2, end);
  });
  return cues;
}

export interface CaptionLayer {
  css: string;
  clips: string[];
  tweens: string[];
}

/**
 * Caption clips and their CSS. `pos` is the cue's vertical centre (0..1 from the top), sizes are percent of the
 * short side (the unit the template's sizePct uses), stroke and box sizes are pixels at 1080.
 */
export function captionLayer(cues: CaptionCue[], style: CaptionStyle, family: string, ctx: { W: number; H: number; dark: string }): CaptionLayer {
  const short = Math.min(ctx.W, ctx.H);
  const u = short / 1080;
  const size = r3((Math.max(1, style.font.sizePct) / 100) * short);
  const side = r3(Math.max(0, (100 - Math.min(100, Math.max(10, style.maxWidthPct))) / 2));
  const hl = cssValue(style.highlight.color, '#FFD23F');
  const inner = [
    'display:inline-block', 'max-width:100%', `text-align:${style.align === 'left' ? 'left' : 'center'}`,
    `font-family:${family}`, `font-weight:${Math.round(style.font.weight)}`, `font-size:${size}px`, 'line-height:1.18',
    `color:${cssValue(style.fill, '#FFFFFF')}`,
    style.font.upper ? 'text-transform:uppercase' : '',
    style.stroke && style.stroke.width > 0 ? `-webkit-text-stroke:${r3(style.stroke.width * u)}px ${cssValue(style.stroke.color, '#000000')};paint-order:stroke fill` : '',
    style.shadow ? `text-shadow:${cssValue(style.shadow)}` : '',
    style.box ? `background:${cssValue(style.box.color, 'rgba(0,0,0,.7)')};padding:${r3(style.box.padding * u)}px ${r3(style.box.padding * 1.6 * u)}px;border-radius:${r3(style.box.radius * u)}px;box-decoration-break:clone;-webkit-box-decoration-break:clone` : '',
  ].filter(Boolean).join(';');
  const key = style.highlight.mode === 'box'
    ? `background:${hl};color:${cssValue(ctx.dark, '#141416')};padding:0 .14em;border-radius:.12em;text-shadow:none;-webkit-text-stroke:0`
    : `color:${hl}`;
  const css = [
    `.cap{position:absolute;left:0;right:0;top:${r3(style.pos * 100)}%;transform:translateY(-50%);display:flex;justify-content:${style.align === 'left' ? 'flex-start' : 'center'};padding:0 ${side}%;z-index:15;pointer-events:none}`,
    `.cap-in{${inner}}`,
    '.cap .w{display:inline-block}',
    `.cap .k{${key}}`,
  ].join('\n');
  const clips: string[] = [];
  const tweens: string[] = [];
  for (const c of cues) {
    const spans = c.words.map((x, wi) => `<span id="${c.id}w${wi}" class="${x.key ? 'w k' : 'w'}">${esc(x.text)}</span>`).join(' ');
    clips.push(`<div id="${c.id}" class="clip cap" data-start="${r3(c.start)}" data-duration="${r3(c.end - c.start)}" data-track-index="2"><span id="${c.id}i" class="cap-in">${spans}</span></div>`);
    tweens.push(`tl.fromTo("#${c.id}i",{y:${Math.round(18 * u)},opacity:0},{y:0,opacity:1,duration:.12,ease:"power2.out"},${r3(c.start)});`);
    if (style.highlight.mode === 'pop') {
      c.words.forEach((x, wi) => {
        if (x.key) tweens.push(`tl.fromTo("#${c.id}w${wi}",{scale:1.4},{scale:1,duration:.2,ease:"back.out(2.2)",immediateRender:false},${r3(x.at)});`);
      });
    }
  }
  return { css, clips, tweens };
}

/** The caption font as a CSS family list (the composition declared it with @font-face, or a generic family). */
export const captionFamily = (family: string | null) => (family ? `'${cssFont(family)}',sans-serif` : 'sans-serif');
