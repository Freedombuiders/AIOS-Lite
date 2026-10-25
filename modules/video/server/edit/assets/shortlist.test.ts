import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findAsset } from '../library/store.js';
import { indexQueueIdle } from './indexer.js';
import { buildShortlist, moodsFor, renderShortlistForPrompt } from './shortlist.js';
import { makeHubKit, type HubKit } from './testkit.js';

let kit: HubKit;
beforeEach(() => { kit = makeHubKit({ styleId: 'congnghe' }); });
afterEach(async () => { await indexQueueIdle(); kit.cleanup(); });

describe('moodsFor', () => {
  it('reads the style a template builds on, else the project style, else Tập trung', () => {
    expect(moodsFor('style:giaoduc')).toEqual(['Bình yên', 'Suy tư']);
    expect(moodsFor('style:congnghe', 'kienthuc')).toEqual(['Năng lượng', 'Hồi hộp']);
    // th-vang builds on "kienthuc" (manifest styleId), whatever the project style.
    expect(moodsFor('th-vang', 'congnghe')).toEqual(['Tập trung']);
    expect(moodsFor('khong-co-mau', 'congnghe')).toEqual(['Năng lượng', 'Hồi hộp']);
    expect(moodsFor(undefined, 'khong-co')).toEqual(['Tập trung']);
  });
});

describe('buildShortlist', () => {
  it('lists the owner footage with hints, transcript-matched library, music by template mood and SFX', async () => {
    const own = await kit.addAsset('video', 'quay-ban.mp4', {}, { caption: 'Bàn làm việc gọn gàng' });
    const photo = await kit.addAsset('image', 'logo.png');
    const office = await kit.addAsset('video', 'office.mp4', {}, { caption: 'Văn phòng sáng sủa, máy tính trên bàn', quality: 0.9 });
    await kit.addAsset('video', 'beach.mp4', {}, { caption: 'Bãi biển lúc hoàng hôn' });
    const calm = await kit.addAsset('bgm', 'calm.mp3', { mood: 'Bình yên' });
    const energetic = await kit.addAsset('bgm', 'drive.mp3', { mood: 'Năng lượng' }, { bpm: 128, genre: 'Electronic', vocals: false, beats: [0.5, 1.4], caption: 'Nhạc điện tử nhanh.' });
    const tense = await kit.addAsset('bgm', 'tense.mp3', { mood: 'Hồi hộp' }, { beats: [1] });
    const whoosh = await kit.addAsset('sfx', 'whoosh.mp3', { description: 'Tiếng gió lướt' });
    kit.setQuick({ templateId: 'style:congnghe', assets: [{ assetId: own.id, hint: 'góc làm việc của tôi' }, { assetId: photo.id }, { assetId: 'lib:video:mat-tich' }] });

    const s = await buildShortlist(kit.project.id);
    expect(s.projectAssets).toEqual([
      { assetId: own.id, kind: 'video', hint: 'góc làm việc của tôi', caption: 'Bàn làm việc gọn gàng' },
      { assetId: photo.id, kind: 'image' },
    ]);
    expect(s.library.map((c) => c.ref)).toEqual([office.id]);
    expect(s.library[0]).toMatchObject({ source: 'mine', kind: 'video', caption: 'Văn phòng sáng sủa, máy tính trên bàn', license: { name: 'chưa rõ — do bạn thêm' } });
    expect(s.music.map((c) => c.ref)).toEqual([energetic.id, tense.id, calm.id]);
    expect(s.music[0].caption).toBe('"drive" · Năng lượng, Electronic, 128 BPM, không lời · Nhạc điện tử nhanh.');
    expect(s.sfx.map((c) => c.ref)).toEqual([whoosh.id]);
    expect(s.sfx[0].caption).toBe('whoosh: Tiếng gió lướt');
  });

  it('follows music.mode: the picked track only, or none', async () => {
    const a = await kit.addAsset('bgm', 'a.mp3', { mood: 'Năng lượng' });
    const b = await kit.addAsset('bgm', 'b.mp3', { mood: 'Bình yên' });
    kit.setQuick({ music: { mode: 'pick', assetId: b.id, duck: true, snapToBeat: false, endOnFinal: false } });
    expect((await buildShortlist(kit.project.id)).music.map((c) => c.ref)).toEqual([b.id]);
    kit.setQuick({ music: { mode: 'none', duck: true, snapToBeat: false, endOnFinal: false } });
    expect((await buildShortlist(kit.project.id)).music).toEqual([]);
    expect(a.id).toBeTruthy();
  });

  it('puts the SFX the template names first, and offers none when its density is none', async () => {
    for (const name of ['ding', 'mouse-click', 'pop']) {
      fs.mkdirSync(path.join(kit.root, 'library', 'sfx'), { recursive: true });
      fs.writeFileSync(path.join(kit.root, 'library', 'sfx', `${name}.mp3`), 'x');
    }
    kit.setQuick({ templateId: 'th-vang' });
    expect((await buildShortlist(kit.project.id)).sfx.map((c) => c.ref)).toEqual(['sfx:pop', 'sfx:mouse-click', 'sfx:ding']);
    kit.setQuick({ templateId: 'style:giaoduc' });
    expect((await buildShortlist(kit.project.id)).sfx).toEqual([]);
  });

  it('queues footage without a caption and music without beats for indexing', async () => {
    const own = await kit.addAsset('video', 'raw.mp4');
    kit.setQuick({ assets: [{ assetId: own.id, hint: 'cảnh mở đầu' }] });
    await buildShortlist(kit.project.id);
    await indexQueueIdle();
    expect(findAsset(kit.root, own.id)).toMatchObject({ caption: expect.stringContaining('rót cà phê'), quality: 0.81 });
  });

  it('is empty for an unknown project', async () => {
    expect(await buildShortlist('khong-co')).toEqual({ projectAssets: [], library: [], music: [], sfx: [] });
  });
});

describe('renderShortlistForPrompt', () => {
  it('writes the ids, the owner descriptions, music facts and the query rule', async () => {
    const own = await kit.addAsset('video', 'quay-ban.mp4', {}, { caption: 'Bàn làm việc gọn gàng' });
    await kit.addAsset('bgm', 'drive.mp3', { mood: 'Năng lượng', license: 'CC BY 4.0', attribution: 'Tác giả X' }, { bpm: 128 });
    kit.setQuick({ assets: [{ assetId: own.id, hint: 'góc làm việc của tôi' }] });
    const text = renderShortlistForPrompt(await buildShortlist(kit.project.id));
    expect(text).toContain('## Tư liệu, kho và nhạc');
    expect(text).toContain(`- \`${own.id}\` · video · chủ kênh mô tả: "góc làm việc của tôi" · máy xem: "Bàn làm việc gọn gàng"`);
    expect(text).toMatch(/- `lib:bgm:drive` · 0:08 · "drive" · Năng lượng, 128 BPM · ghi công: Tác giả X/);
    expect(text).toContain('`query`');
    expect(text).toContain('2–4 từ khoá tiếng Anh');
  });

  it('is empty when there is nothing to offer', () => {
    expect(renderShortlistForPrompt({ projectAssets: [], library: [], music: [], sfx: [] })).toBe('');
  });
});
