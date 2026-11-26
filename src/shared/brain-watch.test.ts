import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppEvent } from '../core/events.js';
import { createBrainService } from './brain.js';
import { createBrainWatch, type BrainWatch } from './brain-watch.js';
import { createNotes } from './notes.js';
import type { BrainChanged } from './notes.js';
import { memDb, testBus, testLog, tmpDir, writeFile } from './test-kit.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// generous: the watcher races the whole suite for CPU; a pass usually takes well under a second
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('hết giờ chờ');
    await sleep(20);
  }
}

let root: string;
let configFile: string;
let brain: ReturnType<typeof createBrainService>;
let bus: ReturnType<typeof testBus>;
let events: BrainChanged[];
let watcher: BrainWatch;
let notes: ReturnType<typeof createNotes>;

beforeEach(async () => {
  root = tmpDir('aios-watch-');
  configFile = path.join(root, 'config', 'brain.yaml');
  writeFile(configFile, 'folders:\n  - {id: kho, name: Kho, path: ./kho}\n');
  writeFile(path.join(root, 'kho', 'c.md'), '# C\nsẽ bị xoá\n');
  writeFile(path.join(root, 'kho', 'thu-muc', 'd.md'), '# D\n');
  brain = createBrainService({ db: memDb(), configFile, rootDir: root, log: testLog });
  await brain.reindex();
  bus = testBus();
  events = [];
  bus.on('custom', (e: Extract<AppEvent, { type: 'custom' }>) => {
    if (e.name === 'brain:changed') events.push(e.payload as BrainChanged);
  });
  notes = createNotes({ brain, bus, log: testLog, canRead: () => true, canWrite: () => true });
  watcher = createBrainWatch({ brain, bus, log: testLog, configFile, isOwnWrite: notes.isOwnWrite, debounceMs: 150, usePolling: process.env.AIOS_WATCH_NATIVE !== "1" });
  await watcher.start();
});

afterEach(async () => {
  await watcher.stop();
});

describe('brain watch', { timeout: 30_000 }, () => {
  it('turns a burst of edits into one reindex and one event; search sees it within 2 s', async () => {
    const t0 = Date.now();
    const kho = path.join(root, 'kho');
    fs.writeFileSync(path.join(kho, 'a.md'), '# A\nbản nháp\n');
    fs.writeFileSync(path.join(kho, 'a.md'), '# A\nchè sen Tây Hồ mới sửa trong Obsidian\n');
    fs.writeFileSync(path.join(kho, 'b.md'), '# B\nghi chú mới\n');
    fs.unlinkSync(path.join(kho, 'c.md'));
    fs.writeFileSync(path.join(kho, 'anh.png'), 'không phải markdown');
    await until(() => events.length > 0);
    await sleep(400); // nothing else arrives
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ folderId: 'kho', paths: ['a.md', 'b.md', 'c.md'] });
    expect(brain.search('che sen tay ho').map((h) => h.path)).toEqual(['a.md']);
    expect(brain.search('sẽ bị xoá')).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('skips writes made by the notes service (it already indexed and announced them), not later edits', async () => {
    const n = notes.owner().write({ folderId: 'kho', relPath: 'moi.md' }, '# Mới\nmáy ghi\n', { message: 'x' });
    expect(events).toEqual([{ folderId: 'kho', paths: ['moi.md'], by: 'owner' }]);
    await sleep(700);
    expect(events).toHaveLength(1);
    fs.writeFileSync(path.join(root, 'kho', 'moi.md'), '# Mới\nchủ sửa tay\n');
    await until(() => events.length > 1);
    expect(events[1]).toEqual({ folderId: 'kho', paths: ['moi.md'] });
    expect(brain.search('chu sua tay').map((h) => h.path)).toEqual(['moi.md']);
    expect(n.relPath).toBe('moi.md');
  });

  it('rescans the folder when a directory goes away', async () => {
    expect(brain.search('D').some((h) => h.path === 'thu-muc/d.md')).toBe(true);
    fs.rmSync(path.join(root, 'kho', 'thu-muc'), { recursive: true });
    await until(() => events.length > 0);
    expect(brain.search('D').some((h) => h.path === 'thu-muc/d.md')).toBe(false);
  });

  it('ignores .obsidian, .git and temp files', async () => {
    writeFile(path.join(root, 'kho', '.obsidian', 'workspace.md'), 'x');
    writeFile(path.join(root, 'kho', '.git', 'x.md'), 'x');
    fs.writeFileSync(path.join(root, 'kho', '.a.md.1.ab.aios-tmp'), 'x');
    await sleep(600);
    expect(events).toEqual([]);
  });

  it('rebuilds the watchers when brain.yaml changes', async () => {
    writeFile(path.join(root, 'kho2', 'x.md'), '# X\ncũ\n');
    expect(watcher.watching()).toEqual(['kho']);
    fs.writeFileSync(configFile, 'folders:\n  - {id: kho2, name: Kho 2, path: ./kho2}\n');
    await until(() => watcher.watching().join() === 'kho2');
    await until(() => brain.search('cu', { folders: ['kho2'] }).length === 1);
    fs.writeFileSync(path.join(root, 'kho2', 'x.md'), '# X\nmới tinh\n');
    await until(() => events.some((e) => e.folderId === 'kho2'));
    expect(brain.search('moi tinh').map((h) => h.folderId)).toEqual(['kho2']);
  });
});
