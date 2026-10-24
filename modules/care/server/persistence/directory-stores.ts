/**
 * Customer + identity stores. Customer attributes (name, company, phone, email, tags) and
 * identity display attributes (name, username, avatar) are encrypted at rest; only stage,
 * owner label and lookup keys stay plaintext.
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { CareError } from '../../../_lib/care-kit/errors.js';
import type { CareCustomerRecord, CareIdentityRecord, CareStage } from '../../../_lib/care-kit/types.js';
import { CARE_STAGES, oneOf, requireNonEmptyString } from '../../../_lib/care-kit/validation.js';
import { decryptNullable, encryptNullable, type CareKeyInput } from './crypto.js';
import { requireAccountRow, requireCustomerExists } from './shared.js';

export class CareCustomerStore {
  constructor(
    private readonly db: Database.Database,
    private readonly key?: CareKeyInput,
  ) {}

  createCustomer(
    input: {
      displayName: string;
      company?: string | null;
      phone?: string | null;
      email?: string | null;
      stage?: CareStage;
      tags?: string | null;
      owner?: string | null;
    },
    customId?: string,
  ): CareCustomerRecord {
    const id = customId ?? crypto.randomUUID();
    const displayName = requireNonEmptyString(input.displayName, 'displayName', 512);
    const stage = oneOf(CARE_STAGES, input.stage ?? 'new', 'stage');
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO care_customers (
           id, display_name_enc, company_enc, phone_enc, email_enc, stage, tags_enc, owner,
           revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        encryptNullable(displayName, this.key),
        encryptNullable(input.company, this.key),
        encryptNullable(input.phone, this.key),
        encryptNullable(input.email, this.key),
        stage,
        encryptNullable(input.tags, this.key),
        input.owner ?? null,
        now,
        now,
      );

    return this.getCustomer(id)!;
  }

  getCustomer(id: string): CareCustomerRecord | null {
    const row = this.db.prepare('SELECT * FROM care_customers WHERE id = ?').get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  /** Compare-and-set on `revision` (when `expectedRevision` is given) inside one transaction. */
  updateCustomer(
    id: string,
    patch: Partial<Omit<CareCustomerRecord, 'id' | 'createdAtMs' | 'updatedAtMs' | 'revision'>>,
    expectedRevision?: number,
  ): CareCustomerRecord {
    const run = this.db.transaction(() => {
      const current = this.getCustomer(id);
      if (!current) throw new CareError('NOT_FOUND', `Customer not found: ${id}`, 404);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new CareError(
          'STALE_REVISION',
          `Customer revision mismatch. Expected ${expectedRevision}, but found ${current.revision}`,
          409,
        );
      }

      const name = patch.displayName !== undefined ? requireNonEmptyString(patch.displayName, 'displayName', 512) : current.displayName;
      const stage = patch.stage !== undefined ? oneOf(CARE_STAGES, patch.stage, 'stage') : current.stage;
      const pick = <T>(next: T | undefined, prev: T): T => (next !== undefined ? next : prev);

      this.db
        .prepare(
          `UPDATE care_customers
           SET display_name_enc = ?, company_enc = ?, phone_enc = ?, email_enc = ?, stage = ?,
               tags_enc = ?, owner = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(
          encryptNullable(name, this.key),
          encryptNullable(pick(patch.company, current.company), this.key),
          encryptNullable(pick(patch.phone, current.phone), this.key),
          encryptNullable(pick(patch.email, current.email), this.key),
          stage,
          encryptNullable(pick(patch.tags, current.tags), this.key),
          pick(patch.owner, current.owner),
          Date.now(),
          id,
          current.revision,
        );
      return this.getCustomer(id)!;
    });
    return run();
  }

  /** Newest first; capped. Decrypts every returned row, so keep pages small. */
  listCustomers(limit = 100): CareCustomerRecord[] {
    const capped = Math.min(Math.max(Math.trunc(limit) || 1, 1), 500);
    const rows = this.db
      .prepare('SELECT * FROM care_customers ORDER BY updated_at DESC, id DESC LIMIT ?')
      .all(capped) as any[];
    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(row: any): CareCustomerRecord {
    return {
      id: row.id,
      displayName: decryptNullable(row.display_name_enc, this.key) ?? '',
      company: decryptNullable(row.company_enc, this.key),
      phone: decryptNullable(row.phone_enc, this.key),
      email: decryptNullable(row.email_enc, this.key),
      stage: row.stage,
      tags: decryptNullable(row.tags_enc, this.key),
      owner: row.owner,
      revision: Number(row.revision),
      createdAtMs: Number(row.created_at),
      updatedAtMs: Number(row.updated_at),
    };
  }
}

export class CareIdentityStore {
  constructor(
    private readonly db: Database.Database,
    private readonly key?: CareKeyInput,
  ) {}

  createIdentity(
    input: {
      customerId: string;
      accountId: string;
      namespace: string;
      externalIdentityId: string;
      displayName?: string | null;
      username?: string | null;
      avatarUrl?: string | null;
      verified?: boolean;
    },
    customId?: string,
  ): CareIdentityRecord {
    const id = customId ?? crypto.randomUUID();
    requireAccountRow(this.db, input.accountId);
    requireCustomerExists(this.db, input.customerId);
    const namespace = requireNonEmptyString(input.namespace, 'namespace', 64);
    const external = requireNonEmptyString(input.externalIdentityId, 'externalIdentityId', 512);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO care_identities (
           id, customer_id, account_id, namespace, external_identity_id,
           display_name_enc, username_enc, avatar_url_enc, verified, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.customerId,
        input.accountId,
        namespace,
        external,
        encryptNullable(input.displayName, this.key),
        encryptNullable(input.username, this.key),
        encryptNullable(input.avatarUrl, this.key),
        input.verified ? 1 : 0,
        now,
        now,
      );

    return this.getIdentity(id)!;
  }

  getIdentity(id: string): CareIdentityRecord | null {
    const row = this.db.prepare('SELECT * FROM care_identities WHERE id = ?').get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  getIdentityByExternal(accountId: string, namespace: string, externalIdentityId: string): CareIdentityRecord | null {
    const row = this.db
      .prepare('SELECT * FROM care_identities WHERE account_id = ? AND namespace = ? AND external_identity_id = ?')
      .get(accountId, namespace, externalIdentityId) as any;
    return row ? this.mapRow(row) : null;
  }

  listIdentitiesByCustomer(customerId: string): CareIdentityRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM care_identities WHERE customer_id = ? ORDER BY created_at ASC, id ASC')
      .all(customerId) as any[];
    return rows.map((r) => this.mapRow(r));
  }

  /** Re-points an identity at an existing customer. Both must exist; the account never changes. */
  linkIdentity(identityId: string, targetCustomerId: string): boolean {
    requireCustomerExists(this.db, targetCustomerId);
    const res = this.db
      .prepare('UPDATE care_identities SET customer_id = ?, updated_at = ? WHERE id = ?')
      .run(targetCustomerId, Date.now(), identityId);
    return res.changes > 0;
  }

  private mapRow(row: any): CareIdentityRecord {
    return {
      id: row.id,
      customerId: row.customer_id,
      accountId: row.account_id,
      namespace: row.namespace,
      externalIdentityId: row.external_identity_id,
      displayName: decryptNullable(row.display_name_enc, this.key),
      username: decryptNullable(row.username_enc, this.key),
      avatarUrl: decryptNullable(row.avatar_url_enc, this.key),
      verified: Boolean(row.verified),
      createdAtMs: Number(row.created_at),
      updatedAtMs: Number(row.updated_at),
    };
  }
}
