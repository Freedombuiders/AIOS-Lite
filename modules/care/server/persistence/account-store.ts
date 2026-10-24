/**
 * Care account store. Defaults are inactive: desired_state 'paused', every flag off,
 * write owner 'legacy'. Labels and health notes are encrypted at rest.
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  CareAccountDesiredState,
  CareAccountHealth,
  CareAccountRecord,
  CareChannel,
  CareWriteOwner,
} from '../../../_lib/care-kit/types.js';
import {
  CARE_CHANNELS,
  CARE_DESIRED_STATES,
  CARE_HEALTH_STATES,
  CARE_WRITE_OWNERS,
  oneOf,
  requireNonEmptyString,
  requireSafeInteger,
} from '../../../_lib/care-kit/validation.js';
import { decryptNullable, encryptCareField, type CareKeyInput } from './crypto.js';

export class CareAccountStore {
  constructor(
    private readonly db: Database.Database,
    private readonly key?: CareKeyInput,
  ) {}

  createAccount(input: {
    id?: string;
    channel: CareChannel;
    connectorKind: string;
    nativeAccountId: string;
    label: string;
    credentialRef?: string | null;
    desiredState?: CareAccountDesiredState;
    healthStatus?: CareAccountHealth;
    syncEnabled?: boolean;
    sendEnabled?: boolean;
    aiEnabled?: boolean;
    writeOwner?: CareWriteOwner;
    ownerEpoch?: number;
  }): CareAccountRecord {
    const id = input.id ?? crypto.randomUUID();
    const channel = oneOf(CARE_CHANNELS, input.channel, 'channel');
    const connectorKind = requireNonEmptyString(input.connectorKind, 'connectorKind', 128);
    const nativeAccountId = requireNonEmptyString(input.nativeAccountId, 'nativeAccountId', 512);
    const label = requireNonEmptyString(input.label, 'label', 512);
    const desiredState = oneOf(CARE_DESIRED_STATES, input.desiredState ?? 'paused', 'desiredState');
    const health = oneOf(CARE_HEALTH_STATES, input.healthStatus ?? 'healthy', 'healthStatus');
    const writeOwner = oneOf(CARE_WRITE_OWNERS, input.writeOwner ?? 'legacy', 'writeOwner');
    const ownerEpoch = requireSafeInteger(input.ownerEpoch ?? 1, 'ownerEpoch', 1);
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO care_accounts (
           id, channel, connector_kind, native_account_id, label_enc, credential_ref,
           desired_state, health_status, sync_enabled, send_enabled, ai_enabled,
           write_owner, owner_epoch, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        channel,
        connectorKind,
        nativeAccountId,
        encryptCareField(label, this.key),
        input.credentialRef ?? null,
        desiredState,
        health,
        input.syncEnabled ? 1 : 0,
        input.sendEnabled ? 1 : 0,
        input.aiEnabled ? 1 : 0,
        writeOwner,
        ownerEpoch,
        now,
        now,
      );

    return this.getAccount(id)!;
  }

  getAccount(id: string): CareAccountRecord | null {
    const row = this.db.prepare('SELECT * FROM care_accounts WHERE id = ?').get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  getAccountByNative(channel: CareChannel, connectorKind: string, nativeAccountId: string): CareAccountRecord | null {
    const row = this.db
      .prepare('SELECT * FROM care_accounts WHERE channel = ? AND connector_kind = ? AND native_account_id = ?')
      .get(channel, connectorKind, nativeAccountId) as any;
    return row ? this.mapRow(row) : null;
  }

  listAccounts(channel?: CareChannel): CareAccountRecord[] {
    const rows = (
      channel
        ? this.db.prepare('SELECT * FROM care_accounts WHERE channel = ? ORDER BY created_at ASC, id ASC').all(channel)
        : this.db.prepare('SELECT * FROM care_accounts ORDER BY created_at ASC, id ASC').all()
    ) as any[];
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Single-statement partial update (no read-modify-write race across handles).
   * `healthNote` is the operator-facing detail and is encrypted; pass null to clear it.
   */
  updateAccountFlags(
    id: string,
    flags: {
      syncEnabled?: boolean;
      sendEnabled?: boolean;
      aiEnabled?: boolean;
      desiredState?: CareAccountDesiredState;
      healthStatus?: CareAccountHealth;
      healthNote?: string | null;
    },
  ): boolean {
    const desired = flags.desiredState === undefined ? null : oneOf(CARE_DESIRED_STATES, flags.desiredState, 'desiredState');
    const health = flags.healthStatus === undefined ? null : oneOf(CARE_HEALTH_STATES, flags.healthStatus, 'healthStatus');
    const bool = (v: boolean | undefined) => (v === undefined ? null : v ? 1 : 0);
    const setNote = flags.healthNote !== undefined;
    const noteEnc = setNote && flags.healthNote !== null ? encryptCareField(String(flags.healthNote).slice(0, 1000), this.key) : null;

    const res = this.db
      .prepare(
        `UPDATE care_accounts SET
           sync_enabled    = COALESCE(?, sync_enabled),
           send_enabled    = COALESCE(?, send_enabled),
           ai_enabled      = COALESCE(?, ai_enabled),
           desired_state   = COALESCE(?, desired_state),
           health_status   = COALESCE(?, health_status),
           health_note_enc = CASE WHEN ? = 1 THEN ? ELSE health_note_enc END,
           updated_at      = ?
         WHERE id = ?`,
      )
      .run(
        bool(flags.syncEnabled),
        bool(flags.sendEnabled),
        bool(flags.aiEnabled),
        desired,
        health,
        setNote ? 1 : 0,
        noteEnc,
        Date.now(),
        id,
      );
    return res.changes > 0;
  }

  /**
   * Bridge only: refresh the descriptive fields of a bridged account (label, native ID once the
   * provider assigns one, credential REFERENCE). Never touches gates, owner or epoch.
   */
  updateAccountDescriptor(
    id: string,
    patch: { label?: string; nativeAccountId?: string; credentialRef?: string | null },
  ): boolean {
    const label = patch.label === undefined ? null : requireNonEmptyString(patch.label, 'label', 512);
    const native = patch.nativeAccountId === undefined ? null : requireNonEmptyString(patch.nativeAccountId, 'nativeAccountId', 512);
    const setRef = patch.credentialRef !== undefined;
    const res = this.db
      .prepare(
        `UPDATE care_accounts SET
           label_enc = COALESCE(?, label_enc),
           native_account_id = COALESCE(?, native_account_id),
           credential_ref = CASE WHEN ? = 1 THEN ? ELSE credential_ref END,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(label === null ? null : encryptCareField(label, this.key), native, setRef ? 1 : 0, patch.credentialRef ?? null, Date.now(), id);
    return res.changes > 0;
  }

  /** Strictly monotonic: the epoch only ever moves forward. */
  updateAccountOwnerEpoch(id: string, writeOwner: CareWriteOwner, newEpoch: number): boolean {
    const owner = oneOf(CARE_WRITE_OWNERS, writeOwner, 'writeOwner');
    const epoch = requireSafeInteger(newEpoch, 'newEpoch', 1);
    const res = this.db
      .prepare(
        `UPDATE care_accounts
         SET write_owner = ?, owner_epoch = ?, updated_at = ?
         WHERE id = ? AND owner_epoch < ?`,
      )
      .run(owner, epoch, Date.now(), id, epoch);
    return res.changes > 0;
  }

  private mapRow(row: any): CareAccountRecord {
    return {
      id: row.id,
      channel: row.channel,
      connectorKind: row.connector_kind,
      nativeAccountId: row.native_account_id,
      label: decryptNullable(row.label_enc, this.key) ?? '',
      credentialRef: row.credential_ref,
      desiredState: row.desired_state,
      healthStatus: row.health_status,
      healthNote: decryptNullable(row.health_note_enc, this.key),
      syncEnabled: Boolean(row.sync_enabled),
      sendEnabled: Boolean(row.send_enabled),
      aiEnabled: Boolean(row.ai_enabled),
      writeOwner: row.write_owner,
      ownerEpoch: Number(row.owner_epoch),
      createdAtMs: Number(row.created_at),
      updatedAtMs: Number(row.updated_at),
    };
  }
}

