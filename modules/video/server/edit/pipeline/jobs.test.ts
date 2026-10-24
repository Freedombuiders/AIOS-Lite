import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJobQueue } from './jobs.js';
import { parseLoudnormJson } from './render.js';

let dir: string;
let file: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-jobs-')); file = path.join(dir, 'jobs.json'); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('job queue', () => {
  it('runs main-lane jobs one at a time, persists and reports progress', async () => {
    const order: string[] = [];
    const seen: string[] = [];
    let active = 0;
    let maxActive = 0;
    const q = createJobQueue({
      file,
      onChange: (j) => seen.push(`${j.kind}:${j.status}`),
      handlers: {
        ingest: async (_j, ctx) => { active++; maxActive = Math.max(maxActive, active); order.push('a'); ctx.progress(0.5, 'nửa'); await new Promise((r) => setTimeout(r, 10)); active--; return 'xong a'; },
        transcribe: async () => { active++; maxActive = Math.max(maxActive, active); order.push('b'); active--; },
      },
    });
    const a = q.enqueue('ingest', 'p1');
    const t = q.enqueue('transcribe', 'p1');
    expect(q.enqueue('transcribe', 'p1').id).toBe(t.id); // an identical queued job is not duplicated
    await q.idle();
    expect(order).toEqual(['a', 'b']);
    expect(maxActive).toBe(1);
    expect(q.get(a.id)).toMatchObject({ status: 'done', message: 'xong a', progress: 1 });
    expect(seen).toContain('ingest:running');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toHaveLength(2);
  });

  it('runs director turns on their own lane and records failures', async () => {
    let release!: () => void;
    const q = createJobQueue({
      file,
      handlers: {
        direct: () => new Promise<void>((r) => { release = r; }),
        render: async () => { throw new Error('hỏng'); },
      },
    });
    q.enqueue('direct', 'p1');
    const r = q.enqueue('render', 'p1');
    await new Promise((res) => setTimeout(res, 20));
    expect(q.get(r.id)).toMatchObject({ status: 'failed', message: 'hỏng' });
    expect(q.runningFor('p1').map((j) => j.kind)).toEqual(['direct']);
    release();
    await q.idle();
  });

  it('cancels queued and running jobs of a project', async () => {
    const q = createJobQueue({
      file,
      handlers: { ingest: (_j, ctx) => new Promise<void>((_r, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('x')))), analyze: async () => {} },
    });
    const run = q.enqueue('ingest', 'p1');
    const wait = q.enqueue('analyze', 'p1');
    q.cancelProject('p1');
    await q.idle();
    expect(q.get(run.id)?.status).toBe('cancelled');
    expect(q.get(wait.id)?.status).toBe('cancelled');
  });

  it('marks a job left running by a dead process as failed and resumes queued ones', async () => {
    fs.writeFileSync(file, JSON.stringify([
      { id: 'r', projectId: 'p', kind: 'render', status: 'running', createdAt: 'x' },
      { id: 'q', projectId: 'p', kind: 'analyze', status: 'queued', createdAt: 'x' },
    ]));
    const interrupted: string[] = [];
    let ran = false;
    const q = createJobQueue({ file, onInterrupted: (j) => interrupted.push(j.id), handlers: { analyze: async () => { ran = true; } } });
    q.start();
    await q.idle();
    expect(interrupted).toEqual(['r']);
    expect(q.get('r')).toMatchObject({ status: 'failed' });
    expect(ran).toBe(true);
  });
});

describe('loudnorm output', () => {
  it('reads the measured values from ffmpeg stderr', () => {
    const stderr = 'noise\n{\n\t"input_i" : "-19.20",\n\t"input_tp" : "-3.1",\n\t"input_lra" : "5.0",\n\t"input_thresh" : "-29.4",\n\t"target_offset" : "0.3"\n}\n';
    expect(parseLoudnormJson(stderr)).toMatchObject({ input_i: '-19.20', target_offset: '0.3' });
    expect(parseLoudnormJson('nothing')).toBeNull();
  });
});
