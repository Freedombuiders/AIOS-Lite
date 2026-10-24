import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findBin, FFMPEG_HINT, MissingToolError, requireBin, resetBinCache, searchDirs } from './bin.js';
import { runCommand } from './edit/pipeline/tools.js';

const dirs: string[] = [];
const oldPath = process.env.PATH;
afterEach(() => { process.env.PATH = oldPath; resetBinCache(); dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })); });

describe('tool lookup', () => {
  it('searches Homebrew directories even when PATH does not list them', () => {
    process.env.PATH = '/nonexistent';
    expect(searchDirs()).toContain('/opt/homebrew/bin');
  });

  it('finds an executable on PATH and ignores plain files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-bin-')); dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'fake-tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'not-exec'), 'x', { mode: 0o644 });
    process.env.PATH = dir; resetBinCache();
    expect(findBin('fake-tool')).toBe(path.join(dir, 'fake-tool'));
    expect(findBin('not-exec')).toBeNull();
  });

  it('says how to install ffmpeg in Vietnamese when it is missing', () => {
    expect(FFMPEG_HINT).toContain('brew install ffmpeg');
    expect(FFMPEG_HINT).toContain('/opt/homebrew/bin');
    expect(() => requireBin('definitely-not-a-video-tool')).toThrow(MissingToolError);
  });

  it('turns a missing executable into the install hint instead of a raw ENOENT', async () => {
    await expect(runCommand('definitely-not-a-video-tool', [])).rejects.toBeInstanceOf(MissingToolError);
  });
});
