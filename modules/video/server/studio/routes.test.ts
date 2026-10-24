import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerVideoStudioRoutes, type StudioJob } from './routes.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(r => fs.rmSync(r, { recursive: true, force: true })));
function setup(call = vi.fn(async () => 'job_id: batch-123\nGọi get_job')) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-')); roots.push(root);
  const app = new Hono(); registerVideoStudioRoutes(app, { root, call });
  const post = (route: string, body?: unknown) => app.request(`/studio/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { root, app, post, call };
}
const body = () => ({ requestId: randomUUID(), title: 'Demo', kind: 'video', prompts: ['Scene one'], aspect_ratio: '9:16', duration: '6s' });
describe('Video Studio', () => {
  it('submits once, preserves job IDs and refreshes persisted jobs', async () => {
    const { post, call, root } = setup(); const input = body();
    const result = await (await post('jobs', input)).json() as { job: StudioJob };
    expect(result.job.jobId).toBe('batch-123');
    await post('jobs', input); expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('generate_video', expect.objectContaining({ wait_seconds: 0, provider: 'flow', prompts: ['Scene one'] }));
    const reopened = new Hono(); registerVideoStudioRoutes(reopened, { root, call });
    expect((await (await reopened.request('/studio/jobs')).json() as { jobs: StudioJob[] }).jobs).toHaveLength(1);
    await post(`jobs/${input.requestId}/refresh`);
    expect(call).toHaveBeenLastCalledWith('get_job', { job_id: 'batch-123', wait_seconds: 0 });
  });
  it('never retries an uncertain paid write', async () => {
    const call = vi.fn(async (): Promise<string> => { throw new Error('Timed out'); });
    const { post } = setup(call); const input = body();
    expect((await (await post('jobs', input)).json() as { job: StudioJob }).job.state).toBe('unknown');
    await post('jobs', input); expect(call).toHaveBeenCalledTimes(1);
    expect((await post(`jobs/${input.requestId}/refresh`)).status).toBe(409);
  });
  it('deduplicates concurrent submissions before the bridge replies', async () => {
    let finish!: (value: string) => void;
    const call = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const { post } = setup(call); const input = body();
    const first = post('jobs', input);
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect((await (await post('jobs', input)).json() as { job: StudioJob }).job.state).toBe('submitting');
    finish('job_id: same-batch'); await first;
    expect(call).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed requests and never forwards arbitrary tool names', async () => {
    const { post, call } = setup();
    expect((await post('jobs', { ...body(), prompts: [] })).status).toBe(400);
    expect((await post('jobs', { ...body(), end_frame: '/tmp/end.png' })).status).toBe(400);
    expect((await post('jobs', { ...body(), command: 'anything' })).status).toBe(400);
    expect((await post('jobs/not-a-uuid/refresh')).status).toBe(404);
    expect(call).not.toHaveBeenCalled();
  });
});

