import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeDoctor, type DoctorDeps } from './doctor.js';
import { hyperframesVersion } from './pipeline/tools.js';

const FILTERS_BASE = [
  ' T.. ass               V->V       Render ASS subtitles onto input video using the libass library.',
  ' ... silencedetect     A->A       Detect silence.',
  ' ... sidechaincompress AA->A      Sidechain compressor.',
  ' ... loudnorm          A->A       EBU R128 loudness normalization',
];
const ZIMG = [
  ' ... tonemap           V->V       Conversion to/from different dynamic ranges.',
  ' .S. zscale            V->V       Apply resizing, colorspace and bit depth conversion.',
];

/** A machine with ffmpeg (with or without zimg) and nothing else on PATH. */
function machine(opts: { zimg?: boolean; hyperframes?: string } = {}): DoctorDeps['run'] {
  return async (cmd, args) => {
    const tool = path.basename(cmd);
    if (tool === 'ffmpeg' && args[0] === '-version') return 'ffmpeg version 7.1.1 Copyright (c) 2000-2025';
    if (tool === 'ffprobe') return 'ffprobe version 7.1.1 Copyright (c) 2007-2025';
    if (tool === 'ffmpeg' && args.includes('-filters')) return [...FILTERS_BASE, ...(opts.zimg ? ZIMG : [])].join('\n');
    if (tool === 'ffmpeg' && args.includes('-encoders')) return ' V....D libx264   libx264 H.264';
    if (tool === 'hyperframes' && opts.hyperframes) return `${opts.hyperframes}\n`;
    throw new Error(`${tool}: not found`);
  };
}

const deps = (over: Partial<DoctorDeps> = {}): Partial<DoctorDeps> => ({
  run: machine({ zimg: true }), pexelsKey: () => 'key', cachedHyperframes: () => [hyperframesVersion()], npx: () => '/opt/homebrew/bin/npx', ...over,
});
const check = async (id: string, over: Partial<DoctorDeps> = {}) => {
  const result = await computeDoctor(os.tmpdir(), deps(over));
  return { result, check: result.checks.find((c) => c.id === id)! };
};

describe('doctor: Dựng nhanh checks', () => {
  it('ffmpeg with zimg can turn iPhone HDR into SDR; without it, a warning with the fix, not a required failure', async () => {
    const yes = await check('ffmpeg-zimg');
    expect(yes.check).toMatchObject({ ok: true, required: false, detail: 'có zscale và tonemap' });
    expect(yes.check.fix).toBeUndefined();

    const no = await check('ffmpeg-zimg', { run: machine({ zimg: false }) });
    expect(no.check).toMatchObject({ ok: false, required: false });
    expect(no.check.detail).toContain('thiếu zimg');
    expect(no.check.fix).toContain('zimg');
    // The other ffmpeg checks do not depend on zimg.
    expect(no.result.checks.find((c) => c.id === 'ffmpeg-libass')!.ok).toBe(true);
    expect(no.result.requiredOk).toBe(yes.result.requiredOk);
  });

  it('a missing Pexels key is a light warning: Dựng nhanh still works on the owner footage and library', async () => {
    const yes = await check('pexels');
    expect(yes.check).toMatchObject({ ok: true, required: false, detail: 'đã có API key' });

    const no = await check('pexels', { pexelsKey: () => null });
    expect(no.check).toMatchObject({ ok: false, required: false });
    expect(no.check.detail).toContain('tư liệu');
    expect(no.check.fix).toContain('Integrations › Pexels');
    expect(no.result.requiredOk).toBe(yes.result.requiredOk);
    expect(no.result.ok).toBe(yes.result.ok - 1);
  });

  it('HyperFrames is ready when the version the renderer pins is cached or installed', async () => {
    const pin = hyperframesVersion();
    expect((await check('hyperframes')).check).toMatchObject({ ok: true, required: false, detail: `phiên bản ${pin}` });
    expect((await check('hyperframes', { cachedHyperframes: () => [], run: machine({ zimg: true, hyperframes: pin }) })).check.ok).toBe(true);

    const other = (await check('hyperframes', { cachedHyperframes: () => ['0.1.0'] })).check;
    expect(other).toMatchObject({ ok: false, required: false });
    expect(other.detail).toContain(`chưa tải bản ${pin} (máy có bản 0.1.0)`);
    expect(other.fix).toBe(`Tải sẵn: npx -y hyperframes@${pin} --version`);

    const noNode = (await check('hyperframes', { npx: () => null })).check;
    expect(noNode).toMatchObject({ ok: false });
    expect(noNode.detail).toContain('npx');
    expect(noNode.fix).toContain('Node.js');
  });
});
