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
import { OWNER_SKIP_REASONS, type AgentTurnOutcome } from './application/agent-turn.js';
import { createConversationControlReader, type CustomerHandoff } from './application/conversation-hold.js';
import { parseHandoffKeywords, parseHandoffPauseMinutes } from './policy/handoff.js';
import { CareMediaCache } from './application/media-cache.js';
import { createTurnMediaSource, sweepTurnMedia, TURN_MEDIA_STALE_MS } from './application/turn-media.js';
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
  /** Local copies of chat images (Zalo CDN links expire). */
  media: CareMediaCache;
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
/** T06: the customer asked for a person (hard rule); resolved by the sweep once the owner hands the conversation back. */
const customerHandoffKey = (conversationId: string) => `care:customer-handoff:${conversationId}`;
/** T06: a turn the bot could not take (images/files it cannot read, prompt over the runtime limit). */
const needsOwnerKey = (conversationId: string) => `care:needs-owner:${conversationId}`;

const NEEDS_OWNER_TITLE: Record<string, string> = {
  media_needs_owner: 'Khách gửi ảnh hoặc tệp mà agent không đọc được, bạn xem giúp',
  prompt_too_long: 'Cuộc trò chuyện quá dài để agent trả lời, bạn xem giúp',
};

/** Max prompt characters of the agent's runtime, when the core exposes it (optional SDK hook; null when unknown). */
function promptLimitOf(ctx: ModuleContext, agentId: string): number | null {
  const agents = ctx.agents as ModuleContext['agents'] & { promptLimit?: (agentId: string) => number | null };
  try {
    const v = agents.promptLimit?.(agentId);
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function raiseCustomerHandoff(ctx: ModuleContext, raised: Set<string>, h: Pick<CustomerHandoff, 'conversationId' | 'keyword'>): void {
  raised.add(customerHandoffKey(h.conversationId));
  ctx.attention.raise({
    key: customerHandoffKey(h.conversationId),
    title: 'Khách muốn gặp người thật',
    detail: `Khách nhắc tới "${h.keyword}". Agent đã dừng ở cuộc trò chuyện này cho tới khi bạn trả lại cho agent.`,
    link: `/m/care/inbox/${h.conversationId}`,
    severity: 'warn',
  });
}

export function careState(ctx: ModuleContext): CareModuleState {
  const existing = states.get(ctx);
  if (existing) return existing;

  const key = loadCareKey(ctx);
  createCareSchema(ctx.db);
  const stores = createCareStores(ctx.db, key);
  const registry = createConnectorRegistry();
  const raised = new Set<string>();
  const media = new CareMediaCache({
    dir: path.join(ctx.dataDir, 'media-cache'),
    key,
    db: ctx.db,
    stores,
    connectors: registry,
    onError: (err, messageId, index) =>
      ctx.log.warn({ messageId, index, reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown' }, 'care media: could not copy image'),
  });

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
    } else if (out.status === 'skipped' && OWNER_SKIP_REASONS.has(out.reason)) {
      raised.add(needsOwnerKey(conversationId));
      ctx.attention.raise({ key: needsOwnerKey(conversationId), title: NEEDS_OWNER_TITLE[out.reason] ?? 'Agent không trả lời được, bạn xem giúp', link, severity: 'warn' });
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
      // T06: draft-only unless the owner switched automatic sending on (module.json default false).
      autoSendEnabled: ctx.settings.get<boolean>('autoSendEnabled', false),
      channels: {},
    }),
    agentCan: (agentId, scope) => ctx.access.can(agentId, scope),
    skillFor: (agentId) => skillText(ctx, agentId),
    turnMedia: createTurnMediaSource({
      media,
      stores,
      connectors: registry,
      canRead: (agentId) => ctx.agents.attachments(agentId),
      onError: (err, messageId, index) =>
        ctx.log.warn({ messageId, index, reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown' }, 'care media: could not fetch a document for the agent'),
    }),
    conversationControl: createConversationControlReader(ctx.db),
    autoDelaySeconds: () => {
      const v = Number(ctx.settings.get<number>('autoDelaySeconds', 10));
      return Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
    },
    promptLimit: (agentId) => promptLimitOf(ctx, agentId),
    handoff: () => {
      const all = ctx.settings.all();
      return { keywords: parseHandoffKeywords(all.handoffKeywords), pauseMinutes: parseHandoffPauseMinutes(all.handoffPauseMinutes) };
    },
    onHandoff: (h) => raiseCustomerHandoff(ctx, raised, h),
    turnDebounceMs: () => {
      const v = Number(ctx.settings.get<number>('turnDebounceSeconds', 0));
      return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 60) * 1000 : 0;
    },
    quietHours: (_channel, nowMs) =>
      quietHoursAt(
        { start: ctx.settings.get<string>('quietHoursStart', '22:00'), end: ctx.settings.get<string>('quietHoursEnd', '07:00') },
        nowMs,
      ),
    onTurnOutcome,
    onMessageStored: (messageId) => media.warm(messageId),
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
        if (res.outcome === 'created' && res.messageId) media.warm(res.messageId);
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

  const state: CareModuleState = { key, stores, registry, runtime, channels, media, raised, started: false };
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
  syncHandoffAttention(ctx, state);
}

/**
 * T06: every open customer handoff has an attention item (also after a restart, or when the post-commit raise was
 * lost), and the item goes away once the owner hands the conversation back.
 */
export function syncHandoffAttention(ctx: ModuleContext, state: CareModuleState): void {
  const rows = ctx.db
    .prepare(`SELECT conversation_id AS id, handoff_keyword AS keyword FROM care_conversation_state WHERE handoff_at IS NOT NULL`)
    .all() as Array<{ id: string; keyword: string | null }>;
  const open = new Set(rows.map((r) => customerHandoffKey(r.id)));
  for (const r of rows) {
    if (state.raised.has(customerHandoffKey(r.id))) continue;
    raiseCustomerHandoff(ctx, state.raised, { conversationId: r.id, keyword: r.keyword ?? '' });
  }
  for (const k of [...state.raised]) {
    if (!k.startsWith('care:customer-handoff:') || open.has(k)) continue;
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
  ctx.schedule.every('care-media-prune', 60 * 60_000, () => void state.media.prune());
  // Customer files of a turn cut short by a crash or restart must not stay in the temp dir.
  sweepTurnMedia();
  ctx.schedule.every('care-turn-media-sweep', TURN_MEDIA_STALE_MS, () => void sweepTurnMedia());
}

export async function stopCare(ctx: ModuleContext): Promise<void> {
  const state = states.get(ctx);
  if (!state) return;
  states.delete(ctx);
  if (state.started) await state.runtime.stop();
}
