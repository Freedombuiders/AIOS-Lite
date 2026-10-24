/**
 * The prompt composer. Pure: no database, no files, no network.
 *
 * Output: one English prompt plus the ordered list of images to attach, each with
 * the role the prompt gives it ("Image 1 is the COMPOSITION reference…", "Images
 * 2–4 show Mia…"). Identity is locked twice: by the reference images (primary
 * anchor first) and by a written paragraph built from the persona's Appearance.
 * Warnings are Vietnamese, for the owner.
 */

import type {
  Appearance, Aspect, AssetKind, GenerationMode, GenerationParams, IdentitySource, LibraryKind, ModelInfo,
  RealismPreset, RefKind, RefRoleDto,
} from './types.js';

// ── Inputs ───────────────────────────────────────────────────────────

export interface IdentityRefIn {
  id: string;
  kind: RefKind;
  label: string;
  url: string;
  isPrimary: boolean;
  sort: number;
  createdAt: number;
}

export interface SlotItemIn {
  id: string;
  kind: LibraryKind;
  name: string;
  prompt: string;
  imageUrl: string | null;
}

export interface TemplateIn {
  id: string;
  name: string;
  url: string;
  notes: string;
}

export interface SourceIn {
  id: string;
  url: string;
  kind: AssetKind;
  width: number | null;
  height: number | null;
}

export interface PersonaIn {
  name: string;
  appearance: Appearance;
  realismPreset: RealismPreset;
  identitySource: IdentitySource;
  /** Used for spoken lines in video (animate with a script): how the persona sounds. */
  personality?: { voiceTone?: string };
}

export interface ComposeInput {
  persona: PersonaIn;
  mode: GenerationMode;
  slots: Partial<Record<LibraryKind, SlotItemIn>>;
  template: TemplateIn | null;
  /** The persona's identity pack, any order. */
  refs: IdentityRefIn[];
  /** animate / talking: the source image asset. */
  source: SourceIn | null;
  params: GenerationParams;
  /** Selection.realism; falls back to the persona's preset. */
  realism?: RealismPreset;
  model: ModelInfo | null;
  promptOverride?: string;
}

export interface ComposeResult {
  prompt: string;
  refs: RefRoleDto[];
  /** Something the owner should act on or know before spending. */
  warnings: string[];
  /** Expected behaviour worth knowing (how the images were chosen); not a problem. */
  notes: string[];
  /** Images left out because of the model's limit. */
  dropped: number;
}

/** Most identity images sent in one request: beyond this they add cost, not likeness, and crowd out slot images. */
export const IDENTITY_SOFT_CAP = 8;
/**
 * Identity images kept even when the owner's outfit/hair/location images compete for the model's
 * limit: the primary anchor, the 360° sheet and three angles hold the face; past that a picked
 * reference image adds more than one more angle does. On a very small limit (ChatGPT takes 5) the
 * floor drops to IDENTITY_MIN so two owner images still fit.
 */
export const IDENTITY_FLOOR = 5;
export const IDENTITY_MIN = 3;

/** The identity floor for a model limit: 5 from 7 images up, never below 3 (or the limit itself). */
export function identityFloor(maxRefs: number): number {
  return Math.min(IDENTITY_FLOOR, Math.max(IDENTITY_MIN, maxRefs - 2));
}
const DEFAULT_MAX_REFS = 14;

const IMAGE_MODES: GenerationMode[] = ['compose', 'recreate', 'sheet', 'bootstrap', 'freeform'];
export const isImageMode = (mode: GenerationMode): boolean => IMAGE_MODES.includes(mode);

// ── Small helpers ────────────────────────────────────────────────────

export interface Pronouns { subj: string; obj: string; poss: string }

export function pronounsFor(gender: string): Pronouns {
  const g = gender.trim().toLowerCase();
  const word = (w: string) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(g);
  if (/female|woman|girl|lady|nữ|con gái/.test(g) || word('f') || word('she')) return { subj: 'she', obj: 'her', poss: 'her' };
  if (word('male') || word('man') || word('boy') || word('m') || word('he') || /(^|\s)nam(\s|$)|con trai|đàn ông|nam giới/.test(g)) {
    return { subj: 'he', obj: 'him', poss: 'his' };
  }
  return { subj: 'they', obj: 'them', poss: 'their' };
}

/** "Image 2", "Images 2–4", "Images 2, 4 and 6". */
export function imageList(indices: number[]): string {
  const sorted = [...indices].sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  if (sorted.length === 1) return `Image ${sorted[0]}`;
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
  if (contiguous) return `Images ${sorted[0]}–${sorted[sorted.length - 1]}`;
  return `Images ${sorted.slice(0, -1).join(', ')} and ${sorted[sorted.length - 1]}`;
}

export function aspectRatioValue(aspect: Aspect): number {
  const [a, b] = aspect.split(':').map(Number);
  return a / b;
}

export function orientationOf(aspect: Aspect): string {
  const r = aspectRatioValue(aspect);
  return r === 1 ? 'square' : r < 1 ? 'vertical portrait' : 'horizontal landscape';
}

/** The allowed aspect closest to width/height (by log ratio). */
export function closestAspect(width: number, height: number, allowed: Aspect[]): Aspect | null {
  if (!width || !height || allowed.length === 0) return null;
  const r = Math.log(width / height);
  let best: Aspect | null = null;
  let bestD = Infinity;
  for (const a of allowed) {
    const d = Math.abs(Math.log(aspectRatioValue(a)) - r);
    if (d < bestD) { bestD = d; best = a; }
  }
  return best;
}

/** Instagram feed photos must be between 4:5 (0.8) and 1.91:1. */
export function instagramFeedAllows(aspect: Aspect): boolean {
  const r = aspectRatioValue(aspect);
  return r >= 0.8 - 1e-9 && r <= 1.91 + 1e-9;
}

const clean = (s: string | undefined | null): string => (s ?? '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');

const KIND_RANK: Record<RefKind, number> = { anchor: 2, sheet: 1, angle: 3, body: 4, expression: 5, other: 6 };

/**
 * Identity pack order for a request: the primary anchor (or the first anchor),
 * then character sheets, other anchors, angles, body shots, expressions, others.
 */
export function orderIdentityRefs<T extends Pick<IdentityRefIn, 'kind' | 'isPrimary' | 'sort' | 'createdAt'>>(refs: T[]): T[] {
  const bySort = (a: T, b: T) => a.sort - b.sort || a.createdAt - b.createdAt;
  const anchors = refs.filter((r) => r.kind === 'anchor').sort(bySort);
  const primary = refs.find((r) => r.isPrimary && r.kind === 'anchor') ?? anchors[0] ?? refs.find((r) => r.isPrimary) ?? null;
  const rest = refs.filter((r) => r !== primary).sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || bySort(a, b));
  return primary ? [primary, ...rest] : rest;
}

// ── Realism ──────────────────────────────────────────────────────────

export const REALISM_PRESETS: Record<Exclude<RealismPreset, 'none'>, string> = {
  'iphone-candid': 'Candid smartphone photo, as if taken on an iPhone: natural available light, slight sensor noise, imperfect casual framing, true-to-life colours, an authentic social-media moment rather than a professional shoot.',
  'pro-photo': 'Professional photograph on a full-frame camera with a prime lens: accurate exposure, natural colours, shallow depth of field, critical focus on the eyes.',
  editorial: 'High-end fashion editorial photograph: deliberate styling, controlled professional lighting, magazine-quality finish that keeps real skin texture.',
  'film-35mm': '35mm analog film photograph: organic film grain, gentle halation, slightly imperfect focus, authentic film colour rendition.',
  'studio-clean': 'Clean studio photograph: seamless backdrop, soft even key and fill light, neutral colour balance, sharp detail.',
};

export const REALISM_BLOCK = 'Photorealistic, indistinguishable from a real photograph. Natural skin texture with visible pores, fine vellus hair and subtle imperfections; no plastic, waxy or airbrushed skin. '
  + 'Anatomically correct hands with five fingers each, no extra, missing or merged fingers or limbs. Natural eyes with matching irises and realistic catchlights. '
  + 'Real-world lighting with physically plausible shadows and reflections. No text, captions, watermark, logo, signature, frame or border.';

// ── Identity paragraph ───────────────────────────────────────────────

function describePerson(a: Appearance): string[] {
  const lines: string[] = [];
  const who = [clean(a.ageRange), clean(a.ethnicity), clean(a.gender)].filter(Boolean).join(' ');
  if (who) lines.push(`${/^[aeiou]/i.test(who) ? 'an' : 'a'} ${who}`);
  return lines;
}

/**
 * hair: include the default hair (off under a hair slot).
 * style: include the personal style keywords (off under an outfit or hair slot, which set the styling).
 * The signature look is part of the identity (glasses, earrings…) and is always kept: an outfit slot
 * replaces clothing, not the accessories the audience recognises.
 */
function appearanceDetails(a: Appearance, opts: { hair: boolean; style: boolean }): string[] {
  const out: string[] = [];
  if (clean(a.face)) out.push(`Face: ${clean(a.face)}.`);
  if (clean(a.eyes)) out.push(`Eyes: ${clean(a.eyes)}.`);
  if (clean(a.skin)) out.push(`Skin: ${clean(a.skin)}.`);
  if (clean(a.body)) out.push(`Body: ${clean(a.body)}.`);
  if (clean(a.marks)) out.push(`Permanent marks that must stay visible whenever that area is in view: ${clean(a.marks)}.`);
  if (opts.hair && clean(a.hair)) out.push(`Hair (default): ${clean(a.hair)}.`);
  if (clean(a.signatureLook)) out.push(`Signature look, always present unless the direction explicitly removes it: ${clean(a.signatureLook)}.`);
  const style = (a.styleKeywords ?? []).map(clean).filter(Boolean);
  if (opts.style && style.length) out.push(`Personal style: ${style.join(', ')}.`);
  return out;
}

function identityLock(p: PersonaIn, pr: Pronouns, opts: { hairSlot: boolean; outfitSlot: boolean; hasRefs: boolean }): string {
  const a = p.appearance;
  const who = describePerson(a);
  const parts: string[] = [];
  parts.push(who.length ? `${p.name} is ${who[0]}.` : `${p.name} is the person in the identity reference images.`);
  parts.push(...appearanceDetails(a, { hair: !opts.hairSlot, style: !opts.hairSlot && !opts.outfitSlot }));
  parts.push(
    `Keep ${pr.poss} identity 100% consistent${opts.hasRefs ? ' with the reference images' : ''} in every detail. `
    + `Do not beautify, slim, age, de-age, lighten or darken ${pr.poss} skin, or change ${pr.poss} ethnicity, and never blend ${pr.poss} face with anyone else's.`,
  );
  return parts.join(' ');
}

// ── Composer ─────────────────────────────────────────────────────────

interface Attached { role: RefRoleDto['role']; label: string; url: string | null; kind?: RefKind }

export function composePrompt(input: ComposeInput): ComposeResult {
  const { persona, mode, slots, template, params, model } = input;
  const name = clean(persona.name) || 'the persona';
  const pr = pronounsFor(persona.appearance.gender ?? '');
  const warnings: string[] = [];
  const notes: string[] = [];
  const maxRefs = Math.max(0, model?.maxRefs ?? DEFAULT_MAX_REFS);
  const aspect: Aspect = params.aspect ?? (mode === 'sheet' ? '16:9' : mode === 'animate' || mode === 'talking' ? '9:16' : '4:5');
  const modelLabel = model?.label ?? 'đã chọn';

  // ── Choose and order the images ──
  const attached: Attached[] = [];
  let dropped = 0;

  if (mode === 'animate' || mode === 'talking') {
    if (input.source) attached.push({ role: 'source', label: 'Ảnh nguồn', url: input.source.url });
    else warnings.push('Chưa chọn ảnh nguồn để làm video.');
  } else if (mode !== 'bootstrap') {
    let identity = orderIdentityRefs(input.refs);
    if (mode === 'sheet') {
      const nonSheet = identity.filter((r) => r.kind !== 'sheet');
      if (nonSheet.length) identity = nonSheet;
    }
    const useTemplate = template && (mode === 'recreate' || mode === 'compose' || mode === 'freeform') ? template : null;
    const slotImages: Attached[] = mode === 'sheet' ? [] : (['outfit', 'hair', 'scene'] as const)
      .map((k) => slots[k])
      .filter((s): s is SlotItemIn => Boolean(s?.imageUrl))
      .map((s) => ({ role: s.kind as RefRoleDto['role'], label: `${s.kind === 'outfit' ? 'Trang phục' : s.kind === 'hair' ? 'Kiểu tóc' : 'Bối cảnh'}: ${s.name}`, url: s.imageUrl }));

    // Budget within the model's limit: a floor of identity images, then the composition template,
    // then the owner's outfit/hair/location images, then more identity images up to the soft cap.
    const reserve = mode === 'recreate' && useTemplate && maxRefs >= 2 ? 1 : 0;
    const idFloor = Math.max(0, Math.min(identity.length, identityFloor(maxRefs), maxRefs - reserve));
    const keepTemplate = !!useTemplate && maxRefs - idFloor > 0;
    const slotKeep = slotImages.slice(0, Math.max(0, maxRefs - idFloor - (keepTemplate ? 1 : 0)));
    const idCap = Math.max(idFloor, Math.min(identity.length, IDENTITY_SOFT_CAP, maxRefs - (keepTemplate ? 1 : 0) - slotKeep.length));
    const idKeep = identity.slice(0, idCap);
    const idDropped = identity.length - idKeep.length;
    const otherDropped = (useTemplate && !keepTemplate ? 1 : 0) + (slotImages.length - slotKeep.length);
    dropped = idDropped + otherDropped;

    if (keepTemplate && useTemplate) attached.push({ role: 'composition', label: `Ảnh mẫu: ${useTemplate.name || 'không tên'}`, url: useTemplate.url });
    for (const [i, r] of idKeep.entries()) {
      const role: RefRoleDto['role'] = r.kind === 'sheet' ? 'sheet' : 'identity';
      const label = r.label?.trim() || (i === 0 ? 'Ảnh gốc chính' : r.kind === 'sheet' ? 'Bảng nhân vật 360°' : 'Ảnh nhận diện');
      attached.push({ role, label, url: r.url, kind: r.kind });
    }
    attached.push(...slotKeep);

    if (identity.length === 0) {
      warnings.push('Chưa có ảnh gốc (anchor) của KOL: khuôn mặt sẽ không nhất quán. Hãy tải ảnh lên hoặc tạo ảnh gốc (bootstrap) trước.');
    }
    if (otherDropped > 0) {
      const lost = [...(useTemplate && !keepTemplate ? ['ảnh mẫu'] : []), ...slotImages.slice(slotKeep.length).map((s) => s.label.split(':')[0].toLowerCase())];
      warnings.push(`Model ${modelLabel} chỉ nhận tối đa ${maxRefs} ảnh tham chiếu: không gửi kèm được ảnh ${lost.join(', ')} (vẫn mô tả bằng chữ), ưu tiên ${idKeep.length} ảnh nhận diện của KOL.`);
    } else if (idDropped > 0) {
      notes.push(`Gửi ${idKeep.length}/${identity.length} ảnh nhận diện tốt nhất (ảnh gốc chính, bảng 360°, các góc)${idKeep.length < IDENTITY_SOFT_CAP ? `: ${modelLabel} nhận tối đa ${maxRefs} ảnh` : ''}.`);
    }
    if (useTemplate) {
      notes.push(`Ảnh mẫu chỉ dùng cho bố cục, dáng, ánh sáng: người trong mẫu sẽ được thay bằng ${name}, không sao chép danh tính của họ.`);
    }
  } else if (input.refs.some((r) => r.kind === 'anchor')) {
    warnings.push('KOL đã có ảnh gốc: ảnh tạo từ mô tả sẽ là một khuôn mặt KHÁC. Chỉ dùng khi muốn chọn lại gương mặt.');
  }

  if (mode === 'recreate' && !template) warnings.push('Chế độ tái tạo cần chọn một ảnh mẫu.');
  if (mode === 'bootstrap' && !clean(persona.appearance.face) && !clean(persona.appearance.ethnicity) && !clean(persona.appearance.gender)) {
    warnings.push('Mô tả ngoại hình còn trống: hãy điền giới tính, độ tuổi, khuôn mặt, mắt, da, tóc trước khi tạo ảnh gốc.');
  }
  if ((mode === 'compose' || mode === 'recreate' || mode === 'freeform') && !instagramFeedAllows(aspect)) {
    warnings.push(`Tỉ lệ ${aspect} không đăng được lên feed Instagram (cần từ 4:5 đến 1.91:1); Reels/Story thì được.`);
  }
  if (model && model.aspects.length && !model.aspects.includes(aspect)) {
    warnings.push(`Model ${modelLabel} không hỗ trợ tỉ lệ ${aspect}.`);
  }
  if ((mode === 'animate' || mode === 'talking') && input.source?.width && input.source.height && model?.aspects.length) {
    const near = closestAspect(input.source.width, input.source.height, ['1:1', '4:5', '3:4', '2:3', '9:16', '16:9', '5:4', '4:3', '3:2']);
    if (near && !model.aspects.includes(near) && model.aspects.length <= 3) {
      warnings.push(`Ảnh nguồn có tỉ lệ khoảng ${near}: video ${aspect} sẽ cắt hoặc mở rộng khung hình.`);
    }
  }
  if (persona.identitySource === 'licensed') {
    warnings.push(`${name} dựa trên người thật: chỉ dùng trong phạm vi đã được đồng ý (xem ghi chú đồng ý).`);
  }
  if (mode === 'talking') {
    const script = (params.script ?? '').trim();
    if (!script) warnings.push('Chưa có lời thoại cho video nói chuyện.');
  }

  const refs: RefRoleDto[] = attached.map((a, i) => ({ index: i + 1, role: a.role, label: a.label, url: a.url }));

  // ── Prompt ──
  const override = input.promptOverride?.trim();
  if (override) {
    warnings.push('Đang dùng prompt tự viết: khóa danh tính bằng chữ không được thêm, chỉ còn ảnh tham chiếu.');
    return { prompt: override, refs, warnings, notes, dropped };
  }

  let prompt: string;
  if (mode === 'animate') prompt = animatePrompt(input, name, pr, attached.length > 0);
  else if (mode === 'talking') prompt = talkingPrompt(input, name, pr);
  else prompt = imagePrompt(input, name, pr, attached, aspect);
  return { prompt, refs, warnings, notes, dropped };
}

// ── Image prompts ────────────────────────────────────────────────────

function roleLines(attached: Attached[], name: string, pr: Pronouns, mode: GenerationMode, template: TemplateIn | null): string[] {
  const lines: string[] = [];
  const idx = (pred: (a: Attached) => boolean) => attached.map((a, i) => (pred(a) ? i + 1 : 0)).filter(Boolean);
  const comp = idx((a) => a.role === 'composition');
  if (comp.length) {
    const copies = mode === 'recreate'
      ? 'copy its framing, pose, body position, camera angle, lighting, background, styling and mood'
      : 'copy its framing, pose, camera angle, lighting, background and mood';
    let line = `${imageList(comp)} is the COMPOSITION reference: ${copies} — NOT the person's face, body or identity. Any person in it must be completely replaced by ${name}.`;
    if (clean(template?.notes)) line += ` Notes on this composition: ${clean(template?.notes)}.`;
    lines.push(line);
  }
  const ident = idx((a) => a.role === 'identity');
  if (ident.length) {
    const verb = ident.length === 1 ? 'shows' : 'show';
    lines.push(
      `${imageList(ident)} ${verb} ${name}: ${pr.poss} face must match exactly — same facial structure and proportions, eye shape and colour, eyebrows, nose, lips, jawline, ears, skin tone, moles and marks.`
      + (ident.length > 1 ? ` Image ${ident[0]} is the primary identity anchor; the others show the same person from other angles.` : ''),
    );
  }
  const sheet = idx((a) => a.role === 'sheet');
  if (sheet.length) {
    lines.push(`${imageList(sheet)} ${sheet.length === 1 ? 'is' : 'are'} ${name}'s 360° CHARACTER SHEET (the same person from several angles): use it for head shape, profile, ears and hairline from every side.`);
  }
  const outfit = idx((a) => a.role === 'outfit');
  if (outfit.length) lines.push(`${imageList(outfit)} shows the OUTFIT only: dress ${name} in exactly these garments (cut, colour, fabric, details); ignore whoever wears them.`);
  const hair = idx((a) => a.role === 'hair');
  if (hair.length) lines.push(`${imageList(hair)} shows the HAIRSTYLE only: copy the hairstyle and hair colour, not the face.`);
  const scene = idx((a) => a.role === 'scene');
  if (scene.length) lines.push(`${imageList(scene)} shows the LOCATION only: place ${name} in this environment and ignore any people in it.`);
  return lines;
}

function slotLines(input: ComposeInput, name: string, pr: Pronouns): string[] {
  const s = input.slots;
  const lines: string[] = [];
  const p = (k: LibraryKind) => clean(s[k]?.prompt);
  if (p('outfit')) {
    const keep = clean(input.persona.appearance.signatureLook);
    lines.push(`Outfit: REPLACE ${pr.poss} clothing completely with ${p('outfit')}. No trace of the clothing from any reference image remains.`
      + (keep ? ` Keep ${pr.poss} signature look (${keep}).` : ''));
  }
  if (p('hair')) lines.push(`Hair: ${p('hair')} (this replaces ${pr.poss} default hair).`);
  if (p('expression')) lines.push(`Expression: ${p('expression')}.`);
  if (p('pose')) lines.push(`Pose: ${p('pose')}.`);
  if (p('scene')) lines.push(`Setting: ${p('scene')}.`);
  if (p('look')) lines.push(`Look and colour grade: ${p('look')}.`);
  if (p('effect')) lines.push(`Effect: ${p('effect')}.`);
  if (p('camera')) lines.push(`Camera: ${p('camera')}.`);
  if (lines.length === 0 && input.mode === 'compose' && !input.template) {
    lines.push(`A natural, flattering everyday photo of ${name} with a relaxed genuine expression.`);
  }
  return lines;
}

function imagePrompt(input: ComposeInput, name: string, pr: Pronouns, attached: Attached[], aspect: Aspect): string {
  const { persona, mode, slots } = input;
  const hasIdentity = attached.some((a) => a.role === 'identity' || a.role === 'sheet');
  const blocks: string[] = [];

  // Task.
  if (mode === 'bootstrap') {
    blocks.push(`Create an ultra-realistic portrait photograph of a new, original person who will become the identity anchor of a virtual influencer named ${name}.`);
  } else if (mode === 'sheet') {
    blocks.push(`Create a professional character reference sheet (turnaround) of ${name}${hasIdentity ? ', the person shown in the reference images' : ''}.`);
  } else if (mode === 'recreate') {
    const comp = attached.findIndex((a) => a.role === 'composition');
    blocks.push(comp >= 0 ? `Recreate the photograph in Image ${comp + 1} with ${name} as the subject.` : `Create a new photorealistic photograph of ${name}.`);
  } else if (mode === 'freeform') {
    blocks.push(`Create a new photorealistic image of ${name}${hasIdentity ? ', the person shown in the identity reference images' : ''}, following the direction below.`);
  } else {
    blocks.push(`Create a new photorealistic photograph of ${name}${hasIdentity ? ', the person shown in the identity reference images' : ''}.`);
  }

  // Image roles.
  const roles = roleLines(attached, name, pr, mode, input.template);
  if (roles.length) blocks.push(`REFERENCE IMAGES:\n${roles.map((l) => `- ${l}`).join('\n')}`);

  // Identity.
  if (mode === 'bootstrap') {
    const a = persona.appearance;
    const who = describePerson(a);
    const details = appearanceDetails(a, { hair: !slots.hair, style: !slots.hair && !slots.outfit });
    blocks.push(`THE PERSON:\n${who.length ? `${who[0][0].toUpperCase()}${who[0].slice(1)}.` : 'An adult.'} ${details.join(' ')}`.trim());
    blocks.push(
      'FRAMING: head-and-shoulders portrait, facing the camera straight on, looking directly into the lens, neutral relaxed expression with closed lips or a slight natural smile, both eyes open, '
      + 'no hair or hands covering the face, no sunglasses or accessories hiding the face. Plain neutral light-grey studio background. Soft, even, diffused light with gentle fill and true-to-life skin tones.',
    );
    blocks.push('This image will be the reference for every future photo of this person, so the face must be sharp, unobstructed and completely realistic. The person must be an adult and must not resemble any real celebrity or public figure.');
  } else {
    blocks.push(`IDENTITY LOCK:\n${identityLock(persona, pr, { hairSlot: Boolean(slots.hair), outfitSlot: Boolean(slots.outfit), hasRefs: hasIdentity })}`);
  }

  // Mode specifics and slots.
  if (mode === 'sheet') {
    blocks.push(
      'LAYOUT: one image with seven panels of the SAME person in a clean, evenly spaced grid: front view, three-quarter left, profile left, back view, three-quarter right, profile right, '
      + 'and one close-up of the face. Full body in the six turnaround panels, standing in a relaxed neutral pose with arms slightly away from the body. '
      + 'Neutral mid-grey seamless background, identical soft even studio lighting, identical outfit and hairstyle in every panel. No labels, no text, no numbers, no panel borders.',
    );
    const outfit = clean(slots.outfit?.prompt);
    blocks.push(outfit
      ? `Outfit in every panel: ${outfit}.`
      : 'Outfit in every panel: simple fitted plain clothing (a fitted charcoal tank top and charcoal leggings, barefoot or plain sneakers) so the body shape is readable.');
    if (clean(slots.hair?.prompt)) blocks.push(`Hair in every panel: ${clean(slots.hair?.prompt)}.`);
  } else if (mode !== 'bootstrap') {
    const lines = slotLines(input, name, pr);
    if (lines.length) blocks.push(`DIRECTION:\n${lines.map((l) => `- ${l}`).join('\n')}`);
  }

  // Style.
  const preset = input.realism ?? persona.realismPreset;
  if (mode !== 'sheet' && mode !== 'bootstrap' && preset && preset !== 'none') blocks.push(`PHOTO STYLE: ${REALISM_PRESETS[preset]}`);
  blocks.push(`REALISM: ${REALISM_BLOCK}`);
  blocks.push(`FORMAT: aspect ratio ${aspect} (${orientationOf(aspect)}). One single photograph${mode === 'sheet' ? ' (the whole sheet)' : ''}, no collage${mode === 'sheet' ? ' beyond the sheet panels' : ''}.`);

  const extra = clean(input.params.extraPrompt);
  if (extra) blocks.push(`Additional direction: ${extra}.`);
  return blocks.join('\n\n');
}

// ── Video prompts ────────────────────────────────────────────────────

function animatePrompt(input: ComposeInput, name: string, pr: Pronouns, hasSource: boolean): string {
  const s = input.slots;
  const blocks: string[] = [];
  const line = clean(input.params.script);
  blocks.push(`Animate ${hasSource ? 'this photo' : 'a photo'} of ${name} into a short, realistic video.`);
  blocks.push(line
    ? `Motion: ${name} looks into the camera and talks naturally — natural blinking, expressive eyebrows, small head movements and relaxed hand gestures, hair and clothing moving gently. `
      + 'Keep every movement smooth and physically plausible.'
    : 'Motion: subtle natural movement — breathing, natural blinking, a slight head turn, a soft change of expression, hair and clothing moving gently. '
      + 'Keep every movement small, smooth and physically plausible.');
  if (clean(s.expression?.prompt)) blocks.push(`Expression during the clip: ${clean(s.expression?.prompt)}.`);
  if (clean(s.pose?.prompt)) blocks.push(`Action: ${clean(s.pose?.prompt)}.`);
  blocks.push(
    `Identity: ${name}'s face must stay exactly as in the start frame in every frame — same features, proportions and skin tone. `
    + `No morphing, warping or face changes; ${pr.poss} hands keep five fingers.`,
  );
  blocks.push(`Camera: ${clean(s.camera?.prompt) || 'static camera with a very slight natural handheld drift'}.`);
  if (clean(s.effect?.prompt)) blocks.push(`Atmosphere: ${clean(s.effect?.prompt)}.`);
  blocks.push('Keep the lighting, outfit and background consistent with the start frame. No new people, no text, no subtitles, no watermark.');
  if (line) {
    // The persona's tone is often written in Vietnamese; inside an English video prompt that only confuses the model.
    const rawTone = clean(input.persona.personality?.voiceTone);
    const tone = rawTone && !/[^\x00-\x7F]/.test(rawTone) ? rawTone : 'warm, friendly and upbeat, like a best friend';
    blocks.push(
      `Speech: ${name} says exactly this line, word for word, in the language it is written in, with accurate lip-sync: "${line.replace(/"/g, "'")}". `
      + `Voice: a natural ${input.persona.appearance.gender?.toLowerCase().startsWith('m') ? "young man's" : "young woman's"} voice${tone ? `, ${tone}` : ''}; clear, well paced, finished within the clip. `
      + 'Audio: only her voice and a quiet natural room tone; no music, no other voices.',
    );
  } else if (input.params.audio) {
    blocks.push('Audio: natural ambient sound that fits the scene; no music and no speech.');
  }
  const extra = clean(input.params.extraPrompt);
  if (extra) blocks.push(`Additional direction: ${extra}.`);
  return blocks.join('\n');
}

function talkingPrompt(input: ComposeInput, name: string, pr: Pronouns): string {
  const blocks: string[] = [];
  blocks.push(
    `${name} speaks directly to the camera with accurate lip-sync to the audio, natural blinking, subtle head movements, expressive eyebrows and calm natural hand gestures.`,
  );
  if (clean(input.slots.expression?.prompt)) blocks.push(`Mood: ${clean(input.slots.expression?.prompt)}.`);
  blocks.push(`Identity unchanged from the image: same face, proportions and skin tone in every frame, no morphing; ${pr.poss} teeth and mouth look natural.`);
  blocks.push(`Camera: ${clean(input.slots.camera?.prompt) || 'static, eye level'}. Keep the background and lighting as in the image. No text or watermark.`);
  const extra = clean(input.params.extraPrompt);
  if (extra) blocks.push(`Additional direction: ${extra}.`);
  return blocks.join('\n');
}

/** English label for an attached image, used inside multi-part provider requests ("Image 2 (Mia — identity reference)"). */
export function providerLabel(role: RefRoleDto['role'], personaName: string): string {
  const n = clean(personaName) || 'the persona';
  switch (role) {
    case 'composition': return 'composition reference';
    case 'identity': return `${n} — identity reference`;
    case 'sheet': return `${n} — character sheet`;
    case 'outfit': return 'outfit reference';
    case 'hair': return 'hairstyle reference';
    case 'scene': return 'location reference';
    case 'source': return `${n} — start frame`;
    default: return 'reference';
  }
}
