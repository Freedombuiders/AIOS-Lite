import { describe, expect, it } from 'vitest';

import {
  closestAspect, composePrompt, IDENTITY_FLOOR, IDENTITY_SOFT_CAP, identityFloor, imageList, instagramFeedAllows, orderIdentityRefs, pronounsFor, REALISM_BLOCK,
  type ComposeInput, type IdentityRefIn, type SlotItemIn,
} from './prompt.js';
import type { Appearance, LibraryKind, ModelInfo } from './types.js';

const appearance: Appearance = {
  gender: 'female', ageRange: '24-year-old', ethnicity: 'Vietnamese', face: 'oval face, soft jawline, small straight nose, full lips',
  eyes: 'almond-shaped dark brown eyes', skin: 'warm light-olive skin', hair: 'long straight black hair with air bangs',
  body: 'slim, 1m62', marks: 'small mole under the left eye', styleKeywords: ['minimal', 'pastel'], signatureLook: 'thin gold hoop earrings',
};

const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({
  id: 'gemini-3-pro-image', provider: 'gemini', kind: 'image', label: 'Nano Banana Pro', maxRefs: 14,
  aspects: ['1:1', '4:5', '3:4', '2:3', '9:16', '16:9', '5:4', '4:3', '3:2'], qualities: ['standard', 'high', 'ultra'], priceNote: '', ...over,
});

let n = 0;
const ref = (kind: IdentityRefIn['kind'], over: Partial<IdentityRefIn> = {}): IdentityRefIn => {
  n += 1;
  return { id: `r${n}`, kind, label: '', url: `/api/kol/media/ref/r${n}`, isPrimary: false, sort: n, createdAt: 1000 + n, ...over };
};

const slot = (kind: LibraryKind, prompt: string, imageUrl: string | null = null): SlotItemIn => ({ id: `s-${kind}`, kind, name: `${kind} item`, prompt, imageUrl });

const base = (over: Partial<ComposeInput> = {}): ComposeInput => ({
  persona: { name: 'Mia', appearance, realismPreset: 'pro-photo', identitySource: 'synthetic' },
  mode: 'compose',
  slots: {},
  template: null,
  refs: [ref('anchor', { isPrimary: true }), ref('angle'), ref('sheet')],
  source: null,
  params: { aspect: '4:5' },
  model: model(),
  ...over,
});

describe('helpers', () => {
  it('names image lists like a person would', () => {
    expect(imageList([2])).toBe('Image 2');
    expect(imageList([2, 3, 4])).toBe('Images 2–4');
    expect(imageList([2, 4, 6])).toBe('Images 2, 4 and 6');
  });

  it('picks pronouns from the written gender (English and Vietnamese)', () => {
    expect(pronounsFor('female').poss).toBe('her');
    expect(pronounsFor('Nữ').poss).toBe('her');
    expect(pronounsFor('male').poss).toBe('his');
    expect(pronounsFor('nam').poss).toBe('his');
    expect(pronounsFor('').poss).toBe('their');
    expect(pronounsFor('non-binary').poss).toBe('their');
  });

  it('knows the Instagram feed aspect window', () => {
    expect(instagramFeedAllows('4:5')).toBe(true);
    expect(instagramFeedAllows('1:1')).toBe(true);
    expect(instagramFeedAllows('16:9')).toBe(true);
    expect(instagramFeedAllows('3:4')).toBe(false);
    expect(instagramFeedAllows('2:3')).toBe(false);
    expect(instagramFeedAllows('9:16')).toBe(false);
  });

  it('finds the closest allowed aspect', () => {
    expect(closestAspect(1080, 1350, ['9:16', '16:9'])).toBe('9:16');
    expect(closestAspect(1920, 1080, ['9:16', '16:9'])).toBe('16:9');
    expect(closestAspect(1000, 1000, ['1:1', '4:5'])).toBe('1:1');
  });

  it('orders the identity pack: primary anchor, sheet, other anchors, angles, body, expression', () => {
    const refs = [
      ref('expression', { sort: 0 }), ref('body', { sort: 1 }), ref('angle', { sort: 2 }), ref('anchor', { sort: 3 }),
      ref('sheet', { sort: 4 }), ref('anchor', { sort: 5, isPrimary: true }), ref('other', { sort: 6 }),
    ];
    const kinds = orderIdentityRefs(refs).map((r) => `${r.kind}${r.isPrimary ? '*' : ''}`);
    expect(kinds).toEqual(['anchor*', 'sheet', 'anchor', 'angle', 'body', 'expression', 'other']);
  });

  it('treats the first anchor as primary when none is flagged', () => {
    const refs = [ref('angle', { sort: 0 }), ref('anchor', { sort: 5 }), ref('anchor', { sort: 2 })];
    expect(orderIdentityRefs(refs)[0]).toBe(refs[2]);
  });
});

describe('composePrompt — compose', () => {
  it('builds numbered roles, identity lock, slots, style and realism', () => {
    const r = composePrompt(base({
      slots: {
        outfit: slot('outfit', 'a red silk áo dài with gold embroidery'),
        expression: slot('expression', 'warm genuine smile'),
        scene: slot('scene', 'Hoi An lantern street at night'),
        camera: slot('camera', '85mm f/1.4 portrait lens'),
        look: slot('look', 'shot on Kodak Portra 400 film'),
      },
      params: { aspect: '4:5', extraPrompt: 'holding a cup of egg coffee' },
    }));
    expect(r.refs.map((x) => x.role)).toEqual(['identity', 'sheet', 'identity']);
    expect(r.refs.map((x) => x.index)).toEqual([1, 2, 3]);
    expect(r.prompt).toContain('Images 1 and 3 show Mia: her face must match exactly');
    expect(r.prompt).toContain('Image 1 is the primary identity anchor');
    expect(r.prompt).toContain("Image 2 is Mia's 360° CHARACTER SHEET");
    expect(r.prompt).toContain('Mia is a 24-year-old Vietnamese female.');
    expect(r.prompt).toContain('small mole under the left eye');
    expect(r.prompt).toContain('REPLACE her clothing completely with a red silk áo dài with gold embroidery');
    expect(r.prompt).toContain('Expression: warm genuine smile.');
    expect(r.prompt).toContain('Setting: Hoi An lantern street at night.');
    expect(r.prompt).toContain('Camera: 85mm f/1.4 portrait lens.');
    expect(r.prompt).toContain('Look and colour grade: shot on Kodak Portra 400 film.');
    expect(r.prompt).toContain('PHOTO STYLE: Professional photograph');
    expect(r.prompt).toContain(REALISM_BLOCK);
    expect(r.prompt).toContain('aspect ratio 4:5 (vertical portrait)');
    expect(r.prompt).toContain('Additional direction: holding a cup of egg coffee.');
    // The outfit slot replaces clothing and the style keywords, never the signature look; hair stays default.
    expect(r.prompt).toContain('Keep her signature look (thin gold hoop earrings).');
    expect(r.prompt).toContain('Signature look, always present unless the direction explicitly removes it: thin gold hoop earrings.');
    expect(r.prompt).not.toContain('Personal style:');
    expect(r.prompt).toContain('Hair (default): long straight black hair');
    expect(r.warnings).toEqual([]);
  });

  it('always keeps the signature look, and drops default hair and style keywords under a hair slot', () => {
    const plain = composePrompt(base());
    expect(plain.prompt).toContain('Signature look, always present unless the direction explicitly removes it: thin gold hoop earrings.');
    expect(plain.prompt).toContain('Personal style: minimal, pastel.');
    const hair = composePrompt(base({ slots: { hair: slot('hair', 'sleek high ponytail') } }));
    expect(hair.prompt).toContain('Hair: sleek high ponytail (this replaces her default hair).');
    expect(hair.prompt).not.toContain('Hair (default)');
    expect(hair.prompt).toContain('thin gold hoop earrings');
    expect(hair.prompt).not.toContain('Personal style:');
  });

  it('uses the selection realism over the persona preset, and none removes the style block', () => {
    expect(composePrompt(base({ realism: 'iphone-candid' })).prompt).toContain('Candid smartphone photo');
    expect(composePrompt(base({ realism: 'none' })).prompt).not.toContain('PHOTO STYLE');
  });

  it('attaches slot images after identity with their own roles', () => {
    const r = composePrompt(base({
      slots: { outfit: slot('outfit', 'the dress', '/api/kol/media/library/o1'), scene: slot('scene', 'the cafe', '/api/kol/media/library/s1') },
    }));
    expect(r.refs.map((x) => x.role)).toEqual(['identity', 'sheet', 'identity', 'outfit', 'scene']);
    expect(r.prompt).toContain('Image 4 shows the OUTFIT only');
    expect(r.prompt).toContain('Image 5 shows the LOCATION only');
  });

  it('warns when there is no anchor yet', () => {
    const r = composePrompt(base({ refs: [] }));
    expect(r.refs).toEqual([]);
    expect(r.warnings.join(' ')).toContain('Chưa có ảnh gốc');
  });

  it('warns about Instagram feed aspects but not for 4:5 or 1:1', () => {
    expect(composePrompt(base({ params: { aspect: '9:16' } })).warnings.join(' ')).toContain('feed Instagram');
    expect(composePrompt(base({ params: { aspect: '3:4' } })).warnings.join(' ')).toContain('feed Instagram');
    expect(composePrompt(base({ params: { aspect: '1:1' } })).warnings).toEqual([]);
  });

  it('warns when the model does not support the aspect', () => {
    const r = composePrompt(base({ params: { aspect: '4:5' }, model: model({ aspects: ['1:1', '16:9'] }) }));
    expect(r.warnings.join(' ')).toContain('không hỗ trợ tỉ lệ 4:5');
  });

  it('reminds the owner about licensed (real) people', () => {
    const r = composePrompt(base({ persona: { name: 'Lan', appearance, realismPreset: 'pro-photo', identitySource: 'licensed' } }));
    expect(r.warnings.join(' ')).toContain('người thật');
  });

  it('uses a prompt override verbatim but still attaches the identity refs', () => {
    const r = composePrompt(base({ promptOverride: '  my own prompt  ' }));
    expect(r.prompt).toBe('my own prompt');
    expect(r.refs).toHaveLength(3);
    expect(r.warnings.join(' ')).toContain('prompt tự viết');
  });
});

describe('composePrompt — ref limits', () => {
  it('truncates to the model maximum, identity first, and warns', () => {
    const refs = [ref('anchor', { isPrimary: true }), ref('anchor'), ref('angle'), ref('angle')];
    const r = composePrompt(base({
      refs, model: model({ maxRefs: 3, label: 'Nano Banana' }),
      slots: { outfit: slot('outfit', 'dress', '/api/kol/media/library/o1') },
    }));
    expect(r.refs).toHaveLength(3);
    expect(r.refs.every((x) => x.role === 'identity')).toBe(true);
    expect(r.dropped).toBe(2);
    expect(r.warnings.join(' ')).toContain('chỉ nhận tối đa 3 ảnh');
  });

  it('caps identity images at the soft cap so slot images still fit', () => {
    const refs = Array.from({ length: 12 }, (_, i) => ref(i === 0 ? 'anchor' : 'angle', { isPrimary: i === 0 }));
    const r = composePrompt(base({ refs, template: { id: 't1', name: 'Mẫu', url: '/api/kol/media/template/t1', notes: '' } }));
    const identity = r.refs.filter((x) => x.role === 'identity' || x.role === 'sheet');
    expect(identity).toHaveLength(IDENTITY_SOFT_CAP);
    expect(r.refs[0].role).toBe('composition');
    expect(r.notes.join(' ')).toContain(`${IDENTITY_SOFT_CAP}/12 ảnh nhận diện`);
    expect(r.warnings.join(' ')).not.toContain('ảnh nhận diện');
  });

  it('keeps the owner\'s outfit, hair and location images inside a small limit (ChatGPT takes 8)', () => {
    const refs = Array.from({ length: 12 }, (_, i) => ref(i === 0 ? 'anchor' : 'angle', { isPrimary: i === 0 }));
    const slots = {
      outfit: slot('outfit', 'linen set', '/api/kol/media/library/o1'),
      hair: slot('hair', 'bun', '/api/kol/media/library/h1'),
      scene: slot('scene', 'beach', '/api/kol/media/library/s1'),
    };
    const r = composePrompt(base({ refs, slots, model: model({ maxRefs: 8, label: 'ChatGPT Images' }) }));
    expect(r.refs).toHaveLength(8);
    expect(r.refs.filter((x) => x.role === 'identity')).toHaveLength(IDENTITY_FLOOR);
    expect(r.refs.slice(-3).map((x) => x.role)).toEqual(['outfit', 'hair', 'scene']);
    expect(r.warnings.join(' ')).not.toContain('chỉ nhận tối đa');
    expect(r.notes.join(' ')).toContain('5/12 ảnh nhận diện');
    expect(r.prompt).toContain('Image 6 shows the OUTFIT only');

    // With the template too, the floor still holds and the lowest-priority slot image goes.
    const t = composePrompt(base({ mode: 'recreate', refs, slots, model: model({ maxRefs: 8 }), template: { id: 't1', name: 'Mẫu', url: '/api/kol/media/template/t1', notes: '' } }));
    expect(t.refs.map((x) => x.role)).toEqual(['composition', 'identity', 'identity', 'identity', 'identity', 'identity', 'outfit', 'hair']);
    expect(t.warnings.join(' ')).toContain('không gửi kèm được ảnh bối cảnh');
  });

  it('lowers the identity floor on a 5-image limit so two owner images still fit', () => {
    expect([3, 4, 5, 6, 7, 8, 14].map(identityFloor)).toEqual([3, 3, 3, 4, 5, 5, 5]);
    const refs = Array.from({ length: 12 }, (_, i) => ref(i === 0 ? 'anchor' : 'angle', { isPrimary: i === 0 }));
    const slots = { outfit: slot('outfit', 'linen set', '/api/kol/media/library/o1'), scene: slot('scene', 'beach', '/api/kol/media/library/s1') };
    const r = composePrompt(base({ refs, slots, model: model({ maxRefs: 5, label: 'ChatGPT Images' }) }));
    expect(r.refs.map((x) => x.role)).toEqual(['identity', 'identity', 'identity', 'outfit', 'scene']);
    // Without owner images the whole limit goes to identity.
    expect(composePrompt(base({ refs, model: model({ maxRefs: 5 }) })).refs).toHaveLength(5);
  });

  it('a pack that fits sends everything, with no note', () => {
    const r = composePrompt(base());
    expect(r.notes).toEqual([]);
    expect(r.dropped).toBe(0);
  });

  it('recreate keeps one slot for the template even when identity would fill the model', () => {
    const refs = [ref('anchor', { isPrimary: true }), ref('angle'), ref('angle')];
    const r = composePrompt(base({ mode: 'recreate', refs, model: model({ maxRefs: 3 }), template: { id: 't1', name: 'Quán cà phê', url: '/api/kol/media/template/t1', notes: 'golden hour' } }));
    expect(r.refs.map((x) => x.role)).toEqual(['composition', 'identity', 'identity']);
    expect(r.dropped).toBe(1);
  });
});

describe('composePrompt — modes', () => {
  const template = { id: 't1', name: 'Quán cà phê', url: '/api/kol/media/template/t1', notes: 'window light from the left' };

  it('recreate: Image 1 is the composition, never the identity', () => {
    const r = composePrompt(base({ mode: 'recreate', template }));
    expect(r.refs[0]).toMatchObject({ index: 1, role: 'composition', url: '/api/kol/media/template/t1' });
    expect(r.prompt).toContain('Recreate the photograph in Image 1 with Mia as the subject.');
    expect(r.prompt).toContain('Image 1 is the COMPOSITION reference');
    expect(r.prompt).toContain("NOT the person's face, body or identity");
    expect(r.prompt).toContain('Notes on this composition: window light from the left.');
    expect(r.prompt).toContain('Images 2 and 4 show Mia');
    expect(r.notes.join(' ')).toContain('không sao chép danh tính');
  });

  it('recreate without a template warns', () => {
    expect(composePrompt(base({ mode: 'recreate' })).warnings.join(' ')).toContain('cần chọn một ảnh mẫu');
  });

  it('compose with a template uses it for composition only', () => {
    const r = composePrompt(base({ template }));
    expect(r.refs[0].role).toBe('composition');
    expect(r.prompt).toContain('copy its framing, pose, camera angle, lighting, background and mood');
  });

  it('sheet: turnaround layout, grey background, no labels, no slot images, sheets left out when anchors exist', () => {
    const r = composePrompt(base({ mode: 'sheet', params: {}, slots: { outfit: slot('outfit', 'white tee', '/api/kol/media/library/o1') } }));
    expect(r.refs.map((x) => x.role)).toEqual(['identity', 'identity']);
    expect(r.prompt).toContain('character reference sheet (turnaround)');
    expect(r.prompt).toContain('front view, three-quarter left, profile left, back view, three-quarter right, profile right');
    expect(r.prompt).toContain('close-up of the face');
    expect(r.prompt).toContain('Neutral mid-grey seamless background');
    expect(r.prompt).toContain('No labels, no text');
    expect(r.prompt).toContain('Outfit in every panel: white tee.');
    expect(r.prompt).toContain('aspect ratio 16:9');
    expect(r.warnings).toEqual([]);
  });

  it('bootstrap: no refs, appearance only, front-facing neutral portrait for an anchor', () => {
    const r = composePrompt(base({ mode: 'bootstrap', refs: [], params: {} }));
    expect(r.refs).toEqual([]);
    expect(r.prompt).toContain('ultra-realistic portrait photograph of a new, original person');
    expect(r.prompt).toContain('A 24-year-old Vietnamese female.');
    expect(r.prompt).toContain('facing the camera straight on');
    expect(r.prompt).toContain('neutral light-grey studio background');
    expect(r.prompt).toContain('must not resemble any real celebrity');
    expect(r.prompt).not.toContain('IDENTITY LOCK');
    expect(r.warnings).toEqual([]);
  });

  it('bootstrap warns when the persona already has an anchor, or when appearance is empty', () => {
    expect(composePrompt(base({ mode: 'bootstrap' })).warnings.join(' ')).toContain('khuôn mặt KHÁC');
    const empty = { ...appearance, gender: '', ethnicity: '', face: '' };
    const r = composePrompt(base({ mode: 'bootstrap', refs: [], persona: { name: 'X', appearance: empty, realismPreset: 'none', identitySource: 'synthetic' } }));
    expect(r.warnings.join(' ')).toContain('Mô tả ngoại hình còn trống');
  });

  it('freeform: follows the owner direction with identity refs attached', () => {
    const r = composePrompt(base({ mode: 'freeform', params: { aspect: '1:1', extraPrompt: 'astronaut suit on the moon' } }));
    expect(r.prompt).toContain('following the direction below');
    expect(r.prompt).toContain('Additional direction: astronaut suit on the moon.');
    expect(r.refs).toHaveLength(3);
  });

  it('animate: motion prompt with the source frame, identity preserved, camera from the slot', () => {
    const r = composePrompt(base({
      mode: 'animate', model: model({ kind: 'video', maxRefs: 1, aspects: ['9:16', '16:9'] }),
      source: { id: 'a1', url: '/api/kol/media/asset/a1', kind: 'image', width: 1080, height: 1350 },
      slots: { camera: slot('camera', 'slow cinematic push-in toward the face') },
      params: { aspect: '9:16', durationSec: 6, audio: true },
    }));
    expect(r.refs).toEqual([{ index: 1, role: 'source', label: 'Ảnh nguồn', url: '/api/kol/media/asset/a1' }]);
    expect(r.prompt).toContain('Animate this photo of Mia');
    expect(r.prompt).toContain('subtle natural movement');
    expect(r.prompt).toContain('must stay exactly as in the start frame');
    expect(r.prompt).toContain('Camera: slow cinematic push-in toward the face.');
    expect(r.prompt).toContain('no music and no speech');
    expect(r.warnings.join(' ')).toContain('cắt hoặc mở rộng khung hình');
  });

  it('animate with a spoken line: talking motion, the exact line with lip-sync, no "no speech" contradiction', () => {
    const r = composePrompt(base({
      mode: 'animate', model: model({ kind: 'video', maxRefs: 1, aspects: ['9:16'] }),
      source: { id: 'a1', url: '/api/kol/media/asset/a1', kind: 'image', width: 1080, height: 1920 },
      params: { aspect: '9:16', durationSec: 8, audio: true, script: 'Hi, I\'m Mia — your "AI" bestie!' },
    }));
    expect(r.prompt).toContain('looks into the camera and talks naturally');
    expect(r.prompt).toContain(`says exactly this line, word for word`);
    expect(r.prompt).toContain(`"Hi, I'm Mia — your 'AI' bestie!"`);
    expect(r.prompt).toContain("young woman's voice, warm, friendly and upbeat");
    expect(r.prompt).not.toContain('no speech');
  });

  it('animate without a source warns', () => {
    const r = composePrompt(base({ mode: 'animate', model: model({ kind: 'video', maxRefs: 1, aspects: ['9:16'] }), params: { aspect: '9:16' } }));
    expect(r.warnings.join(' ')).toContain('Chưa chọn ảnh nguồn');
    expect(r.prompt).toContain('a photo of Mia');
  });

  it('talking: lip-sync direction, warns without a script', () => {
    const r = composePrompt(base({
      mode: 'talking', model: model({ kind: 'lipsync', maxRefs: 1 }),
      source: { id: 'a1', url: '/api/kol/media/asset/a1', kind: 'image', width: 1080, height: 1920 }, params: { aspect: '9:16' },
    }));
    expect(r.prompt).toContain('accurate lip-sync');
    expect(r.warnings.join(' ')).toContain('Chưa có lời thoại');
    const ok = composePrompt(base({
      mode: 'talking', model: model({ kind: 'lipsync', maxRefs: 1 }),
      source: { id: 'a1', url: '/api/kol/media/asset/a1', kind: 'image', width: 1080, height: 1920 }, params: { aspect: '9:16', script: 'Xin chào cả nhà!' },
    }));
    expect(ok.warnings).toEqual([]);
  });

  it('uses he/his for a male persona', () => {
    const r = composePrompt(base({ persona: { name: 'Minh', appearance: { ...appearance, gender: 'male' }, realismPreset: 'pro-photo', identitySource: 'synthetic' }, slots: { outfit: slot('outfit', 'a navy suit') } }));
    expect(r.prompt).toContain('REPLACE his clothing completely');
    expect(r.prompt).toContain('his face must match exactly');
  });
});
