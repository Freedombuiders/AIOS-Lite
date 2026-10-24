import { afterAll, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  process.env.VIDEO_EDIT_FFMPEG = '/nonexistent/ffmpeg-for-tests';
  process.env.VIDEO_EDIT_FFPROBE = '/nonexistent/ffprobe-for-tests';
  return { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'kol-files-')) };
});
vi.mock('./config.js', async (orig) => ({ ...(await orig<typeof import('./config.js')>()), STORE_DIR: store.dir }));

import fs from 'fs';
import path from 'path';

import { Hono } from 'hono';

import { KolError } from './core.js';
import { imageDims, makeThumbnail, MAX_IMAGE_UPLOAD, probeMedia, readUploadToTemp, sniffImage, sniffMedia, storeImage } from './files.js';

afterAll(() => fs.rmSync(store.dir, { recursive: true, force: true }));

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP_HEAD = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(8)]);

function write(name: string, bytes: Buffer): string {
  const f = path.join(fs.mkdtempSync(path.join(store.dir, 'f-')), name);
  fs.writeFileSync(f, bytes);
  return f;
}

describe('sniffing', () => {
  it('accepts only JPEG, PNG and WebP as images, by magic bytes', () => {
    expect(sniffImage(PNG)).toBe('png');
    expect(sniffImage(JPG_HEAD)).toBe('jpg');
    expect(sniffImage(WEBP_HEAD)).toBe('webp');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBeNull();
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(sniffImage(MP4_HEAD)).toBeNull();
  });

  it('classifies provider output', () => {
    expect(sniffMedia(PNG)).toEqual({ kind: 'image', ext: 'png', mime: 'image/png' });
    expect(sniffMedia(MP4_HEAD)).toEqual({ kind: 'video', ext: 'mp4', mime: 'video/mp4' });
    expect(sniffMedia(Buffer.from('ID3\u0004\u0000'))).toEqual({ kind: 'audio', ext: 'mp3', mime: 'audio/mpeg' });
    expect(sniffMedia(Buffer.from('{"error":"nope"}'))).toBeNull();
  });
});

describe('storeImage', () => {
  it('stores a real image with its sniffed extension, whatever the name says', async () => {
    const dest = path.join(store.dir, 'out');
    const s = await storeImage(write('photo.jpg', PNG), dest, 'abc');
    expect(s).toMatchObject({ ext: 'png', mime: 'image/png', width: 1, height: 1, bytes: PNG.length });
    expect(s.abs).toBe(path.join(dest, 'abc.png'));
  });

  it('rejects non-images with 415 and unreadable images with 422', async () => {
    await expect(storeImage(write('a.png', Buffer.from('not an image at all')), store.dir, 'x')).rejects.toMatchObject({ status: 415 });
    await expect(storeImage(write('b.jpg', JPG_HEAD), store.dir, 'y')).rejects.toMatchObject({ status: 422 });
  });

  it('reads dimensions, null when unreadable', () => {
    expect(imageDims(write('a.png', PNG))).toEqual({ width: 1, height: 1 });
    expect(imageDims(write('b.bin', Buffer.from('xx')))).toEqual({ width: null, height: null });
  });

  it('reports missing ffmpeg/ffprobe as no thumbnail / no probe instead of throwing', async () => {
    const src = write('a.png', PNG);
    expect(await makeThumbnail(src, `${src}.thumb.jpg`, 'image')).toBe(false);
    expect(await probeMedia(src)).toBeNull();
  });
});

describe('readUploadToTemp', () => {
  const app = new Hono();
  app.post('/up', async (c) => {
    try {
      const r = await readUploadToTemp(c, 32);
      const bytes = fs.readFileSync(r.temp);
      fs.rmSync(r.temp, { force: true });
      return c.json({ bytes: bytes.length, fileName: r.fileName });
    } catch (err) {
      return c.json({ error: (err as KolError).message }, (err as KolError).status as 400);
    }
  });

  it('streams the body with a cap and decodes x-file-name safely', async () => {
    const ok = await app.request('/up', { method: 'POST', headers: { 'x-file-name': encodeURIComponent('../../ảnh đẹp.png') }, body: new Uint8Array(10) });
    expect(await ok.json()).toEqual({ bytes: 10, fileName: 'ảnh đẹp.png' });
    const big = await app.request('/up', { method: 'POST', body: new Uint8Array(64) });
    expect(big.status).toBe(413);
    const empty = await app.request('/up', { method: 'POST', body: new Uint8Array(0) });
    expect(empty.status).toBe(400);
    expect(MAX_IMAGE_UPLOAD).toBe(25 * 1024 * 1024);
  });
});
