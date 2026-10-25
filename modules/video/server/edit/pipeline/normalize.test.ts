import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ffmpegRuns: string[][] = [];
vi.mock('./tools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tools.js')>()),
  // Records the arguments and writes the output file (last argument), as ffmpeg would.
  runFfmpeg: vi.fn(async (args: string[]) => {
    ffmpegRuns.push(args);
    fs.writeFileSync(args[args.length - 1], 'x');
    return { code: 0, stdout: '', stderr: '' };
  }),
}));

import { hasTonemapFilters, isHdrTransfer, MASTER_SCALE, masterVideoFilter, normalizeSource, TONEMAP_CHAIN } from './normalize.js';

describe('normalize: HDR → SDR', () => {
  it('tone-maps the master only for HLG or PQ sources when ffmpeg has zimg', () => {
    for (const hdr of ['arib-std-b67', 'smpte2084']) {
      expect(isHdrTransfer(hdr)).toBe(true);
      expect(masterVideoFilter(hdr, true)).toBe(`fps=30,${TONEMAP_CHAIN},${MASTER_SCALE},format=yuv420p`);
      // without zimg there is no zscale/tonemap to run: the old chain, and the runner warns
      expect(masterVideoFilter(hdr, false)).toBe(`fps=30,${MASTER_SCALE},format=yuv420p`);
    }
    for (const sdr of ['bt709', 'unknown', '', null, undefined]) {
      expect(isHdrTransfer(sdr)).toBe(false);
      expect(masterVideoFilter(sdr, true)).not.toContain('tonemap');
    }
    expect(TONEMAP_CHAIN).toContain('tonemap=tonemap=hable');
    expect(TONEMAP_CHAIN).toContain('zscale=t=bt709:m=bt709:r=tv');
  });

  it('reads zscale and tonemap from `ffmpeg -filters`', () => {
    const withZimg = [
      ' ... tonemap           V->V       Conversion to/from different dynamic ranges.',
      ' ... zscale            V->V       Apply resizing, colorspace and bit depth conversion.',
    ].join('\n');
    expect(hasTonemapFilters(withZimg)).toBe(true);
    expect(hasTonemapFilters(' ... tonemap           V->V       Conversion to/from different dynamic ranges.\n')).toBe(false);
    expect(hasTonemapFilters(' ... tonemap_opencl    V->V       Perform HDR to SDR conversion with tonemapping.\n ... zscale  V->V x\n')).toBe(false);
  });
});

describe('normalizeSource', () => {
  let dir: string;
  beforeEach(() => { ffmpegRuns.length = 0; dir = fs.mkdtempSync(path.join(os.tmpdir(), 'normalize-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = (transfer: string | null, zimg: boolean) => normalizeSource({
    raw: path.join(dir, 'raw.mov'), outDir: path.join(dir, 'source'), durationSec: 10, hasAudio: true,
    colorTransfer: async () => transfer, canTonemap: async () => zimg,
  });
  const masterArgs = () => ffmpegRuns[0];
  const vf = (args: string[]) => args[args.indexOf('-vf') + 1];

  it('an iPhone HLG clip gets the tonemap chain and Rec.709 tags on the master', async () => {
    const out = await run('arib-std-b67', true);
    expect(out.hdr).toBe('tonemapped');
    expect(vf(masterArgs())).toContain(TONEMAP_CHAIN);
    expect(masterArgs()).toEqual(expect.arrayContaining(['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709']));
    // the proxy and the audio come from the SDR master
    expect(ffmpegRuns).toHaveLength(3);
    expect(ffmpegRuns[1]).toContain(out.master);
  });

  it('HDR without zimg is left as it is and reported; SDR is untouched and unmarked', async () => {
    expect((await run('smpte2084', false)).hdr).toBe('untouched');
    expect(vf(masterArgs())).not.toContain('tonemap');
    ffmpegRuns.length = 0;
    const sdr = await run('bt709', true);
    expect(sdr.hdr).toBeUndefined();
    expect(vf(masterArgs())).toBe(`fps=30,${MASTER_SCALE},format=yuv420p`);
    expect(masterArgs()).not.toContain('-color_trc');
  });
});
