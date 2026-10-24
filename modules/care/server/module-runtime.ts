/**
 * Per-module-instance state of `care`: the data key, the stores, the connector registry and the runtime.
 * Everything hangs off the ModuleContext (no module-level singletons), so tests can build as many as they like.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ModuleContext } from '../../../src/modules/sdk.js';
import type { CareChannel, CareAccountRecord, NormalizedEvent } from '../../_lib/care-kit/index.js';
import { CareError } from '../../_lib/care-kit/index.js';
import { createLeanAgentRunner } from './application/agent-runner-lean.js';
import type { AgentTurnOutcome } from './application/agent-turn.js';
import { createConnectorRegistry, type CareConnectorExt, type MutableConnectorRegistry } from './connectors/registry.js';
import { createCareStores, type CareStores } from './persistence/index.js';
import { createCareSchema } from './persistence/schema.js';
import { quietHoursAt } from './policy/quiet-hours.js';
import { createCareRuntime, startCareRuntime, type CareRuntime } from './runtime/care-runtime.js';

/** What `ctx.modules.get('care').careChannels` offers channel modules. */
export interface CareChannelsApi {
  register(connector: CareConnectorExt): void;
  unregister(kind: string): void;
  /**
   * Create or map a care account using the CHANNEL's own account id (the care account gets that same id).
   * Idempotent; returns the care account id and its current owner epoch.
   */
  ensureAccount(input: EnsureAccountInput): { id: string; epoch: number };
  /** Throws when the account is unknown or not active. */
  getActiveEpoch(accountId: string): number;
  /** Resolves after the durable write; duplicates (same eventId or message) are reported, never stored twice. */
  ingest(event: NormalizedEvent): Promise<{ outcome: 'stored' | 'duplicate' | 'failed'; error?: string }>;
  listAccounts(channel?: CareChannel): CareAccountRecord[];
}

export interface EnsureAccountInput {
  id: string;
  channel: CareChannel | string;
  connectorKind: string;
  label: string;
  address?: string;
}

export interface CareModuleState {
  key: Buffer;
  stores: CareStores;
  registry: MutableConnectorRegistry;
  runtime: CareRuntime;
  channels: CareChannelsApi;
  /** Conversations we raised "needs you" attention for, so they can be resolved when nothing is open any more. */
  raised: Set<string>;
  started: boolean;
}

const states = new WeakMap<ModuleContext, CareModuleState>();

/** The data key lives encrypted (ctx.crypto) in the module data dir; it is generated on first use. */
export function loadCareKey(ctx: Pick<ModuleContext, 'dataDir' | 'crypto'>): Buffer {
  fs.mkdirSync(ctx.dataDir, { recursive: true });
  const file = path.join(ctx.dataDir, 'care.key');
  if (fs.existsSync(file)) {
    const hex = ctx.crypto.decrypt(fs.readFileSync(file, 'utf8').trim());
    const key = Buffer.from(hex, 'hex');
    if (key.length !== 32) throw new CareError('CREDENTIAL_DECODE_FAILED', 'Khoá dữ liệu của care không hợp lệ.', 500);
    return key;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, ctx.crypto.encrypt(key.toString('hex')), { mode: 0o600 });
  return key;
}

const CARE_SKILL = 'tra-loi-khach';

/** Body of skills/tra-loi-khach/SKILL.md when the agent was granted that skill (frontmatter stripped, capped). */
function skillText(ctx: ModuleContext, agentId: string): string | null {
  if (!ctx.agents.get(agentId)?.access.skills.includes(CARE_SKILL)) return null;
  try {
    const raw = fs.readFileSync(path.join(ctx.dir, 'skills', CARE_SKILL, 'SKILL.md'), 'utf8');
    return raw.replace(/^---[\s\S]*?---\s*/, '').trim().slice(0, 4000) || null;
  } catch {
    return null;
  }
}

const draftKey = (conversationId: string) => `care:draft:${conversationId}`;
const handoffKey = (conversationId: string) => `care:handoff:${conversationId}`;

export function careState(ctx: ModuleContext): CareModuleState {
  const existing = states.get(ctx);
  if (existing) return existing;

  const key = loadCareKey(ctx);
  createCareSchema(ctx.db);
  const stores = createCareStores(ctx.db, key);
  const registry = createConnectorRegistry();
  const raised = new Set<string>();

  const onTurnOutcome = (out: AgentTurnOutcome, conversationId: string): void => {
    const link = `/m/care/inbox/${conversationId}`;
    if (out.status === 'drafted' && out.proposal.delivery.effective === 'draft') {
      raised.add(draftKey(conversationId));
      ctx.attention.raise({
        key: draftKey(conversationId),
        title: 'Có nháp trả lời khách đang chờ duyệt',
        detail: out.proposal.reviewReason ?? undefined,
        link,
        severity: out.proposal.needsReview ? 'warn' : 'info',
      });
    } else if (out.status === 'skipped' && out.reason === 'agent_handoff_suggested') {
      raised.add(handoffKey(conversationId));
      ctx.attention.raise({ key: handoffKey(conversationId), title: 'Agent đề nghị người thật xem cuộc trò chuyện này', link, severity: 'warn' });
    }
  };

  const runtime = createCareRuntime({
    db: ctx.db,
    stores,
    connectors: registry,
    runner: createLeanAgentRunner(ctx),
    workerId: `care:${ctx.id}`,
    key,
    killSwitches: () => ({
      moduleEnabled: true,
      aiEnabled: ctx.settings.get<boolean>('aiEnabled', true),
      autoSendEnabled: ctx.settings.get<boolean>('autoSendEnabled', true),
      channels: {},
    }),
    agentCan: (agentId, scope) => ctx.access.can(agentId, scope),
    skillFor: (agentId) => skillText(ctx, agentId),
    conversationControl: (conversationId) => {
      const row = ctx.db.prepare('SELECT ai_mode AS aiMode, taken_over_at AS takenOverAt FROM care_conversation_state WHERE conversation_id = ?').get(conversationId) as
        | { aiMode: 'off' | 'draft' | 'auto' | null; takenOverAt: number | null }
        | undefined;
      return row ? { takenOver: row.takenOverAt !== null, aiMode: row.aiMode } : null;
    },
    autoDelaySeconds: () => {
      const v = Number(ctx.settings.get<number>('autoDelaySeconds', 10));
      return Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
    },
    quietHours: (_channel, nowMs) =>
      quietHoursAt(
        { start: ctx.settings.get<string>('quietHoursStart', '22:00'), end: ctx.settings.get<string>('quietHoursEnd', '07:00') },
        nowMs,
      ),
    onTurnOutcome,
  });

  const channels: CareChannelsApi = {
    register: (c) => registry.register(c),
    unregister: (kind) => registry.unregister(kind),
    getActiveEpoch(accountId) {
      const a = stores.accounts.getAccount(accountId);
      if (!a) throw new CareError('INVALID_TARGET', 'Không tìm thấy tài khoản kênh trong care.', 404);
      if (a.desiredState !== 'active') throw new CareError('INVALID_TARGET', 'Tài khoản kênh chưa hoạt động trong care.', 409);
      return a.ownerEpoch;
    },
    async ingest(event) {
      try {
        const account = stores.accounts.getAccount(event.accountId);
        if (!account) return { outcome: 'failed', error: `Account not found: ${event.accountId}` };
        const res = runtime.ingest.ingestNormalizedEvent({ ...event, epoch: event.epoch ?? account.ownerEpoch });
        return { outcome: res.outcome.startsWith('duplicate') ? 'duplicate' : 'stored' };
      } catch (err) {
        return { outcome: 'failed', error: err instanceof Error ? err.message.slice(0, 300) : 'ingest failed' };
      }
    },
    ensureAccount(input) {
      if (input.channel !== 'zalo' && input.channel !== 'email') throw new CareError('INVALID_TARGET', `Kênh không được hỗ trợ: ${input.channel}`, 400);
      const channel = input.channel;
      const found = stores.accounts.getAccountByNative(channel, input.connectorKind, input.id);
      const account =
        found ??
        stores.accounts.createAccount({
          id: input.id,
          channel,
          connectorKind: input.connectorKind,
          nativeAccountId: input.id,
          label: input.address ? `${input.label} (${input.address})` : input.label,
          desiredState: 'active',
          syncEnabled: true,
          sendEnabled: true,
          aiEnabled: true,
          writeOwner: 'core',
        });
      return { id: account.id, epoch: account.ownerEpoch };
    },
    listAccounts: (channel) => stores.accounts.listAccounts(channel),
  };

  const state: CareModuleState = { key, stores, registry, runtime, channels, raised, started: false };
  states.set(ctx, state);
  return state;
}

/** Raises attention for every conversation that has an open draft and resolves the ones that no longer do. */
export function syncDraftAttention(ctx: ModuleContext, state: CareModuleState): void {
  const rows = ctx.db
    .prepare(`SELECT conversation_id AS id, COUNT(*) AS n FROM care_delivery_intents WHERE status = 'draft' GROUP BY conversation_id`)
    .all() as Array<{ id: string; n: number }>;
  const open = new Set(rows.map((r) => draftKey(r.id)));
  for (const r of rows) {
    if (state.raised.has(draftKey(r.id))) continue;
    state.raised.add(draftKey(r.id));
    ctx.attention.raise({ key: draftKey(r.id), title: 'Có nháp trả lời khách đang chờ duyệt', link: `/m/care/inbox/${r.id}`, severity: 'info' });
  }
  for (const k of [...state.raised]) {
    if (!k.startsWith('care:draft:') || open.has(k)) continue;
    state.raised.delete(k);
    ctx.attention.resolve(k);
  }
}

export function startCare(ctx: ModuleContext): void {
  const state = careState(ctx);
  if (state.started) return;
  state.started = true;
  startCareRuntime(state.runtime);
  ctx.schedule.every('care-attention', 5_000, () => syncDraftAttention(ctx, state));
}

export async function stopCare(ctx: ModuleContext): Promise<void> {
  const state = states.get(ctx);
  if (!state) return;
  states.delete(ctx);
  if (state.started) await state.runtime.stop();
}
