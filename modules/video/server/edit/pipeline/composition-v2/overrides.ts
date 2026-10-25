// The owner's overrides (overrides.json) over plan v2 elements. Words, props, entrance, sound, timing and
// hiding are applied while the composition is built; position and size are applied in the page after every
// seek, through the individual CSS `translate` and `scale` properties of the element's host slot, so they add
// to whatever transform the block animates instead of replacing it.
//
// The after-every-seek application and the use of the individual transform properties are adapted from OpenFilm
// (https://github.com/openfilm/openfilm) packages/openfilm/src/overrides.mjs, MIT License,
// Copyright (c) 2026 OpenFilm contributors (full notice: THIRD_PARTY_NOTICES.md).
import type { ElementOverride, ElementProps, ElementSound, OverridesDoc } from '../../types.js';

/** What an element looks like to the builder once the owner's override is applied. */
export interface Effective {
  at: number;
  duration: number;
  animIn?: string;
  sound?: ElementSound;
  /** The owner set `at`: snapToBeat leaves it where it is. */
  atFixed: boolean;
  /** Offset (percent of the frame) and size, applied in the page. */
  t?: [number, number];
  s?: number;
}

export function overrideOf(doc: OverridesDoc | null | undefined, id: string | undefined): ElementOverride | undefined {
  return id && doc ? doc.elements[id] : undefined;
}

export function effective(el: { at: number; duration: number; animIn?: string; sound?: ElementSound }, ov: ElementOverride | undefined): Effective {
  const animIn = ov?.animIn ?? el.animIn;
  const sound = ov?.sound ?? el.sound;
  return {
    at: ov?.at ?? el.at,
    duration: ov?.duration ?? el.duration,
    ...(animIn ? { animIn } : {}),
    ...(sound ? { sound } : {}),
    atFixed: ov?.at !== undefined,
    ...(ov?.t ? { t: ov.t } : {}),
    ...(ov?.s !== undefined ? { s: ov.s } : {}),
  };
}

/** A beat's words with the owner's text on top ('' is a value: the owner blanked that line). */
export function beatText(beat: { kicker?: string; title: string; sub?: string }, ov: ElementOverride | undefined) {
  const text = ov?.text ?? {};
  return { kicker: text.kicker ?? beat.kicker ?? '', title: text.title ?? beat.title, sub: text.sub ?? beat.sub ?? '' };
}

/** Props with the owner's props on top, key by key. */
export function withProps(props: ElementProps | undefined, ov: ElementOverride | undefined): ElementProps {
  return { ...(props ?? {}), ...(ov?.props ?? {}) };
}

/** One entry of the in-page list: host slot id, offset in percent of the frame, size multiplier. */
export interface PlacedOverride { id: string; t?: [number, number]; s?: number }

/**
 * The in-page half: `OV` lists the host slots to move or resize; `applyOverrides()` sets their `translate` and
 * `scale` and runs once at setup and again on every `hf-seek` the HyperFrames runtime dispatches.
 */
export function overridesScript(list: PlacedOverride[]): string {
  const ov = list.map((o) => ({ id: o.id, ...(o.t ? { t: o.t } : {}), ...(o.s !== undefined ? { s: o.s } : {}) }));
  return [
    `var OV=${JSON.stringify(ov).replace(/</g, '\\u003c')};`,
    'function applyOverrides(){',
    '  for(var i=0;i<OV.length;i++){',
    '    var o=OV[i],el=document.querySelector(\'[data-el-id="\'+o.id+\'"]\');',
    '    if(!el)continue;',
    '    if(o.t)el.style.setProperty("translate",o.t[0]+"% "+o.t[1]+"%");',
    '    if(o.s!==undefined)el.style.setProperty("scale",String(o.s));',
    '  }',
    '}',
    'window.addEventListener("hf-seek",applyOverrides);',
  ].join('\n');
}
