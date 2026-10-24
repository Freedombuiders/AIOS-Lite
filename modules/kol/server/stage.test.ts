import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  files: new Map<string, { abs: string; mime: string; kind: 'image' | 'video' | 'audio'; width: number | null; height: number | null; durationSec: number | null }>(),
}));

vi.mock('./assets.js', () => ({
  getAssetFile: (id: string) => h.files.get(id) ?? null,
  listAssetsByIds: () => [],
  getAsset: () => null,
}));

import {
  IG_MAX_RATIO,
  IG_MIN_RATIO,
  _setStageRoot,
  _setStageTools,
  cleanupStage,
  planFilter,
  planInstagramImage,
  stageDir,
  stageMedia,
  type StageTools,
} from './stage.js';

describe('planInstagramImage (crop math)', () => {
  it('keeps an image already in range, only downscaling to 1440', () => {
    expect(planInstagramImage(1080, 1350)).toEqual({ crop: null, outWidth: 1080, outHeight: 1350 });
    expect(planInstagramImage(2880, 3600)).toEqual({ crop: null, outWidth: 1440, outHeight: 1800 });
  });

  it('center-crops a tall 9:16 image to 4:5', () => {
    const p = planInstagramImage(1080, 1920);
    expect(p.crop).toEqual({ x: 0, y: 285, w: 1080, h: 1350 });
    expect(p.outWidth / p.outHeight).toBeGreaterThanOrEqual(IG_MIN_RATIO);
  });

  it('center-crops a very wide panorama to 1.91:1', () => {
    const p = planInstagramImage(4000, 1000);
    expect(p.crop).toEqual({ x: 1045, y: 0, w: 1910, h: 1000 });
    expect(p.outWidth).toBe(1440);
    expect(p.outWidth / p.outHeight).toBeLessThanOrEqual(IG_MAX_RATIO);
  });

  it('the output ratio stays within 0.8–1.91 after rounding, for many sizes', () => {
    for (const [w, h] of [[1001, 1999], [3333, 1745], [1441, 1801], [999, 523], [5000, 2617], [640, 801], [7, 13]]) {
      const p = planInstagramImage(w, h);
      const r = p.outWidth / p.outHeight;
      expect(r).toBeGreaterThanOrEqual(IG_MIN_RATIO);
      expect(r).toBeLessThanOrEqual(IG_MAX_RATIO);
      expect(p.outWidth).toBeLessThanOrEqual(1440);
      if (p.crop) {
        expect(p.crop.x + p.crop.w).toBeLessThanOrEqual(w);
        expect(p.crop.y + p.crop.h).toBeLessThanOrEqual(h);
      }
    }
  });

  it('ffmpeg filter', () => {
    expect(planFilter(planInstagramImage(1080, 1920))).toBe('crop=1080:1350:0:285,scale=1080:1350');
    expect(planFilter(planInstagramImage(1080, 1080))).toBe('scale=1080:1080');
  });
});

describe('stageMedia', () => {
  let root: string;
  let src: string;
  const ffmpeg = vi.fn<StageTools['ffmpeg']>();
  const probe = vi.fn<StageTools['probe']>();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kol-stage-'));
    src = fs.mkdtempSync(path.join(os.tmpdir(), 'kol-src-'));
    _setStageRoot(root);
    ffmpeg.mockReset();
    probe.mockReset();
    // The fake ffmpeg writes the output file (last argument).
    ffmpeg.mockImplementation(async (args) => { fs.writeFileSync(args[args.length - 1], 'converted'); });
    probe.mockResolvedValue({ codec: 'h264', width: 1080, height: 1920, durationSec: 12 });
    _setStageTools({ ffmpeg, probe });
    h.files.clear();
  });

  afterEach(() => {
    _setStageRoot(null);
    _setStageTools(null);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  });

  function file(id: string, name: string, meta: { mime: string; kind: 'image' | 'video' | 'audio'; width?: number | null; height?: number | null; durationSec?: number | null }) {
    const abs = path.join(src, name);
    fs.writeFileSync(abs, 'data');
    h.files.set(id, { abs, mime: meta.mime, kind: meta.kind, width: meta.width ?? null, height: meta.height ?? null, durationSec: meta.durationSec ?? null });
  }

  it('Instagram: converts to JPEG with the crop plan, in a 0700 folder per target', async () => {
    file('a1', 'a.png', { mime: 'image/png', kind: 'image', width: 1080, height: 1920 });
    const out = await stageMedia('t1', 'instagram', ['a1']);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'image', mime: 'image/jpeg', width: 1080, height: 1350 });
    expect(out[0].path).toBe(path.join(root, 't1', '01.jpg'));
    expect(fs.existsSync(out[0].path)).toBe(true);
    expect(ffmpeg.mock.calls[0][0]).toEqual(['-i', h.files.get('a1')!.abs, '-vf', 'crop=1080:1350:0:285,scale=1080:1350', '-frames:v', '1', '-q:v', '2', out[0].path]);
    expect(fs.statSync(path.join(root, 't1')).mode & 0o777).toBe(0o700);
  });

  it('Instagram: a JPEG that already fits is copied as is', async () => {
    file('a1', 'a.jpg', { mime: 'image/jpeg', kind: 'image', width: 1080, height: 1350 });
    const out = await stageMedia('t1', 'instagram', ['a1']);
    expect(ffmpeg).not.toHaveBeenCalled();
    expect(fs.readFileSync(out[0].path, 'utf8')).toBe('data');
  });

  it('Instagram: unknown size is probed', async () => {
    file('a1', 'a.webp', { mime: 'image/webp', kind: 'image' });
    probe.mockResolvedValueOnce({ codec: 'webp', width: 2000, height: 1000, durationSec: null });
    const out = await stageMedia('t1', 'instagram', ['a1']);
    expect(out[0].width).toBe(1440);
  });

  it('Facebook keeps PNG/JPEG and converts other images', async () => {
    file('a1', 'a.png', { mime: 'image/png', kind: 'image', width: 100, height: 100 });
    file('a2', 'b.webp', { mime: 'image/webp', kind: 'image', width: 100, height: 100 });
    const out = await stageMedia('t2', 'facebook', ['a1', 'a2']);
    expect(out.map((m) => path.basename(m.path))).toEqual(['01.png', '02.jpg']);
    expect(ffmpeg).toHaveBeenCalledTimes(1);
  });

  it('videos: MP4/H.264 passes through, anything else is transcoded', async () => {
    file('v1', 'v.mp4', { mime: 'video/mp4', kind: 'video', width: 1080, height: 1920, durationSec: 12 });
    let out = await stageMedia('t3', 'tiktok', ['v1']);
    expect(ffmpeg).not.toHaveBeenCalled();
    expect(out[0]).toMatchObject({ kind: 'video', mime: 'video/mp4', durationSec: 12 });

    probe.mockResolvedValueOnce({ codec: 'hevc', width: 1080, height: 1920, durationSec: 12 });
    out = await stageMedia('t3', 'tiktok', ['v1']);
    expect(ffmpeg).toHaveBeenCalledTimes(1);
    expect(ffmpeg.mock.calls[0][0]).toContain('libx264');

    file('v2', 'v.mov', { mime: 'video/quicktime', kind: 'video' });
    out = await stageMedia('t4', 'youtube', ['v2']);
    expect(ffmpeg).toHaveBeenCalledTimes(2);
    expect(out[0].path.endsWith('.mp4')).toBe(true);
    expect(out[0].height).toBe(1920); // from the probe
  });

  it('missing asset → KolError 400 and nothing left behind', async () => {
    await expect(stageMedia('t5', 'instagram', ['nope'])).rejects.toMatchObject({ status: 400 });
    expect(fs.existsSync(path.join(root, 't5'))).toBe(false);
  });

  it('ffmpeg failure → KolError 500 with a Vietnamese reason', async () => {
    file('a1', 'a.png', { mime: 'image/png', kind: 'image', width: 1080, height: 1920 });
    ffmpeg.mockRejectedValueOnce(new Error('ffmpeg lỗi (1): bad input'));
    await expect(stageMedia('t6', 'instagram', ['a1'])).rejects.toMatchObject({ status: 500, message: expect.stringContaining('Không chuẩn bị được tệp') });
  });

  it('cleanupStage removes the folder; ids cannot escape the root', async () => {
    file('a1', 'a.jpg', { mime: 'image/jpeg', kind: 'image', width: 1080, height: 1350 });
    await stageMedia('t7', 'facebook', ['a1']);
    cleanupStage('t7');
    expect(fs.existsSync(path.join(root, 't7'))).toBe(false);
    expect(() => stageDir('../etc')).toThrow();
    cleanupStage('../..'); // no-op
    expect(fs.existsSync(root)).toBe(true);
  });
});
