/**
 * Registry of channel connectors. Channel modules (zalo, gmail, ...) register a CareConnector from the care-kit
 * contract; care never imports their code. Optional hooks a connector may add on top of the contract are typed here.
 */
import type { CareConnector, SyncResult } from '../../../_lib/care-kit/contract.js';
import type { CareAccountRecord } from '../../../_lib/care-kit/types.js';

/** A person or group as the channel shows it. Empty strings when unknown. */
export interface CareConnectorPerson {
  name: string;
  avatarUrl: string;
}

export interface CareConnectorProfiles {
  thread: CareConnectorPerson;
  /** By native sender ID (an identity's `externalIdentityId`). */
  senders: Record<string, CareConnectorPerson>;
}

export interface CareConnectorExt extends CareConnector {
  /** true => the care worker polls `sync()` for this connector's accounts (default: the channel pushes via careChannels.ingest). */
  readonly careManagedSync?: boolean;
  /** Called after every event of a sync page was durably ingested (ack the live feed, advance connector-local state). */
  commitSync?(accountId: string, result: SyncResult, outcome: { failedEventIds: string[] }): void | Promise<void>;
  /** Names and avatars of one conversation and its senders, for display only. May ask the provider; null = unknown. */
  profiles?(accountId: string, conversationKey: string, senderKeys: string[]): Promise<CareConnectorProfiles | null>;
  /** Picture of a conversation from what the channel already stored (inbox list rows): never a provider call. */
  storedAvatarUrl?(accountId: string, conversationKey: string): string | null;
}

export interface ConnectorRegistry {
  forAccount(account: CareAccountRecord): CareConnectorExt | null | undefined;
}

export interface MutableConnectorRegistry extends ConnectorRegistry {
  register(connector: CareConnectorExt): void;
  unregister(id: string): void;
  list(): CareConnectorExt[];
}

/** Connectors are keyed by `connector.kind`. An account resolves by (channel, connectorKind), then by channel alone. */
export function createConnectorRegistry(): MutableConnectorRegistry {
  const byKind = new Map<string, CareConnectorExt>();
  return {
    register(connector) {
      byKind.set(connector.kind, connector);
    },
    unregister(id) {
      byKind.delete(id);
    },
    list: () => [...byKind.values()],
    forAccount(account) {
      const exact = byKind.get(account.connectorKind);
      if (exact && exact.channel === account.channel) return exact;
      for (const c of byKind.values()) if (c.channel === account.channel) return c;
      return null;
    },
  };
}
