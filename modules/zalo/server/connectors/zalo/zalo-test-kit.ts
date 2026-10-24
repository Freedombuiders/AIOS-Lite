/**
 * Test kit for the Zalo care connector. Synthetic only: the fake Zalo transport and a controllable clock.
 * No care module, no zca-js session, no network. Care's own stores are not imported (they belong to the care
 * module): `conversations` below only answers the connector's "is this key a group?" question.
 */

import type { ChatDeliveryCommand, NativeCheckpointBox } from '../../../../_lib/care-kit/index.js';
import type { CareCheckpoint } from '../../../../_lib/care-kit/index.js';
import { FakeZaloTransport, legacyLikeFeatures } from './fake-transport.js';
import type { ZaloRawMessage, ZaloThreadKind } from './transport.js';
import { ZaloCareConnector, type ZaloConnectorOptions } from './zalo-connector.js';

export interface ZaloRig {
  transport: FakeZaloTransport;
  connector: ZaloCareConnector;
  clock: { t: number };
  state: { epoch: number };
  /** The nick as care would know it (id is the zalo account id in AIOS-Lite). */
  account: { id: string; ownerEpoch: number };
  /** Conversations care has seen: external key -> kind. */
  conversations: Map<string, 'direct' | 'group'>;
  upsertConversation: (externalKey: string, kind: 'direct' | 'group') => void;
  newConnector: (over?: Partial<ZaloConnectorOptions>) => ZaloCareConnector;
  close: () => void;
}

export function makeZaloRig(over: Partial<ZaloConnectorOptions> & { legacyFeatures?: boolean } = {}): ZaloRig {
  const { legacyFeatures, ...connectorOver } = over;
  const transport = new FakeZaloTransport();
  if (legacyFeatures) transport.featureSet = legacyLikeFeatures();
  const account = { id: 'care-acc-1', ownerEpoch: 1 };
  const conversations = new Map<string, 'direct' | 'group'>([['peer-1', 'direct']]);
  const clock = { t: transport.now };
  const state = { epoch: account.ownerEpoch };
  const kindOf = (_accountId: string, key: string): ZaloThreadKind | null => {
    const kind = conversations.get(key);
    return kind ? (kind === 'group' ? 'group' : 'user') : null;
  };
  const newConnector = (extra: Partial<ZaloConnectorOptions> = {}) =>
    new ZaloCareConnector({
      transport,
      getActiveEpoch: () => state.epoch,
      now: () => clock.t,
      resolveThreadKind: kindOf,
      ...connectorOver,
      ...extra,
    });
  return {
    transport,
    connector: newConnector(),
    clock,
    state,
    account,
    conversations,
    upsertConversation: (key, kind) => { conversations.set(key, kind); },
    newConnector,
    close: () => {},
  };
}

let seq = 0;
export function cmd(rig: Pick<ZaloRig, 'account' | 'state'>, over: Partial<ChatDeliveryCommand> = {}): ChatDeliveryCommand {
  seq += 1;
  return {
    kind: 'chat',
    channel: 'zalo',
    clientRequestId: `req-${seq}`,
    accountId: rig.account.id,
    target: { externalConversationKey: 'peer-1' },
    text: `hello ${seq}`,
    purpose: 'care',
    actor: 'manual',
    ownerEpoch: rig.state.epoch,
    adapterRetryToken: `care-token-${seq}-aaaa`,
    ...over,
  };
}

let msgSeq = 0;
/** Raw inbound payload as zca-js delivers it. */
export function rawIn(over: Partial<ZaloRawMessage> & { data?: Partial<ZaloRawMessage['data']> } = {}): ZaloRawMessage {
  msgSeq += 1;
  const { data, ...rest } = over;
  return {
    threadKind: 'user',
    threadId: 'peer-1',
    isSelf: false,
    ...rest,
    data: {
      msgId: String(7_000_000_000_000_000_000n + BigInt(msgSeq)),
      cliMsgId: `cli-in-${msgSeq}`,
      uidFrom: 'peer-1',
      idTo: 'own-uid-1',
      dName: 'Khách',
      ts: String(1_700_000_000_000 + msgSeq * 1000),
      msgType: 'webchat',
      content: `xin chào ${msgSeq}`,
      ...data,
    },
  };
}

export async function expectCode(fn: () => unknown, code: string): Promise<{ status: number; details?: unknown; message: string }> {
  try {
    await fn();
  } catch (e) {
    const err = e as { code?: string; status?: number; details?: unknown; message: string };
    if (err.code !== code) throw new Error(`expected ${code}, got ${String(err.code)}: ${err.message}`);
    return { status: err.status ?? 0, details: err.details, message: err.message };
  }
  throw new Error(`expected ${code}, nothing thrown`);
}

/** What the runtime passes back as `SyncCommand.checkpoint` after storing a returned checkpoint. */
export function resume(cp: CareCheckpoint | undefined): { namespace: NativeCheckpointBox; cursor: string } | undefined {
  return cp ? { namespace: cp.namespace as NativeCheckpointBox, cursor: cp.cursor } : undefined;
}
