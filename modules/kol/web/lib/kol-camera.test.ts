import { describe, expect, it } from 'vitest';
import { BUILTIN_LIBRARY } from '../../server/library-seed';
import type { LibraryItemDto } from './kol';
import {
  CAMERA_AXES, CAMERA_INFO, cameraAxisOf, cameraPickOn, cameraSections, cameraWarnings, isVideoOnlyCamera, normalizeCameraPicks,
  selectionCameraIds, toggleCameraPick,
} from './kol-camera';

const items: LibraryItemDto[] = BUILTIN_LIBRARY.filter((i) => i.kind === 'camera').map((i, sort) => ({
  id: i.id, personaId: null, kind: 'camera', group: i.group, name: i.name, prompt: i.prompt, imageUrl: null, previewUrl: null, previewIsPersona: false, gender: 'all', tags: i.tags, builtin: true, sort,
}));
const byId = new Map(items.map((i) => [i.id, i]));
const own = (id: string, group: string, tags: string[] = []): LibraryItemDto => ({
  id, personaId: null, kind: 'camera', group, name: id, prompt: id, imageUrl: null, previewUrl: null, previewIsPersona: false, gender: 'all', tags, builtin: false, sort: 999,
});
const c = (slug: string) => `b-camera-${slug}`;

describe('camera axes', () => {
  it('describes every builtin camera item and nothing else', () => {
    expect(Object.keys(CAMERA_INFO).sort()).toEqual(items.map((i) => i.id).sort());
  });

  it('places every builtin on a named axis and the owner’s other groups on "Của tôi"', () => {
    for (const it of items) expect(cameraAxisOf(it)).not.toBe('custom');
    expect(cameraAxisOf(own('x', 'Góc máy'))).toBe('angle');
    expect(cameraAxisOf(own('x', 'Của tôi'))).toBe('custom');
    expect(CAMERA_AXES.map((a) => a.id)).toEqual(['device', 'shot', 'angle', 'move', 'custom']);
  });

  it('hides movement from photos and lists it first for video', () => {
    const extra = [...items, own('mine', 'Của tôi'), own('mine-video', 'Của tôi', ['video'])];
    const image = cameraSections(extra, 'image');
    expect(image.map((s) => s.axis.id)).toEqual(['device', 'shot', 'angle', 'custom']);
    expect(image.flatMap((s) => s.items).some(isVideoOnlyCamera)).toBe(false);
    expect(image.find((s) => s.axis.id === 'custom')!.items.map((i) => i.id)).toEqual(['mine']);
    expect(cameraSections(extra, 'video').map((s) => s.axis.id)).toEqual(['move', 'device', 'shot', 'angle', 'custom']);
  });
});

describe('camera picks', () => {
  it('keeps one pick per axis in prompt order, the later pick winning', () => {
    expect(normalizeCameraPicks([c('low-angle'), c('static'), 'gone', c('shot-cu'), c('50mm'), c('85mm-portrait')], byId))
      .toEqual([c('85mm-portrait'), c('shot-cu'), c('low-angle'), c('static')]);
  });

  it('toggles: a second pick on the same axis replaces the first, clicking a pick removes it', () => {
    let ids = toggleCameraPick([], byId.get(c('shot-full'))!, byId);
    ids = toggleCameraPick(ids, byId.get(c('50mm'))!, byId);
    expect(ids).toEqual([c('50mm'), c('shot-full')]);
    ids = toggleCameraPick(ids, byId.get(c('shot-cu'))!, byId);
    expect(ids).toEqual([c('50mm'), c('shot-cu')]);
    expect(cameraPickOn(ids, 'shot', byId)?.id).toBe(c('shot-cu'));
    expect(cameraPickOn(ids, 'angle', byId)).toBeNull();
    expect(toggleCameraPick(ids, byId.get(c('50mm'))!, byId)).toEqual([c('shot-cu')]);
  });

  it('reads cameraIds, else the single legacy cameraId', () => {
    expect(selectionCameraIds({})).toEqual([]);
    expect(selectionCameraIds({ cameraId: 'a' })).toEqual(['a']);
    expect(selectionCameraIds({ cameraId: 'a', cameraIds: ['b', 'c'] })).toEqual(['b', 'c']);
  });
});

describe('cameraWarnings', () => {
  it('is quiet for sound combinations', () => {
    expect(cameraWarnings([])).toEqual([]);
    expect(cameraWarnings([c('85mm-portrait'), c('shot-mcu'), c('eye-level')])).toEqual([]);
    expect(cameraWarnings([c('iphone-front-selfie'), c('shot-mcu'), c('high-angle'), c('vlog-walk')])).toEqual([]);
    expect(cameraWarnings([c('mirror-selfie'), c('shot-full'), c('low-angle')])).toEqual([]);
  });

  it('flags combinations that fight each other', () => {
    const one = (ids: string[]) => cameraWarnings(ids.map(c));
    expect(one(['24mm-wide', 'shot-cu'])[0]).toContain('50–135mm');
    expect(one(['macro-face', 'shot-full'])[0]).toContain('Macro');
    expect(one(['macro-face', 'shot-ecu'])).toEqual([]);
    expect(one(['iphone-front-selfie', 'shot-full'])[0]).toContain('Selfie gương');
    expect(one(['iphone-front-selfie', 'over-shoulder'])[0]).toContain('tầm với');
    expect(one(['mirror-selfie', 'overhead'])[0]).toContain('Selfie gương');
    expect(one(['135mm-tele', 'vlog-walk'])[0]).toContain('Vlog');
    expect(one(['tilt-up', 'shot-cu'])[0]).toContain('Lia dọc');
  });
});
