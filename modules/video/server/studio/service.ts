import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { STORE_DIR } from '../paths.js';
import { RocketFlowBridge, type ToolCall } from './bridge.js';
export const schema = z.object({
  requestId: z.string().uuid(), title: z.string().trim().min(1).max(120),
  kind: z.enum(['image', 'video']),
  prompts: z.array(z.string().trim().min(1).max(8000)).min(1).max(100),
  model: z.string().trim().max(100).optional(),
  aspect_ratio: z.enum(['9:16', '16:9', '1:1']),
  duration: z.string().regex(/^\d{1,2}s$/).optional(),
  reference_images: z.array(z.string().min(1).max(4096)).max(10).optional(),
  start_frame: z.string().max(4096).optional(),
  end_frame: z.string().max(4096).optional(),
}).strict();
export interface StudioJob {
  id: string; title: string; kind: 'image' | 'video'; prompts: string[];
  createdAt: string; agentId?: string; project?: string; request?: string; jobId?: string; output: string;
  cancelState?: 'pending' | 'unknown' | 'confirmed';
  state: 'submitting' | 'submitted' | 'unknown';
}

const activeSubmissions = new Set<string>();
const activeCancellations = new Set<string>();
export class RocketFlowService {
  readonly bridge: RocketFlowBridge;
  readonly call: ToolCall;
  constructor(private readonly rootOverride?: string, call?: ToolCall) {
    this.bridge = new RocketFlowBridge(); this.call = call || this.bridge.call;
  }
  /** Resolved per use: the module data dir is only known once the module has started. */
  get root(): string { return this.rootOverride ?? path.join(STORE_DIR, 'video-studio'); }
  private file(id: string) { return path.join(this.root, `${z.string().uuid().parse(id)}.json`); }
  private save(job: StudioJob) {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temp = path.join(this.root, `.${randomUUID()}.tmp`);
    fs.writeFileSync(temp, JSON.stringify(job), { mode: 0o600 }); fs.renameSync(temp, this.file(job.id));
  }
  read(id: string, agentId?: string): StudioJob {
    const job = JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as StudioJob;
    if (agentId && job.agentId !== agentId) throw new Error('Job access denied');
    if (job.state === 'submitting' && !activeSubmissions.has(this.file(id))) { job.state = 'unknown'; job.output += '\nApp restarted during submission. Outcome unknown; inspect extension queue, never resubmit automatically.'; this.save(job); }
    if (job.cancelState === 'pending' && !activeCancellations.has(this.file(id))) { job.cancelState = 'unknown'; job.output += '\nApp restarted during cancellation. Outcome unknown; inspect extension queue.'; this.save(job); }
    return job;
  }
  list() { return fs.existsSync(this.root) ? fs.readdirSync(this.root).filter(n => /^[\da-f-]{36}\.json$/.test(n)).map(n => this.read(n.slice(0, -5))).sort((a,b) => b.createdAt.localeCompare(a.createdAt)) : []; }
  grants(): Record<string, 'read' | 'write'> {
    const grants: Record<string, 'read' | 'write'> = Object.create(null);
    try {
      const parsed = z.record(z.string(), z.enum(['read', 'write'])).parse(JSON.parse(fs.readFileSync(path.join(this.root, 'grants.json'), 'utf8')));
      for (const [id, access] of Object.entries(parsed)) grants[id] = access;
    } catch { /* Missing/corrupt grants fail closed. */ }
    return grants;
  }
  grant(agentId: string, access: 'off' | 'read' | 'write') {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(agentId)) throw new Error('Invalid agent ID');
    const grants = this.grants(); if (access === 'off') delete grants[agentId]; else grants[agentId] = access;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temp = path.join(this.root, `.${randomUUID()}.tmp`);
    fs.writeFileSync(temp, JSON.stringify(grants), { mode: 0o600 }); fs.renameSync(temp, path.join(this.root, 'grants.json'));
  }
  async submit(input: unknown, provenance: { agentId?: string; project?: string } = {}): Promise<StudioJob> {
    const { requestId, title, kind, ...args } = schema.parse(input);
    if (args.end_frame && !args.start_frame) throw new Error('Cần khung đầu khi dùng khung cuối.');
    const request = JSON.stringify({ title, kind, ...args });
    if (fs.existsSync(this.file(requestId))) {
      const prior = this.read(requestId, provenance.agentId);
      if (prior.request && prior.request !== request) throw new Error('Request ID already used with different input');
      return prior;
    }
    const job: StudioJob = { id: requestId, title, kind, prompts: args.prompts, ...provenance, request, createdAt: new Date().toISOString(), state: 'submitting', output: 'Đang gửi tới RocketFlow…' };
    // Synchronous reservation before first await, shared by UI and every turn gateway.
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(this.file(job.id), JSON.stringify(job), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; return this.submit(input, provenance); }
    activeSubmissions.add(this.file(job.id));
    try {
      job.output = await this.call(`generate_${kind}`, { ...args, provider: 'flow', count: 1, wait_seconds: 0, run_mode: 'sequential', subfolder: `studio-${requestId}`, ...(args.start_frame ? { video_input: 'frames' } : {}) });
      job.jobId = /job_id:\s*([^\s]+)/.exec(job.output)?.[1]; job.state = job.jobId ? 'submitted' : 'unknown';
    } catch (e) { job.state = 'unknown'; job.output = `${e instanceof Error ? e.message : e}\nUnknown outcome. Check RocketFlow queue; do not resubmit.`; }
    try { this.save(job); return job; } finally { activeSubmissions.delete(this.file(job.id)); }
  }
  async action(id: string, action: 'refresh' | 'cancel', agentId?: string) {
    const job = this.read(id, agentId);
    if (!job.jobId) throw new Error('Chưa có mã job. Kiểm tra hàng đợi trong RocketFlow.');
    if (action === 'cancel' && job.cancelState) return job;
    if (action === 'cancel') { job.cancelState = 'pending'; this.save(job); activeCancellations.add(this.file(id)); }
    try {
      const output = await this.call(action === 'refresh' ? 'get_job' : 'cancel_job', { job_id: job.jobId, ...(action === 'refresh' ? { wait_seconds: 0 } : {}) });
      const current = this.read(id, agentId); current.output = output;
      if (action === 'cancel') current.cancelState = 'confirmed';
      this.save(current); return current;
    } catch (e) {
      if (action === 'cancel') { const current = this.read(id, agentId); current.cancelState = 'unknown'; current.output += '\nCancellation outcome unknown. Inspect extension queue; do not retry automatically.'; this.save(current); }
      throw e;
    } finally { if (action === 'cancel') activeCancellations.delete(this.file(id)); }
  }

  close() { return this.bridge.close(); }
}
export const rocketFlowService = new RocketFlowService();
