import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findAsset } from '../library/store.js';
import { BEAT_SR } from './beats.js';
import { setAssetHubDeps } from './hub.js';
import { frameTimes, indexAsset, indexQueueIdle, startAutoIndex } from './indexer.js';
import { makeHubKit, type HubKit } from './testkit.js';

let kit: HubKit;
beforeEach(() => { kit = makeHubKit(); });
afterEach(async () => { await indexQueueIdle(); kit.cleanup(); });

/** 20 s of clicks at 120 BPM, every other click louder. */
function clicks120(): Float32Array {
  const samples = new Float32Array(20 * BEAT_SR);
  for (let k = 0, t = 0.1; t < 19.9; k++, t = 0.1 + k * 0.5) {
    const start = Math.round(t * BEAT_SR);
    for (let i = 0; i < 600; i++) samples[start + i] += (k % 2 === 0 ? 0.9 : 0.35) * Math.sin((2 * Math.PI * 1000 * i) / BEAT_SR) * Math.exp(-i / 130);
  }
  return samples;
}

describe('frameTimes', () => {
  it('takes 3 frames per second, 2 to 6, at bucket centres', () => {
    expect(frameTimes(0.5)).toEqual([0.125, 0.375]);
    expect(frameTimes(1)).toEqual([1 / 6, 0.5, 5 / 6].map((t) => Math.round(t * 1000) / 1000));
    expect(frameTimes(12)).toHaveLength(6);
    expect(frameTimes(12)[0]).toBe(1);
    expect(frameTimes(0)).toEqual([0]);
  });
});

describe('indexAsset', () => {
  it('describes a clip from 2–6 frames and stores the Vietnamese caption and quality', async () => {
    const clip = await kit.addAsset('video', 'mo-dau.mp4', { description: 'cảnh mở đầu' });
    const r = await indexAsset(clip.id);
    expect(r.notes).toEqual([]);
    expect(r.asset).toMatchObject({ caption: 'Cận cảnh bàn tay rót cà phê vào cốc trắng, ánh sáng buổi sáng.', quality: 0.81, indexedAt: expect.any(String) });
    expect(findAsset(kit.root, clip.id)).toMatchObject({ caption: r.asset.caption, quality: 0.81 });
    const turn = kit.turns[0];
    expect(turn).toMatchObject({ agentId: 'main', title: 'Mô tả tư liệu: mo-dau' });
    expect(turn.images).toHaveLength(6);
    expect(turn.prompt).toContain('6 khung hình (theo thứ tự thời gian) trích từ một đoạn video dài 8s');
    expect(turn.prompt).toContain('Ghi chú có sẵn (chỉ để tham khảo, vẫn tả theo hình): cảnh mở đầu');
    expect(turn.prompt).toContain('{"caption": "mô tả tiếng Việt, tối đa 100 chữ", "quality": 0.72}');

    // Already indexed: no second turn unless forced.
    expect((await indexAsset(clip.id)).notes).toEqual(['Đã lập chỉ mục từ trước.']);
    expect(kit.turns).toHaveLength(1);
    await indexAsset(clip.id, { force: true });
    expect(kit.turns).toHaveLength(2);
  });

  it('looks at a picture once', async () => {
    const pic = await kit.addAsset('image', 'ban-lam-viec.jpg');
    await indexAsset(pic.id);
    expect(kit.turns[0].images).toHaveLength(1);
    expect(kit.turns[0].prompt).toContain('Hãy xem một ảnh');
  });

  it('measures tempo and strong beats of a track, and fills the labels the owner left empty', async () => {
    setAssetHubDeps({ ...kit.deps, pcm: async () => clicks120() });
    const track = await kit.addAsset('bgm', 'drive.mp3', { mood: 'Tập trung' });
    const r = await indexAsset(track.id);
    expect(r.notes).toEqual([]);
    expect(r.asset.bpm).toBe(120);
    expect(r.asset.beats!.length).toBeGreaterThan(10);
    const gaps = r.asset.beats!.slice(1).map((b, i) => b - r.asset.beats![i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(0.9);
    // The owner's mood stays; genre, vocals and the caption come from the agent.
    expect(r.asset).toMatchObject({ mood: 'Tập trung', genre: 'Electronic', vocals: false, caption: 'Nhạc điện tử nhanh, hợp video công nghệ.', indexedAt: expect.any(String) });
    const turn = kit.turns[0];
    expect(turn.images).toHaveLength(1);
    expect(turn.prompt).toContain('khoảng 120 BPM');
    expect(turn.prompt).toContain('Năng lượng, Tươi sáng, Tập trung, Hồi hộp, Suy tư, Bình yên');
  });

  it('gives a track without a mood the agent\'s mood', async () => {
    setAssetHubDeps({ ...kit.deps, pcm: async () => clicks120() });
    const track = await kit.addAsset('bgm', 'untitled.mp3');
    expect((await indexAsset(track.id)).asset.mood).toBe('Năng lượng');
  });

  it('still measures beats without an agent and says why there are no labels', async () => {
    setAssetHubDeps({ ...kit.deps, run: null, pcm: async () => clicks120() });
    const track = await kit.addAsset('bgm', 'drive.mp3');
    const r = await indexAsset(track.id);
    expect(r.asset.bpm).toBe(120);
    expect(r.asset.indexedAt).toBeUndefined();
    expect(r.notes).toEqual([expect.stringContaining('Chưa có agent để gắn nhãn nhạc')]);
  });

  it('explains instead of failing when the agent cannot see images or answers badly', async () => {
    const clip = await kit.addAsset('video', 'a.mp4');
    setAssetHubDeps({ ...kit.deps, seesImages: () => false });
    expect((await indexAsset(clip.id)).notes).toEqual(['Agent "main" không đọc được ảnh nên chưa mô tả được tư liệu.']);
    setAssetHubDeps({ ...kit.deps, run: async () => ({ ok: true, output: 'Tôi không chắc.' }) });
    expect((await indexAsset(clip.id)).notes).toEqual(['Câu trả lời của agent không đúng dạng JSON caption/quality.']);
    expect(findAsset(kit.root, clip.id)!.indexedAt).toBeUndefined();
  });

  it('refuses kinds it cannot index and unknown ids', async () => {
    const sfx = await kit.addAsset('sfx', 'pop.mp3');
    await expect(indexAsset(sfx.id)).rejects.toMatchObject({ status: 422, code: 'not_indexable' });
    await expect(indexAsset('lib:video:khong-co')).rejects.toMatchObject({ status: 404 });
  });
});

describe('background queue', () => {
  it('indexes new library files as they are added', async () => {
    startAutoIndex();
    const clip = await kit.addAsset('video', 'moi.mp4');
    await indexQueueIdle();
    expect(findAsset(kit.root, clip.id)).toMatchObject({ caption: expect.stringContaining('rót cà phê'), quality: 0.81 });
  });

  it('does nothing when no agent can run', async () => {
    setAssetHubDeps({ ...kit.deps, run: null });
    startAutoIndex();
    const clip = await kit.addAsset('video', 'moi.mp4');
    await indexQueueIdle();
    expect(findAsset(kit.root, clip.id)!.caption).toBeUndefined();
    expect(kit.turns).toEqual([]);
  });
});
