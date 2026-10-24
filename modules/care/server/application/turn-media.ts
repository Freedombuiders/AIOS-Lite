/**
 * The customer's images and PDFs for one agent turn. The model gets copies in a private temp directory, named by kind
 * and order (anh-1.jpg, tep-1.pdf); the transcript refers to each attachment by that name, and the directory is removed
 * when the turn ends.
 *
 * Images come through the media cache (fetched once, the sealed copy reused); a PDF is fetched through the account's
 * connector, which owns the host allowlist. Only real bytes count (magic-byte check), and only what the agent's runtime
 * can read is fetched at all, so the transcript never claims an attachment the model cannot see.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CareAttachmentDescriptor, CareMessageRecord } from '../../../_lib/care-kit/types.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import type { CareStores } from '../persistence/index.js';
import { imageAttachment, type CareMediaCache } from './media-cache.js';

export const TURN_MAX_IMAGES = 4;
export const TURN_MAX_DOCUMENTS = 2;
/** Provider limits: 5 MB per image; a PDF is kept well under the 32 MB request cap. */
export const TURN_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const TURN_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
/** No new fetch starts after this long; the turn goes ahead with what it has. */
const FETCH_BUDGET_MS = 30_000;
const DIR_PREFIX = 'care-turn-';
/** A live turn never keeps its directory this long (fetch budget + model timeout). */
export const TURN_MEDIA_STALE_MS = 15 * 60_000;

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

export interface TurnMedia {
  /** `${messageId}:${attachmentIndex}` -> file name the model sees. */
  attached: ReadonlyMap<string, string>;
  images: string[];
  documents: string[];
  cleanup(): void;
}

export const NO_TURN_MEDIA: TurnMedia = Object.freeze({ attached: new Map<string, string>(), images: [], documents: [], cleanup: () => {} });

/** `messages` newest first; only customer messages are looked at. */
export type TurnMediaSource = (input: { agentId: string; messages: readonly CareMessageRecord[] }) => Promise<TurnMedia>;

export interface TurnMediaDeps {
  media: Pick<CareMediaCache, 'get'>;
  stores: Pick<CareStores, 'accounts'>;
  connectors: ConnectorRegistry;
  /** What the agent's runtime can read. */
  canRead: (agentId: string) => { images: boolean; documents: boolean };
  tmpRoot?: string;
  now?: () => number;
  /** A PDF that could not be fetched (logging hook). */
  onError?: (err: unknown, messageId: string, index: number) => void;
}

/** A PDF by declared type or name (Zalo sends files as application/octet-stream); the bytes are checked after the fetch. */
export function isPdfAttachment(a: Partial<CareAttachmentDescriptor> | null | undefined): a is CareAttachmentDescriptor {
  if (!a || typeof a !== 'object' || typeof a.id !== 'string' || a.isVoice === true) return false;
  return a.mimeType?.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(a.fileName ?? '');
}

const isPdf = (b: Buffer) => b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-';

interface Candidate {
  msg: CareMessageRecord;
  index: number;
  kind: 'image' | 'document';
}

export function createTurnMediaSource(deps: TurnMediaDeps): TurnMediaSource {
  const now = deps.now ?? Date.now;

  async function image(p: Candidate): Promise<{ bytes: Buffer; ext: string } | null> {
    const copy = await deps.media.get(p.msg, p.index);
    if (!copy || copy.bytes.length > TURN_IMAGE_MAX_BYTES || !EXT[copy.mimeType]) return null;
    return { bytes: copy.bytes, ext: EXT[copy.mimeType] };
  }

  async function document(p: Candidate): Promise<{ bytes: Buffer; ext: string } | null> {
    const a = (p.msg.metadata.attachments ?? [])[p.index];
    const account = deps.stores.accounts.getAccount(p.msg.accountId);
    const connector = account ? deps.connectors.forAccount(account) : null;
    if (!a || !connector) return null;
    try {
      const res = await connector.fetchAttachment({ accountId: p.msg.accountId, attachmentId: a.id, ...(a.url ? { mediaUrl: a.url } : {}) });
      return res.buffer.length <= TURN_DOCUMENT_MAX_BYTES && isPdf(res.buffer) ? { bytes: res.buffer, ext: 'pdf' } : null;
    } catch (err) {
      deps.onError?.(err, p.msg.id, p.index);
      return null;
    }
  }

  return async ({ agentId, messages }) => {
    const can = deps.canRead(agentId);
    if (!can.images && !can.documents) return NO_TURN_MEDIA;

    // Newest first, so the caps keep the latest; numbered oldest first afterwards.
    const picks: Candidate[] = [];
    let images = 0;
    let documents = 0;
    for (const msg of messages) {
      if (msg.senderRole !== 'customer' || msg.isDeleted || msg.tombstone) continue;
      const list = msg.metadata.attachments ?? [];
      for (let index = list.length - 1; index >= 0; index--) {
        if (can.images && images < TURN_MAX_IMAGES && imageAttachment(msg, index)) {
          picks.push({ msg, index, kind: 'image' });
          images += 1;
        } else if (can.documents && documents < TURN_MAX_DOCUMENTS && isPdfAttachment(list[index])) {
          picks.push({ msg, index, kind: 'document' });
          documents += 1;
        }
      }
    }
    if (picks.length === 0) return NO_TURN_MEDIA;
    picks.reverse();

    let dir: string | undefined;
    const cleanup = () => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    };
    const attached = new Map<string, string>();
    const out = { image: [] as string[], document: [] as string[] };
    const deadline = now() + FETCH_BUDGET_MS;
    try {
      for (const p of picks) {
        if (now() > deadline) break;
        const file = p.kind === 'image' ? await image(p) : await document(p);
        if (!file) continue;
        dir ??= fs.mkdtempSync(path.join(deps.tmpRoot ?? os.tmpdir(), DIR_PREFIX));
        const name = `${p.kind === 'image' ? 'anh' : 'tep'}-${out[p.kind].length + 1}.${file.ext}`;
        const full = path.join(dir, name);
        fs.writeFileSync(full, file.bytes, { mode: 0o600 });
        out[p.kind].push(full);
        attached.set(`${p.msg.id}:${p.index}`, name);
      }
    } catch (err) {
      cleanup();
      throw err;
    }
    return { attached, images: out.image, documents: out.document, cleanup };
  };
}

/** Removes turn directories a crashed or restarted process left behind. Returns the count removed. */
export function sweepTurnMedia(tmpRoot = os.tmpdir(), nowMs = Date.now()): number {
  let names: string[];
  try {
    names = fs.readdirSync(tmpRoot);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(DIR_PREFIX)) continue;
    const full = path.join(tmpRoot, name);
    try {
      const st = fs.lstatSync(full);
      if (!st.isDirectory() || nowMs - st.mtimeMs < TURN_MEDIA_STALE_MS) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* next pass */
    }
  }
  return removed;
}
