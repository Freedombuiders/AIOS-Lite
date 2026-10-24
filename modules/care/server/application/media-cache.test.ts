import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CareAttachmentDescriptor, CareMessageRecord } from '../../../_lib/care-kit/types.js';
import { createTestCareDatabase, type CareStores } from '../persistence/index.js';
import { TEST_KEY, chatMessage } from '../test-fixtures.js';
import { T0, wrapApi, zaloAccount, type ApiFixture } from '../api/test-helpers.js';
import { CareMediaCache, MEDIA_RETRY_MS, sniffImage } from './media-cache.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png body')]);
const PHOTO: CareAttachmentDescriptor = { id: 'zalo:1', mimeType: 'image/*', fileName: 'Ảnh khách gửi', url: 'https://photo-stal-1.zdn.vn/a.jpg' };

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup(fetched: () => Buffer = () => PNG) {
  const t = createTestCareDatabase(':memory:', TEST_KEY);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'care-media-'));
  cleanups.push(() => {
    t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const account = zaloAccount(t.stores);
  const conv = t.stores.conversations.upsertConversation({ accountId: account.id, externalKey: 'peer:1', kind: 'direct', title: 'Khách' });
  const fetchAttachment = vi.fn(async () => ({ buffer: fetched(), mimeType: 'image/jpg', fileName: 'x' }));
  const clock = { now: T0 };
  const cache = new CareMediaCache({
    dir,
    key: TEST_KEY,
    db: t.rawDbForTestIsolationOnly,
    stores: t.stores,
    connectors: { forAccount: () => ({ fetchAttachment }) as never },
    now: () => clock.now,
  });
  const add = (attachments: CareAttachmentDescriptor[]): CareMessageRecord =>
    t.stores.messages.insertMessage(chatMessage(account, { metadata: { type: 'chat', conversationKind: 'direct', attachments } }), conv.id);
  return { t, dir, account, cache, fetchAttachment, clock, add };
}

describe('sniffImage', () => {
  it('names real image bytes and refuses everything else', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a....'))).toBe('image/gif');
    expect(sniffImage(Buffer.from('<html>not an image</html>'))).toBeNull();
  });
});

describe('CareMediaCache', () => {
  it('copies an image once through the connector, sealed on disk, and serves the copy afterwards', async () => {
    const { cache, fetchAttachment, add, dir, account } = setup();
    const msg = add([PHOTO]);

    expect(await cache.get(msg, 0)).toEqual({ bytes: PNG, mimeType: 'image/png', fileName: 'Ảnh khách gửi' });
    expect(fetchAttachment).toHaveBeenCalledWith({ accountId: account.id, attachmentId: 'zalo:1', mediaUrl: PHOTO.url });
    const stored = fs.readFileSync(path.join(dir, `${msg.id}.0.bin`));
    expect(stored.includes(Buffer.from('fake png body'))).toBe(false);

    expect((await cache.get(msg, 0))?.bytes).toEqual(PNG);
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
  });

  it('keeps nothing that is not an image and waits an hour before trying that link again', async () => {
    const { cache, fetchAttachment, add, clock } = setup(() => Buffer.from('<html>expired</html>'));
    const msg = add([PHOTO]);

    expect(await cache.get(msg, 0)).toBeNull();
    expect(await cache.get(msg, 0)).toBeNull();
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
    clock.now += MEDIA_RETRY_MS;
    expect(await cache.get(msg, 0)).toBeNull();
    expect(fetchAttachment).toHaveBeenCalledTimes(2);
  });

  it('never fetches a non-image attachment, a voice note or an index that does not exist', async () => {
    const { cache, fetchAttachment, add } = setup();
    const msg = add([{ ...PHOTO, mimeType: 'application/pdf' }, { ...PHOTO, id: 'zalo:2', mimeType: 'image/*', isVoice: true }]);
    expect(await cache.get(msg, 0)).toBeNull();
    expect(await cache.get(msg, 1)).toBeNull();
    expect(await cache.get(msg, 2)).toBeNull();
    expect(fetchAttachment).not.toHaveBeenCalled();
  });

  it('does not serve a copy moved onto another message', async () => {
    const { cache, fetchAttachment, add, dir } = setup();
    const a = add([PHOTO]);
    const b = add([{ ...PHOTO, id: 'zalo:2' }]);
    await cache.get(a, 0);
    fs.copyFileSync(path.join(dir, `${a.id}.0.bin`), path.join(dir, `${b.id}.0.bin`));

    await cache.get(b, 0);
    expect(fetchAttachment).toHaveBeenCalledTimes(2); // the swapped file failed authentication and was fetched fresh
  });

  it('warms the images of a stored message and prunes the copies of deleted messages', async () => {
    const { cache, fetchAttachment, add, dir, t, clock } = setup();
    const kept = add([PHOTO]);
    const gone = add([PHOTO]);
    cache.warm(kept.id);
    cache.warm(gone.id);
    await vi.waitFor(() => expect(fs.readdirSync(dir).sort()).toEqual([`${gone.id}.0.bin`, `${kept.id}.0.bin`].sort()));
    expect(fetchAttachment).toHaveBeenCalledTimes(2);

    t.stores.messages.softDeleteMessage(gone.id);
    fs.writeFileSync(path.join(dir, 'left-by-a-crash.tmp'), 'x');
    expect(cache.prune()).toBe(1); // the temp file is young: kept for now
    clock.now = Date.now() + MEDIA_RETRY_MS + 1_000;
    expect(cache.prune()).toBe(1);
    expect(fs.readdirSync(dir)).toEqual([`${kept.id}.0.bin`]);
  });
});

describe('GET /messages/:id/media', () => {
  let api: ApiFixture | null = null;
  afterEach(() => {
    api?.close();
    api = null;
  });

  function mount(stores: CareStores, db: Parameters<typeof wrapApi>[1], cache?: CareMediaCache) {
    api = wrapApi(stores, db, cache ? { media: cache } : {});
    return api;
  }

  it('serves the stored image with its sniffed type and safe headers', async () => {
    const { t, cache, add } = setup();
    const msg = add([PHOTO]);
    const res = await mount(t.stores, t.rawDbForTestIsolationOnly, cache).get(`/api/m/care/messages/${msg.id}/media?i=0`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it('answers 404 for an unreadable source, a missing image, an unknown message, or no media store', async () => {
    const { t, cache, add, account } = setup();
    const msg = add([PHOTO, { ...PHOTO, id: 'zalo:doc', mimeType: 'application/pdf' }]);
    const a = mount(t.stores, t.rawDbForTestIsolationOnly, cache);
    expect((await a.get(`/api/m/care/messages/${msg.id}/media?i=1`)).status).toBe(404);
    expect((await a.get('/api/m/care/messages/no-such-message/media?i=0')).status).toBe(404);
    expect((await a.get(`/api/m/care/messages/${msg.id}/media?i=x`)).status).toBe(400);
    a.close();

    api = wrapApi(t.stores, t.rawDbForTestIsolationOnly, { media: cache, canReadSource: (id) => id !== account.id });
    expect((await api.get(`/api/m/care/messages/${msg.id}/media?i=0`)).status).toBe(404);
    api.close();

    api = mount(t.stores, t.rawDbForTestIsolationOnly);
    expect((await api.get(`/api/m/care/messages/${msg.id}/media?i=0`)).status).toBe(404);
  });
});
