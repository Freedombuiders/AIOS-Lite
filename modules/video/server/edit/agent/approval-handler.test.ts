import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decideApproval, getApproval, registerApprovalHandler } from '../../approvals.js';
import { _resetApprovalHandlers } from '../../approvals.js';
import { _initTestDatabase } from '../../compat-host.js';
import { createVideoEditStore, type VideoEditStore } from '../store.js';
import type { EditPlan } from '../types.js';
import { createVideoPlanApprovalHandler, describePlanForApproval, requestVideoPlanApproval } from './approval-handler.js';

let tmp: string;
let store: VideoEditStore;
let projectId: string;
let profileId: string;
const decidePlan = vi.fn(async (_id: string, _action: string, _note?: string) => ({ ok: true }));

function plan(version: number): EditPlan {
  return {
    version, createdAt: 'now', styleId: 'kienthuc', aspect: '9:16', summary: 'Mở bằng con số, bỏ từ đệm.', sourceDurationSec: 118.5, outputDurationSec: 87,
    cutWords: [1, 2], gapMs: 400, keep: [], removed: [{ start: 1, end: 2, kind: 'silence' }, { start: 5, end: 6, kind: 'filler' }],
    hook: { options: [{ id: 'h1', kind: 'number', text: 'Giảm 50% thời gian', mode: 'overlay' }], chosen: 'h1' },
    brolls: [{ id: 'b', anchorWord: 5, duration: 2, title: 't', reason: 'r', source: 'library', layout: 'card', enabled: true }],
    captions: { styleId: 'c', position: 'bottom', highlight: [], maxWordsPerChunk: 4 },
    overlays: [], zooms: [], music: { assetId: 'bgm:x', mood: 'm', gainDb: 0, duck: true }, sfx: [], covers: [],
    meta: { title: 't', caption: 'c', hashtags: [] }, author: 'agent', changes: ['Hook: đổi sang con số', 'Cắt thêm 3 chỗ lặng'],
  };
}

function setPlan(version: number, status: 'waiting_approval' | 'draft' = 'waiting_approval') {
  store.updateProject(projectId, (p) => { p.plan = plan(version); p.planVersion = version; p.planStatus = status; });
}

beforeEach(() => {
  _initTestDatabase();
  _resetApprovalHandlers();
  decidePlan.mockClear();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-approval-'));
  store = createVideoEditStore(path.join(tmp, 'video-edit'));
  const profile = store.createProfile({ name: 'Kênh Thử' });
  profileId = profile.id;
  projectId = store.createProject({ profileId, title: 'Video thử', styleId: 'kienthuc', agentId: 'video-editor' }).id;
  registerApprovalHandler('video_plan', createVideoPlanApprovalHandler({ store: () => store, decidePlan }));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const deps = () => ({ store: () => store });

describe('requestVideoPlanApproval', () => {
  it('creates a Vietnamese card with before to after duration and the change list', () => {
    setPlan(2);
    const r = requestVideoPlanApproval(projectId, deps())!;
    expect(r.created).toBe(true);
    const a = getApproval(r.approvalId)!;
    expect(a.kind).toBe('video_plan');
    expect(a.agentId).toBe('video-editor');
    expect(a.title).toContain('VID-0001');
    expect(a.title).toContain('1:59 → 1:27');
    expect(a.summary).toContain('Kiến thức nhanh');
    expect(a.summary).toContain('bỏ 2 đoạn');
    expect(a.summary).toContain('Hook: "Giảm 50% thời gian"');
    expect(a.summary).toContain('1 B-roll');
    expect(a.summary).toContain('- Cắt thêm 3 chỗ lặng');
    expect(a.payload).toEqual({ projectId, planVersion: 2 });
  });

  it('is idempotent per plan version and makes a new card for the next version', () => {
    setPlan(2);
    const first = requestVideoPlanApproval(projectId, deps())!;
    expect(requestVideoPlanApproval(projectId, deps())).toMatchObject({ approvalId: first.approvalId, created: false });
    setPlan(3);
    expect(requestVideoPlanApproval(projectId, deps())!.approvalId).not.toBe(first.approvalId);
  });

  it('does nothing when auto-approve is on, there is no plan, or it is not waiting', () => {
    expect(requestVideoPlanApproval(projectId, deps())).toBeNull();
    setPlan(1, 'draft');
    expect(requestVideoPlanApproval(projectId, deps())).toBeNull();
    setPlan(1);
    store.saveProfile({ ...store.getProfile(profileId)!, autoApprovePlan: true });
    expect(requestVideoPlanApproval(projectId, deps())).toBeNull();
  });

  it('keeps the summary within the approval limit', () => {
    const p = plan(1);
    p.changes = Array.from({ length: 30 }, (_, i) => `Thay đổi số ${i} ${'x'.repeat(150)}`);
    p.summary = 'y'.repeat(2000);
    const project = store.loadProject(projectId)!;
    expect(describePlanForApproval(project, p).summary.length).toBeLessThanOrEqual(1400);
  });
});

describe('deciding a video_plan approval', () => {
  const card = () => requestVideoPlanApproval(projectId, deps())!.approvalId;

  it('approve queues the render through decidePlan', async () => {
    setPlan(2);
    const done = await decideApproval(card(), 'approve', 'dashboard');
    expect(done.status).toBe('executed');
    expect(decidePlan).toHaveBeenCalledWith(projectId, 'approve');
  });

  it('revise asks for another plan with a default note', async () => {
    setPlan(2);
    const done = await decideApproval(card(), 'revise', 'dashboard');
    expect(done.status).toBe('executed');
    expect(decidePlan).toHaveBeenCalledWith(projectId, 'revise', expect.stringContaining('Chỉnh lại'));
  });

  it('reject marks the approval rejected and calls decidePlan reject', async () => {
    setPlan(2);
    const done = await decideApproval(card(), 'reject', 'dashboard');
    expect(done.status).toBe('rejected');
    expect(decidePlan).toHaveBeenCalledWith(projectId, 'reject');
  });

  it('refuses a stale card once a newer plan version exists', async () => {
    setPlan(2);
    const id = card();
    setPlan(3);
    const done = await decideApproval(id, 'approve', 'dashboard');
    expect(done.status).toBe('failed');
    expect(done.error).toContain('bản mới');
    expect(decidePlan).not.toHaveBeenCalled();
  });

  it('fails cleanly when decidePlan throws or the project is gone', async () => {
    setPlan(2);
    decidePlan.mockRejectedValueOnce(new Error('Hàng đợi đầy'));
    const failed = await decideApproval(card(), 'approve', 'dashboard');
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('Hàng đợi đầy');

    setPlan(3);
    const id = card();
    store.deleteProject(projectId);
    expect((await decideApproval(id, 'approve', 'dashboard')).error).toContain('không còn');
  });

  it('offers approve, revise and reject actions', () => {
    const handler = createVideoPlanApprovalHandler({ store: () => store, decidePlan });
    expect(handler.actions({} as never).map((a) => a.id)).toEqual(['approve', 'revise', 'reject']);
  });
});
