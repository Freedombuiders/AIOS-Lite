// Template blocks as HyperFrames sub-compositions. A host slot mounts a block with data-composition-src; the
// block file is copied next to the composition (under assets/, so the preview's assets route serves it and the
// render reads it from the composition folder) and its props travel as data-variable-values, one value per
// variable the block declares on <html data-composition-variables>.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { safeFile } from '../../templates/registry.js';
import type { ComponentDef, TemplateManifest } from '../../templates/types.js';

export interface BlockVar {
  id: string;
  type: string;
  default?: unknown;
  options?: { value: string }[];
}

export interface Block {
  componentId: string;
  /** The block root's data-composition-id: the host slot must carry the same id. */
  compositionId: string;
  /** File name under assets/ (content hash, so a changed block gets a new name). */
  name: string;
  /** The block's file in its pack. */
  file: string;
  html: string;
  vars: BlockVar[];
}

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The variables a block declares on its <html> element ([] when it declares none or the JSON is broken). */
export function blockVars(html: string): BlockVar[] {
  const m = /<html\b[^>]*?\sdata-composition-variables=(?:'([^']*)'|"([^"]*)")/i.exec(html);
  if (!m) return [];
  try {
    const list = JSON.parse(decode(m[1] ?? m[2] ?? '')) as unknown;
    return Array.isArray(list)
      ? list.filter((v): v is BlockVar => Boolean(v) && typeof (v as BlockVar).id === 'string' && typeof (v as BlockVar).type === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Reads a component's block from its pack; null when the file is missing or outside the pack. */
export function loadBlock(manifest: TemplateManifest, dir: string, componentId: string, def: ComponentDef): Block | null {
  const file = safeFile(dir, def.file);
  if (!file) return null;
  const html = fs.readFileSync(file, 'utf8');
  const root = /<template\b[\s\S]*?\sdata-composition-id="([^"]+)"/i.exec(html);
  const hash = createHash('sha1').update(html).digest('hex').slice(0, 8);
  const slug = `${manifest.id}-${componentId}`.replace(/[^A-Za-z0-9-]+/g, '-').slice(0, 60);
  return { componentId, compositionId: root?.[1] ?? componentId, name: `tpl-${slug}-${hash}.html`, file, html, vars: blockVars(html) };
}

/**
 * The file one host slot mounts. A <video>/<audio> whose src comes from a variable (data-var-src) gets that
 * value as its authored src too: HyperFrames (0.8.156) times nested media from the compiled HTML, and media with
 * no src there is found only at run time and placed on the root timeline, so a B-roll clip would play from the
 * host's start instead of its own. With a real src the media is rebased on the slot like any nested media.
 */
export function blockInstance(block: Block, values: Record<string, unknown>): { name: string; html: string } {
  let changed = false;
  const html = block.html.replace(/<(video|audio)\b[^>]*>/gi, (tag) => {
    const bound = /\sdata-var-src="([^"]+)"/i.exec(tag);
    const value = bound ? values[bound[1]] : undefined;
    if (!bound || typeof value !== 'string' || !value || /\ssrc=/i.test(tag)) return tag;
    changed = true;
    return tag.replace(bound[0], `${bound[0]} src="${value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}"`);
  });
  if (!changed) return { name: block.name, html: block.html };
  const hash = createHash('sha1').update(html).digest('hex').slice(0, 8);
  return { name: block.name.replace(/-[0-9a-f]{8}\.html$/, `-${hash}.html`), html };
}

/** The block's default for one variable (e.g. the animIn preset it plays when the plan names none). */
export function varDefault(block: Block, id: string): unknown {
  return block.vars.find((v) => v.id === id)?.default;
}

/**
 * Values for data-variable-values: only variables the block declares, in its declaration order, each coerced to
 * the declared type. Missing values are left out (the block uses its default); an enum value the block does not
 * offer is left out too.
 */
export function blockValues(block: Block, raw: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const v of block.vars) {
    const value = raw[v.id];
    if (value === undefined || value === null) continue;
    if (v.type === 'number') {
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(n)) out[v.id] = Math.round(n * 1000) / 1000;
    } else if (v.type === 'boolean') {
      out[v.id] = value === true || value === 'true';
    } else if (v.type === 'enum') {
      const s = String(value);
      if (!v.options || v.options.some((o) => o.value === s)) out[v.id] = s;
    } else {
      out[v.id] = Array.isArray(value) ? value.map(String).join('\n') : String(value);
    }
  }
  return out;
}
