import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findAsset } from '../library/store.js';
import { setAssetHubDeps } from './hub.js';
import { searchAssets } from './providers.js';
import { resolveBrolls } from './resolve.js';
import { broll, makeHubKit, pexelsPhoto, pexelsVideo, scoredCaptions, type HubKit } from './testkit.js';

let kit: HubKit;
beforeEach(() => { kit = makeHubKit(); });
afterEach(() => kit.cleanup());

const coffee = { description: 'Cận cảnh rót cà phê buổi sáng', keywords: ['pouring coffee', 'morning'] };
const scoreTurns = () => kit.turns.filter((t) => t.title.startsWith('Chấm cảnh trám'));

describe('searchAssets', () => {
  it('keeps vertical 9:16 stock between 1 and 30 s and attaches the licence', async () => {
    kit.pexels.videos = [
      pexelsVideo(1, 'pouring-coffee', 8),
      pexelsVideo(2, 'coffee-landscape', 8, 1920, 1080),
      pexelsVideo(3, 'coffee-long', 45),
      pexelsVideo(4, 'coffee-blink', 0.6),
      pexelsVideo(5, 'coffee-four-five', 8, 1080, 1350),
    ];
    kit.pexels.photos = [pexelsPhoto(9, 'Cup of coffee'), pexelsPhoto(10, 'Wide desk', 1600, 900)];
    const { candidates, notes } = await searchAssets({ keywords: coffee.keywords, description: coffee.description, aspect: '9:16' });
    expect(notes).toEqual([]);
    expect(candidates.map((c) => c.ref)).toEqual(['pexels:video:1', 'pexels:photo:9']);
    expect(candidates[0]).toMatchObject({
      source: 'pexels', kind: 'video', caption: 'pouring coffee', durationSec: 8, width: 1080, height: 1920,
      license: { name: 'Pexels License', creator: 'Ana Lee', sourceUrl: 'https://www.pexels.com/video/pouring-coffee-1/', attributionRequired: false },
    });
    expect(candidates[1]).toMatchObject({ source: 'pexels-photo', kind: 'image', caption: 'Cup of coffee', license: { name: 'Pexels License', creator: 'Bao Tran' } });
    expect(kit.pexels.queries[0]).toEqual({ kind: 'video', query: 'pouring coffee morning', orientation: 'portrait' });
  });

  it('skips Pexels without an API key, with a note and no error', async () => {
    setAssetHubDeps({ ...kit.deps, pexels: () => null });
    const { candidates, notes } = await searchAssets({ keywords: ['coffee'] });
    expect(candidates).toEqual([]);
    expect(notes).toEqual([expect.stringContaining('Chưa có API key Pexels')]);
  });

  it('matches library captions with accents and gives library licences', async () => {
    const mug = await kit.addAsset('video', 'mug.mp4', { license: 'CC BY 4.0', attribution: 'Nguyễn A' }, { caption: 'Rót cà phê vào cốc sứ trắng' });
    await kit.addAsset('video', 'beach.mp4', {}, { caption: 'Bãi biển lúc hoàng hôn' });
    await kit.addAsset('video', 'dog.mp4', {}, { caption: 'Con chó chạy trên cỏ' });
    const { candidates } = await searchAssets({ keywords: [], description: 'rót cà phê cho khách' }, ['mine']);
    expect(candidates.map((c) => c.ref)).toEqual([mug.id]);
    expect(candidates[0].license).toEqual({ name: 'CC BY 4.0', creator: 'Nguyễn A', attributionRequired: true });
  });
});

describe('resolveBrolls', () => {
  it('takes the owner footage first when it scores 3 or more, without asking Pexels', async () => {
    const own = await kit.addAsset('video', 'rot-ca-phe.mp4');
    kit.setQuick({ assets: [{ assetId: own.id, hint: 'rót cà phê buổi sáng' }] });
    kit.scoreOf = (caption) => (caption.includes('rót cà phê') ? 4 : 1);
    const plan = kit.savePlan([broll('br1', 4, coffee)]);
    const out = await resolveBrolls(kit.project.id, plan);
    expect(out.plan.brolls[0]).toMatchObject({ id: 'br1', assetId: own.id, source: 'upload' });
    expect(kit.pexels.queries).toEqual([]);
    expect(out.notes).toEqual([expect.stringContaining('4/5')]);
    expect(plan.brolls[0].assetId).toBeUndefined();
  });

  it('falls through to Pexels when the library scores below 3, scores on the spoken line and downloads with the licence', async () => {
    const own = await kit.addAsset('video', 'cho.mp4');
    kit.setQuick({ assets: [{ assetId: own.id, hint: 'con chó chạy' }] });
    kit.pexels.videos = [pexelsVideo(11, 'woman-pouring-coffee', 8), pexelsVideo(12, 'coffee-beans', 6, 1080, 1920, 'Minh')];
    kit.scoreOf = (caption) => (caption === 'woman pouring coffee' ? 5 : caption === 'coffee beans' ? 3 : 2);
    const out = await resolveBrolls(kit.project.id, kit.savePlan([broll('br1', 4, coffee)]));

    const b = out.plan.brolls[0];
    expect(b.source).toBe('pexels');
    const asset = findAsset(kit.root, b.assetId!)!;
    expect(asset).toMatchObject({
      kind: 'video', available: true, license: 'Pexels License', attribution: 'Video: Ana Lee · Pexels',
      sourceUrl: 'https://www.pexels.com/video/woman-pouring-coffee-11/', tags: ['pexels', 'pouring coffee', 'morning'],
    });
    expect(kit.downloads).toContain('https://videos.pexels.com/video-files/11/hd.mp4');
    expect(kit.downloads).not.toContain('https://videos.pexels.com/video-files/12/hd.mp4');
    // Two scoring turns (owner footage, then Pexels videos), each with the line being spoken and pictures.
    expect(scoreTurns()).toHaveLength(2);
    // From 1.5 s before the anchor word to 1 s after the shot ends.
    expect(scoreTurns()[1].prompt).toContain('Câu đang nói: "Sáng nào mình cũng pha cà phê rồi mở máy tính làm việc ở văn"');
    expect(scoreTurns()[1].prompt).toContain('Cảnh cần có: Cận cảnh rót cà phê buổi sáng');
    expect(scoreTurns()[1].images).toHaveLength(2);
    expect(scoredCaptions(scoreTurns()[1].prompt)).toEqual(['woman pouring coffee', 'coffee beans']);
  });

  it('drops an AI slot nothing scores 3 for, and keeps the owner slot with a note', async () => {
    kit.pexels.videos = [pexelsVideo(21, 'tea-cup', 8)];
    kit.pexels.photos = [pexelsPhoto(22, 'Tea leaves')];
    kit.scoreOf = () => 2;
    const plan = kit.savePlan([broll('br1', 4, coffee), broll('br2', 16, coffee, { origin: 'owner', title: 'Cảnh của tôi' })]);
    const out = await resolveBrolls(kit.project.id, plan);
    expect(out.plan.brolls.map((b) => b.id)).toEqual(['br2']);
    expect(out.plan.brolls[0].assetId).toBeUndefined();
    expect(out.notes).toEqual([
      'Bỏ chỗ trám "Cảnh br1": không cảnh nào đạt 3/5.',
      'Chưa có cảnh cho chỗ trám "Cảnh của tôi" bạn thêm: không cảnh nào đạt 3/5.',
    ]);
    expect(kit.downloads.filter((u) => !u.includes('preview') && !u.includes('h=350'))).toEqual([]);
  });

  it('uses a Pexels photo when no video fits', async () => {
    kit.pexels.videos = [pexelsVideo(31, 'tea-cup', 8)];
    kit.pexels.photos = [pexelsPhoto(32, 'Coffee cup on desk')];
    kit.scoreOf = (caption) => (caption === 'Coffee cup on desk' ? 4 : 2);
    const out = await resolveBrolls(kit.project.id, kit.savePlan([broll('br1', 4, coffee)]));
    const asset = findAsset(kit.root, out.plan.brolls[0].assetId!)!;
    expect(asset).toMatchObject({ kind: 'image', license: 'Pexels License', attribution: 'Ảnh: Bao Tran · Pexels' });
    expect(asset.file).toMatch(/\.jpeg$/);
  });

  it('never puts the same shot in two neighbouring slots and prefers unused shots', async () => {
    kit.pexels.videos = [pexelsVideo(41, 'pouring-coffee', 8), pexelsVideo(42, 'coffee-steam', 8)];
    kit.scoreOf = (caption) => (caption === 'pouring coffee' ? 5 : 4);
    const out = await resolveBrolls(kit.project.id, kit.savePlan([broll('br2', 9, coffee), broll('br1', 4, coffee)]));
    const [second, first] = out.plan.brolls;
    expect(first.id).toBe('br1');
    expect(findAsset(kit.root, first.assetId!)!.sourceUrl).toContain('pouring-coffee-41');
    expect(findAsset(kit.root, second.assetId!)!.sourceUrl).toContain('coffee-steam-42');
    // The second slot never saw the first slot's shot.
    expect(scoredCaptions(scoreTurns()[1].prompt)).toEqual(['coffee steam']);
  });

  it('reuses a clip already downloaded from the same Pexels page', async () => {
    const before = await kit.addAsset('video', 'pexels-old.mp4', { license: 'Pexels License', sourceUrl: 'https://www.pexels.com/video/pouring-coffee-51/' });
    kit.pexels.videos = [pexelsVideo(51, 'pouring-coffee', 8)];
    kit.scoreOf = () => 5;
    const out = await resolveBrolls(kit.project.id, kit.savePlan([broll('br1', 4, coffee)]));
    expect(out.plan.brolls[0].assetId).toBe(before.id);
    expect(kit.downloads.some((u) => u.endsWith('hd.mp4'))).toBe(false);
  });

  it('searches only the owner footage and library when stock is off', async () => {
    kit.setQuick({ stock: false });
    kit.pexels.videos = [pexelsVideo(61, 'pouring-coffee', 8)];
    kit.scoreOf = () => 5;
    const out = await resolveBrolls(kit.project.id, kit.savePlan([broll('br1', 4, coffee)]));
    expect(kit.pexels.queries).toEqual([]);
    expect(out.plan.brolls).toEqual([]);
  });

  it('notes the missing Pexels key once and never throws', async () => {
    setAssetHubDeps({ ...kit.deps, pexels: () => null });
    const out = await resolveBrolls(kit.project.id, kit.savePlan([broll('br1', 4, coffee), broll('br2', 12, coffee)]));
    expect(out.plan.brolls).toEqual([]);
    expect(out.notes.filter((n) => n.includes('API key Pexels'))).toHaveLength(1);
  });

  it('leaves plans without stock queries untouched', async () => {
    const plan = kit.savePlan([broll('br1', 4, undefined, { assetId: 'lib:video:x', source: 'library' })]);
    const out = await resolveBrolls(kit.project.id, plan);
    expect(out.plan).toBe(plan);
    expect(out.notes).toEqual([]);
    expect(kit.turns).toEqual([]);
  });

  it('drops the slot with the reason when no agent can score', async () => {
    setAssetHubDeps({ ...kit.deps, run: null });
    kit.pexels.videos = [pexelsVideo(71, 'pouring-coffee', 8)];
    const out = await resolveBrolls(kit.project.id, kit.savePlan([broll('br1', 4, coffee)]));
    expect(out.plan.brolls).toEqual([]);
    expect(out.notes).toEqual([expect.stringContaining('chưa có agent để chấm cảnh')]);
  });
});
