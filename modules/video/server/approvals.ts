/**
 * Owner approvals of the Video Studio ('video_plan' edit plans, 'video_generate' scene batches).
 * Module-local replacement for the owner's approvals core: a small JSON-backed store plus handler registry,
 * decided from the studio chat card (POST /approvals/:id/decide). Pending cards also raise an attention item.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Hono } from 'hono';

export type ApprovalKind = 'video_plan' | 'video_generate';
export type ApprovalStatus = 'pending' | 'deciding' | 'approved' | 'executed' | 'failed' | 'rejected' | 'expired';

export interface OwnerApproval {
  id: string;
  kind: ApprovalKind;
  agentId: string;
  title: string;
  summary: string;
  payload: unknown;
  payloadHash: string;
  payloadSignature: string;
  dedupeKey: string | null;
  status: ApprovalStatus;
  decisionAction: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  result: unknown;
  error: string | null;
  expiresAt: number | null;
  createdAt: number;
}

export interface CreateApprovalInput {
  kind: ApprovalKind;
  agentId: string;
  title: string;
  summary: string;
  payload: unknown;
  dedupeKey?: string;
  expiresInSec?: number;
}

export interface ApprovalAction { id: string; label: string; kind: 'approve' | 'reject' }

export interface ApprovalOutcome {
  status: 'approved' | 'executed' | 'failed' | 'rejected';
  result?: unknown;
  error?: string;
}

export interface ApprovalHandler {
  actions(approval: OwnerApproval): ApprovalAction[];
  onDecision(approval: OwnerApproval, actionId: string, decidedBy: string): Promise<ApprovalOutcome>;
}

export interface ApprovalHooks {
  onCreated?(a: OwnerApproval): void;
  onSettled?(a: OwnerApproval): void;
}

const handlers = new Map<ApprovalKind, ApprovalHandler>();
let items = new Map<string, OwnerApproval>();
let file: string | null = null;
let hooks: ApprovalHooks = {};

const now = () => Math.floor(Date.now() / 1000);
const hashOf = (payload: unknown) => createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex');
const newId = () => randomBytes(8).toString('hex').slice(0, 10);

function persist(): void {
  if (!file) return;
  try { fs.writeFileSync(file, JSON.stringify([...items.values()]), { mode: 0o600 }); } catch { /* best effort */ }
}

/** Point the store at a data dir (null = memory only, used by tests). */
export function bindApprovals(dir: string | null, h: ApprovalHooks = {}): void {
  hooks = h;
  items = new Map();
  file = null;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'approvals.json');
  try { for (const a of JSON.parse(fs.readFileSync(file, 'utf8')) as OwnerApproval[]) items.set(a.id, a); } catch { /* first run */ }
  // A process that died mid-decision leaves 'deciding': never replay it.
  for (const a of items.values()) if (a.status === 'deciding') { a.status = 'failed'; a.error = 'Bị gián đoạn khi đang xử lý.'; }
}

export function createApproval(input: CreateApprovalInput): { approval: OwnerApproval; created: boolean } {
  if (input.dedupeKey) {
    for (const a of items.values()) {
      if (a.status === 'pending' && a.agentId === input.agentId && a.dedupeKey === input.dedupeKey) return { approval: a, created: false };
    }
  }
  const payloadHash = hashOf(input.payload);
  const approval: OwnerApproval = {
    id: newId(), kind: input.kind, agentId: input.agentId, title: input.title, summary: input.summary.slice(0, 1500),
    payload: input.payload, payloadHash, payloadSignature: payloadHash, dedupeKey: input.dedupeKey ?? null,
    status: 'pending', decisionAction: null, decidedBy: null, decidedAt: null, result: null, error: null,
    expiresAt: now() + (input.expiresInSec ?? 24 * 3600), createdAt: now(),
  };
  items.set(approval.id, approval);
  persist();
  hooks.onCreated?.(approval);
  return { approval, created: true };
}

export function getApproval(id: string): OwnerApproval | null {
  const a = items.get(id) ?? null;
  if (a && a.status === 'pending' && a.expiresAt && a.expiresAt < now()) { a.status = 'expired'; persist(); }
  return a;
}

export function expireApproval(id: string): boolean {
  const a = items.get(id);
  if (!a || a.status !== 'pending') return false;
  a.status = 'expired';
  persist();
  hooks.onSettled?.(a);
  return true;
}

export function listApprovals(filter: { status?: ApprovalStatus[]; kind?: ApprovalKind; limit?: number } = {}): OwnerApproval[] {
  return [...items.values()]
    .filter((a) => (!filter.status || filter.status.includes(a.status)) && (!filter.kind || a.kind === filter.kind))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, filter.limit ?? 200);
}

export function verifyApprovalPayload(a: OwnerApproval): boolean {
  return a.payloadSignature === hashOf(a.payload) && a.payloadHash === a.payloadSignature;
}

export function registerApprovalHandler(kind: ApprovalKind, handler: ApprovalHandler): void {
  handlers.set(kind, handler);
}

export function getApprovalHandler(kind: ApprovalKind): ApprovalHandler | undefined {
  return handlers.get(kind);
}

export class ApprovalError extends Error {
  constructor(readonly status: 404 | 409 | 400, message: string) { super(message); }
}

export async function decideApproval(id: string, actionId: string, decidedBy: string): Promise<OwnerApproval> {
  const a = getApproval(id);
  if (!a) throw new ApprovalError(404, 'Không tìm thấy yêu cầu duyệt.');
  if (a.status !== 'pending') throw new ApprovalError(409, 'Yêu cầu này đã được xử lý hoặc đã hết hạn.');
  const handler = handlers.get(a.kind);
  if (!handler) throw new ApprovalError(400, 'Chưa có bộ xử lý cho loại yêu cầu này.');
  if (!handler.actions(a).some((x) => x.id === actionId)) throw new ApprovalError(400, 'Hành động không hợp lệ.');
  a.status = 'deciding';
  a.decisionAction = actionId;
  a.decidedBy = decidedBy;
  a.decidedAt = now();
  let outcome: ApprovalOutcome;
  try { outcome = await handler.onDecision(a, actionId, decidedBy); }
  catch (err) { outcome = { status: 'failed', error: err instanceof Error ? err.message : String(err) }; }
  a.status = outcome.status;
  a.result = outcome.result ?? null;
  a.error = outcome.error ?? null;
  persist();
  hooks.onSettled?.(a);
  return a;
}

function toDto(a: OwnerApproval) {
  const actions = a.status === 'pending' ? (handlers.get(a.kind)?.actions(a) ?? []) : [];
  const { payload: _p, payloadHash: _h, payloadSignature: _s, ...rest } = a;
  return { ...rest, actions };
}

export function registerApprovalRoutes(app: Hono): void {
  app.get('/approvals/:id', (c) => {
    const a = getApproval(c.req.param('id'));
    return a ? c.json({ approval: toDto(a) }) : c.json({ error: 'Không tìm thấy yêu cầu duyệt.' }, 404);
  });
  app.post('/approvals/:id/decide', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { actionId?: unknown } | null;
    if (!body || typeof body.actionId !== 'string' || !/^[a-z0-9_]{1,16}$/.test(body.actionId)) return c.json({ error: 'Thiếu hành động.' }, 400);
    try { return c.json({ approval: toDto(await decideApproval(c.req.param('id'), body.actionId, 'dashboard')) }); }
    catch (err) {
      if (err instanceof ApprovalError) return c.json({ error: err.message }, err.status);
      return c.json({ error: 'Không xử lý được yêu cầu duyệt.' }, 500);
    }
  });
}

/** Tests only: forget handlers and stored approvals. */
export function _resetApprovalHandlers(): void {
  handlers.clear();
  items = new Map();
  file = null;
  hooks = {};
}
