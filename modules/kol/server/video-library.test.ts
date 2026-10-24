import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./personas.js', () => ({
  getPersona: (id: string) =>
    id === 'c2d66cb3-05f3-405d-be64-6da1fb8dbaa2' ? { name: 'Tony Trieu', handle: 'tonytrieu' }
      : id === 'genie-id' ? { name: 'Genie', handle: 'genie.aibestie' }
        : null,
}));

const { _setVideosDirForTests } = await import('./config.js');
const { getKolVideoLibrary, listKolVideoLibraries, resolveKolFolder, resolveVariantFile, slugify } = await import('./video-library.js');

let base: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'kol-videos-'));
  _setVideosDirForTests(base);
  const camp = join(base, 'personas', 'tony-trieu', 'amazon-custom-city');
  mkdirSync(join(camp, 'variants'), { recursive: true });
  writeFileSync(join(camp, 'variants', 'variant-a-15s.mp4'), Buffer.alloc(1234));
  writeFileSync(join(camp, 'metadata.json'), JSON.stringify({
    description: 'TVC 15 giây',
    event_date: '2026-11-05',
    event_location: 'Hà Nội',
    target_audience: ['sellers'],
    video_variants: {
      a: { name: 'Direct', file: 'variant-a-15s.mp4', duration: 14.8, status: 'completed', aspect_ratio: '16:9' },
      b: { name: 'Emotion', status: 'pending' },
    },
  }));
  writeFileSync(join(base, 'personas', 'tony-trieu', 'campaigns-index.json'), JSON.stringify({
    campaigns: [{ id: 'amazon-custom-city', name: 'Amazon Custom City Event' }],
  }));
});

afterAll(() => {
  _setVideosDirForTests(null);
  rmSync(base, { recursive: true, force: true });
});

describe('kol video library', () => {
  it('slugifies Vietnamese names', () => {
    expect(slugify('Tony Trieu')).toBe('tony-trieu');
    expect(slugify('Đào Thị Ngọc')).toBe('dao-thi-ngoc');
  });

  it('maps a persona id to its slug folder', () => {
    expect(resolveKolFolder('c2d66cb3-05f3-405d-be64-6da1fb8dbaa2')).toBe('tony-trieu');
    expect(resolveKolFolder('tony-trieu')).toBe('tony-trieu');
    expect(resolveKolFolder('genie-id')).toBeNull();
    expect(resolveKolFolder('unknown')).toBeNull();
  });

  it('rejects path traversal', () => {
    expect(resolveKolFolder('..')).toBeNull();
    expect(resolveKolFolder('../etc')).toBeNull();
    expect(getKolVideoLibrary('tony-trieu', '..')).toBeNull();
    expect(resolveVariantFile('tony-trieu', 'amazon-custom-city', '../x')).toBeNull();
  });

  it('lists rendered variants, normalizes status and reports pending ones', () => {
    const lib = getKolVideoLibrary('c2d66cb3-05f3-405d-be64-6da1fb8dbaa2', 'amazon-custom-city')!;
    expect(lib.title).toBe('Amazon Custom City Event');
    expect(lib.totalVariants).toBe(1);
    expect(lib.pendingVariants).toEqual(['b']);
    expect(lib.variants[0]).toMatchObject({ variant: 'a', status: 'ready', size: 1234, aspectRatio: '16:9' });
    expect(lib.variants[0].url).toBe('/api/kol/videos/c2d66cb3-05f3-405d-be64-6da1fb8dbaa2/amazon-custom-city/a');
  });

  it('returns an empty list for a KOL without videos', () => {
    expect(listKolVideoLibraries('genie-id')).toEqual([]);
    expect(listKolVideoLibraries('tony-trieu')).toHaveLength(1);
  });
});
