import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CareAttachmentDescriptor, CareMessageRecord } from '../../../_lib/care-kit/types.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import { seed, T0 } from './agent-test-support.js';
import { createTurnMediaSource, isPdfAttachment, NO_TURN_MEDIA, sweepTurnMedia, TURN_MEDIA_STALE_MS, type TurnMediaDeps } from './turn-media.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const PDF = Buffer.from('%PDF-1.4 hoá đơn');

let n = 0;
function msg(attachments: Partial<CareAttachmentDescriptor>[], over: Partial<CareMessageRecord> = {}): CareMessageRecord {
  n += 1;
  return {
    id: `msg-${n}`,
    conversationId: 'c1',
    accountId: 'acc-1',
    senderRole: 'customer',
    direction: 'in',
    isDeleted: false,
    tombstone: false,
    text: '',
    metadata: { type: 'chat', attachments: attachments.map((a, i) => ({ id: `zalo:${n}:${i}`, fileName: '', url: `https://f1.zdn.vn/${n}-${i}`, ...a })) },
    ...over,
  } as CareMessageRecord;
}
const image = () => ({ mimeType: 'image/*' });
const pdf = (fileName = 'scan.pdf') => ({ mimeType: 'application/octet-stream', fileName });

function deps(over: Partial<TurnMediaDeps> & { fetched?: Buffer } = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-media-test-'));
  const fetchAttachment = vi.fn(async () => ({ buffer: over.fetched ?? PDF, mimeType: 'application/octet-stream', fileName: 'x' }));
  const get = vi.fn(async (m: CareMessageRecord, i: number) => ({ bytes: JPEG, mimeType: 'image/jpeg', fileName: `${m.id}:${i}` }));
  const d: TurnMediaDeps = {
    media: { get },
    stores: { accounts: { getAccount: (id: string) => ({ id }) } } as never,
    connectors: { forAccount: () => ({ fetchAttachment }) } as unknown as ConnectorRegistry,
    canRead: () => ({ images: true, documents: true }),
    tmpRoot,
    ...over,
  };
  return { d, get, fetchAttachment, tmpRoot };
}

describe('turn media', () => {
  it('keeps the newest 4 images and 2 PDFs of customer messages, numbered oldest first, in private files removed by cleanup', async () => {
    const { d, get, fetchAttachment, tmpRoot } = deps();
    const oldest = msg([image(), pdf('cu.pdf')]);
    const mine = msg([image()], { senderRole: 'agent', direction: 'out' });
    const deleted = msg([image()], { isDeleted: true });
    const mid = msg([image(), image(), pdf('a.pdf')]);
    const newest = msg([image(), image(), pdf('b.pdf')]);
    const media = await createTurnMediaSource(d)({ agentId: 'zalo-care', messages: [newest, deleted, mid, mine, oldest] });

    expect([...media.attached.entries()]).toEqual([
      [`${mid.id}:0`, 'anh-1.jpg'],
      [`${mid.id}:1`, 'anh-2.jpg'],
      [`${mid.id}:2`, 'tep-1.pdf'],
      [`${newest.id}:0`, 'anh-3.jpg'],
      [`${newest.id}:1`, 'anh-4.jpg'],
      [`${newest.id}:2`, 'tep-2.pdf'],
    ]);
    expect(media.images.map((p) => path.basename(p))).toEqual(['anh-1.jpg', 'anh-2.jpg', 'anh-3.jpg', 'anh-4.jpg']);
    expect(get).toHaveBeenCalledTimes(4);
    expect(fetchAttachment).toHaveBeenCalledWith({ accountId: 'acc-1', attachmentId: `zalo:${mid.id.slice(4)}:2`, mediaUrl: `https://f1.zdn.vn/${mid.id.slice(4)}-2` });
    const dir = path.dirname(media.images[0]);
    expect(path.dirname(dir)).toBe(tmpRoot);
    expect(fs.readFileSync(media.documents[1])).toEqual(PDF);
    expect(fs.statSync(media.images[0]).mode & 0o777).toBe(0o600);

    media.cleanup();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('fetches only what the agent runtime can read', async () => {
    const none = deps({ canRead: () => ({ images: false, documents: false }) });
    expect(await createTurnMediaSource(none.d)({ agentId: 'a', messages: [msg([image(), pdf()])] })).toBe(NO_TURN_MEDIA);
    expect(none.get).not.toHaveBeenCalled();

    const imagesOnly = deps({ canRead: () => ({ images: true, documents: false }) });
    const media = await createTurnMediaSource(imagesOnly.d)({ agentId: 'a', messages: [msg([image(), pdf()])] });
    expect(media.images).toHaveLength(1);
    expect(media.documents).toEqual([]);
    expect(imagesOnly.fetchAttachment).not.toHaveBeenCalled();
    media.cleanup();
  });

  it('leaves out an image the cache could not copy, bytes that are not a PDF and a failed fetch', async () => {
    const onError = vi.fn();
    const { d } = deps({ fetched: Buffer.from('<html>expired</html>'), onError });
    d.media = { get: async () => null };
    const notPdf = await createTurnMediaSource(d)({ agentId: 'a', messages: [msg([image(), pdf()])] });
    expect(notPdf.attached.size).toBe(0);

    d.connectors = { forAccount: () => ({ fetchAttachment: async () => Promise.reject(new Error('Media fetch failed (403)')) }) } as unknown as ConnectorRegistry;
    const failed = await createTurnMediaSource(d)({ agentId: 'a', messages: [msg([pdf()])] });
    expect(failed.attached.size).toBe(0);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('sweeps only stale turn directories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-sweep-test-'));
    const mk = (name: string, ageMs: number) => {
      const full = path.join(root, name);
      fs.mkdirSync(full);
      fs.writeFileSync(path.join(full, 'anh-1.jpg'), JPEG);
      const t = (Date.now() - ageMs) / 1000;
      fs.utimesSync(full, t, t);
      return full;
    };
    const stale = mk('care-turn-old', TURN_MEDIA_STALE_MS + 60_000);
    const live = mk('care-turn-new', 1_000);
    const other = mk('something-else', TURN_MEDIA_STALE_MS * 4);
    expect(sweepTurnMedia(root)).toBe(1);
    expect([fs.existsSync(stale), fs.existsSync(live), fs.existsSync(other)]).toEqual([false, true, true]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('recognises a PDF by type or name only', () => {
    expect(isPdfAttachment({ id: 'a', mimeType: 'application/pdf', fileName: '' })).toBe(true);
    expect(isPdfAttachment({ id: 'a', mimeType: 'application/octet-stream', fileName: 'HOA-DON.PDF' })).toBe(true);
    expect(isPdfAttachment({ id: 'a', mimeType: 'application/octet-stream', fileName: 'bao-gia.docx' })).toBe(false);
    expect(isPdfAttachment({ id: 'a', mimeType: 'audio/*', fileName: 'x.pdf', isVoice: true })).toBe(false);
  });
});

describe('agent turn with attachments', () => {
  const photo = { metadata: { type: 'chat' as const, attachments: [{ id: 'zalo:1', mimeType: 'image/*', fileName: '', url: 'https://f1.zdn.vn/a.jpg' }] }, text: '[Ảnh]' };

  it('hands the files to the runner, names them in the transcript, and cleans up after the call', async () => {
    const s = seed({ messages: [photo, { text: 'shop xem giúp em máy lỗi gì' }] });
    const cleanup = vi.fn();
    const turnMedia = vi.fn(async () => ({ attached: new Map([[`${s.messageIds[0]}:0`, 'anh-1.jpg']]), images: ['/tmp/t/anh-1.jpg'], documents: ['/tmp/t/tep-1.pdf'], cleanup }));
    const out = await s.turn({ turnMedia }).run({ conversationId: s.conversationId, triggerMessageId: s.triggerId });

    expect(out.status).toBe('drafted');
    expect(turnMedia).toHaveBeenCalledWith({ agentId: 'cskh', messages: [expect.objectContaining({ id: s.messageIds[0] })] });
    const req = s.runner.requests[0];
    expect(req.images).toEqual(['/tmp/t/anh-1.jpg']);
    expect(req.documents).toEqual(['/tmp/t/tep-1.pdf']);
    expect(req.prompt).toContain('[attachment: file (image/*) - attached as anh-1.jpg]');
    expect(req.prompt).toContain('Tệp đính kèm: <tên>');
    expect(req.prompt).not.toContain('- content not available to you]');
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('a media failure never blocks the reply: the transcript keeps saying the content is unavailable', async () => {
    const s = seed({ messages: [photo, { text: 'ảnh đây ạ' }], nowMs: T0 });
    const out = await s.turn({ turnMedia: async () => Promise.reject(new Error('boom')) }).run({ conversationId: s.conversationId, triggerMessageId: s.triggerId });
    expect(out.status).toBe('drafted');
    const req = s.runner.requests[0];
    expect(req.images).toBeUndefined();
    expect(req.prompt).toContain('[attachment: file (image/*) - content not available to you]');
    expect(req.prompt).not.toContain('Tệp đính kèm: <tên>');
  });

  it('is not asked at all when the context has no attachment', async () => {
    const s = seed();
    const turnMedia = vi.fn();
    await s.turn({ turnMedia }).run({ conversationId: s.conversationId, triggerMessageId: s.triggerId });
    expect(turnMedia).not.toHaveBeenCalled();
  });
});
