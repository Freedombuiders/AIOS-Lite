/**
 * Local copies of the images in chat messages. A Zalo attachment only carries a CDN link and Zalo expires those, so each
 * image is fetched once through the account's connector (which owns the host allowlist), sealed with the Care key and
 * kept under <module data dir>/media-cache. The inbox reads the copy afterwards (`GET /messages/:id/media`).
 *
 * A new message is copied right after ingest, so a photo survives even when nobody opened it before the link died;
 * anything the warm-up missed is fetched on first view. Only real image bytes (magic-byte check) are kept and served, a
 * failed fetch is not retried for an hour, and `prune` removes the copy once its message is deleted or redacted.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { CareAttachmentDescriptor, CareMessageRecord } from '../../../_lib/care-kit/types.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import { resolveEncryptionKey, type CareKeyInput } from '../persistence/crypto.js';
import type { CareStores } from '../persistence/index.js';

export const MEDIA_MAX_BYTES = 15 * 1024 * 1024;
/** A failed copy is not fetched again for this long. */
export const MEDIA_RETRY_MS = 60 * 60_000;
const WARM_CONCURRENCY = 2;
const WARM_QUEUE_MAX = 200;
const FAILED_MAX = 5000;
const MAX_INDEX = 99;
const MESSAGE_ID = /^[A-Za-z0-9-]{1,64}$/;
const COPY_FILE = /^([A-Za-z0-9-]{1,64})\.(\d{1,2})\.bin$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface CareMedia {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}

export interface CareMediaCacheDeps {
  dir: string;
  key: CareKeyInput;
  db: Database.Database;
  stores: Pick<CareStores, 'messages' | 'accounts'>;
  connectors: ConnectorRegistry;
  now?: () => number;
  /** A copy that could not be made (logging hook; the error never carries the media URL). */
  onError?: (err: unknown, messageId: string, index: number) => void;
}

/** Image type from the first bytes; null for anything else (the declared mime type is never trusted). */
export function sniffImage(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Attachment `index` of a message when it is a still image (not a voice note); null otherwise. */
export function imageAttachment(msg: Pick<CareMessageRecord, 'metadata'>, index: number): CareAttachmentDescriptor | null {
  const list = (msg.metadata as { attachments?: unknown }).attachments;
  if (!Array.isArray(list)) return null;
  const a = list[index] as Partial<CareAttachmentDescriptor> | null | undefined;
  if (!a || typeof a !== 'object' || a.isVoice === true) return null;
  if (typeof a.id !== 'string' || typeof a.mimeType !== 'string' || !a.mimeType.toLowerCase().startsWith('image/')) return null;
  return a as CareAttachmentDescriptor;
}

// The message id and index are bound in as associated data, so a copy cannot be swapped onto another message.
const aad = (messageId: string, index: number) => Buffer.from(`care-media:${messageId}:${index}`);

function seal(key: Buffer, plain: Buffer, ad: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(ad);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function unseal(key: Buffer, sealed: Buffer, ad: Buffer): Buffer {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error('sealed media is truncated');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV_BYTES));
  decipher.setAAD(ad);
  decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}

export class CareMediaCache {
  private readonly failedAt = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<CareMedia | null>>();
  private readonly queue: Array<{ messageId: string; index: number }> = [];
  private warming = 0;

  constructor(private readonly deps: CareMediaCacheDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private file(messageId: string, index: number): string {
    return path.join(this.deps.dir, `${messageId}.${index}.bin`);
  }

  /** The copy of image `index` of a message, made on first use. Null: not an image, deleted message, or the copy failed. */
  get(msg: CareMessageRecord, index: number): Promise<CareMedia | null> {
    if (!MESSAGE_ID.test(msg.id) || !Number.isInteger(index) || index < 0 || index > MAX_INDEX) return Promise.resolve(null);
    const k = `${msg.id}:${index}`;
    const running = this.inflight.get(k);
    if (running) return running;
    const p = this.load(msg, index).finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  private async load(msg: CareMessageRecord, index: number): Promise<CareMedia | null> {
    const file = this.file(msg.id, index);
    const a = imageAttachment(msg, index);
    if (!a || msg.isDeleted || msg.tombstone) {
      fs.rmSync(file, { force: true });
      return null;
    }
    const key = resolveEncryptionKey(this.deps.key);
    const fileName = a.fileName || '';
    try {
      const bytes = unseal(key, fs.readFileSync(file), aad(msg.id, index));
      const mimeType = sniffImage(bytes);
      if (mimeType) return { bytes, mimeType, fileName };
      fs.rmSync(file, { force: true });
    } catch (err) {
      // No copy yet, or one this key cannot open: make a fresh one.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') fs.rmSync(file, { force: true });
    }

    const k = `${msg.id}:${index}`;
    const failed = this.failedAt.get(k);
    if (failed !== undefined && this.now() - failed < MEDIA_RETRY_MS) return null;
    if (!a.url) return null;
    const account = this.deps.stores.accounts.getAccount(msg.accountId);
    const connector = account ? this.deps.connectors.forAccount(account) : null;
    // The channel module is off: nothing to fetch with right now, and not a failure of this link.
    if (!connector) return null;

    try {
      const res = await connector.fetchAttachment({ accountId: msg.accountId, attachmentId: a.id, mediaUrl: a.url });
      if (res.buffer.length > MEDIA_MAX_BYTES) throw new Error('media is larger than the cache limit');
      const mimeType = sniffImage(res.buffer);
      if (!mimeType) throw new Error('media is not an image');
      fs.mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(tmp, seal(key, res.buffer, aad(msg.id, index)), { mode: 0o600 });
        fs.renameSync(tmp, file);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
      this.failedAt.delete(k);
      return { bytes: res.buffer, mimeType, fileName };
    } catch (err) {
      if (this.failedAt.size >= FAILED_MAX) this.failedAt.delete(this.failedAt.keys().next().value as string);
      this.failedAt.set(k, this.now());
      this.deps.onError?.(err, msg.id, index);
      return null;
    }
  }

  /** Queues a copy of every image of a freshly stored message. Never throws; a full queue leaves the rest to first view. */
  warm(messageId: string): void {
    try {
      const msg = this.deps.stores.messages.getMessage(messageId);
      const list = (msg?.metadata as { attachments?: unknown } | undefined)?.attachments;
      if (!msg || !Array.isArray(list)) return;
      for (let index = 0; index < Math.min(list.length, MAX_INDEX + 1); index++) {
        if (this.queue.length >= WARM_QUEUE_MAX) break;
        if (imageAttachment(msg, index)?.url && !fs.existsSync(this.file(msg.id, index))) this.queue.push({ messageId, index });
      }
      this.pump();
    } catch {
      /* a copy is best effort: ingest never depends on it */
    }
  }

  private pump(): void {
    while (this.warming < WARM_CONCURRENCY && this.queue.length > 0) {
      const { messageId, index } = this.queue.shift()!;
      const msg = this.deps.stores.messages.getMessage(messageId);
      if (!msg) continue;
      this.warming += 1;
      void this.get(msg, index)
        .catch(() => null)
        .finally(() => {
          this.warming -= 1;
          this.pump();
        });
    }
  }

  /** Removes copies whose message is gone, deleted or redacted, and temp files left by a crash. Returns the count removed. */
  prune(): number {
    let names: string[];
    try {
      names = fs.readdirSync(this.deps.dir);
    } catch {
      return 0;
    }
    const live = this.deps.db.prepare('SELECT 1 FROM care_messages WHERE id = ? AND is_deleted = 0 AND tombstone = 0');
    let removed = 0;
    for (const name of names) {
      const full = path.join(this.deps.dir, name);
      const m = COPY_FILE.exec(name);
      try {
        if (m ? live.get(m[1]) : this.now() - fs.statSync(full).mtimeMs < MEDIA_RETRY_MS) continue;
        fs.rmSync(full, { force: true });
        removed += 1;
      } catch {
        /* next pass */
      }
    }
    return removed;
  }
}
