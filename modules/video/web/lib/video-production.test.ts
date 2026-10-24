import { describe, expect, it } from 'vitest';

import {
  activeMention, activitySteps, briefWithNames, describeEstimate, fmtSec, insertMention, locateAt, matchCast, mentionedIds, mergeStudioItems, previewPlaylist,
  sceneCounts, spendHint, stageOf, totalSec, type ProductionSummary,
} from './video-production';

const CAST = [
  { id: 'tony', name: 'Tony Trieu', handle: 'tonytrieu' },
  { id: 'genie', name: 'Genie', handle: 'genie.aibestie' },
];

describe('@mentions', () => {
  it('finds the mention being typed and completes it', () => {
    const text = 'Video @ton';
    const m = activeMention(text, text.length);
    expect(m).toEqual({ query: 'ton', start: 6 });
    expect(matchCast(CAST, 'ton').map((c) => c.id)).toEqual(['tony']);
    expect(matchCast(CAST, 'triệu').map((c) => c.id)).toEqual(['tony']);
    expect(insertMention(text, m!, 'tonytrieu')).toEqual({ text: 'Video @tonytrieu ', caret: 17 });
    expect(activeMention('email@x', 7)).toBeNull();
    expect(activeMention('@', 1)).toEqual({ query: '', start: 0 });
  });

  it('resolves mentioned KOLs in order and writes names for the writer', () => {
    const text = '@genie.aibestie và @TonyTrieu cùng giới thiệu GenPrint, @tonytrieu dẫn chính';
    expect(mentionedIds(text, CAST)).toEqual(['genie', 'tony']);
    expect(briefWithNames('@tonytrieu giới thiệu GenPrint AI', CAST)).toBe('Tony Trieu giới thiệu GenPrint AI');
  });
});

describe('production helpers', () => {
  it('maps states to the 4-step rail and formats lengths', () => {
    expect([stageOf('brief'), stageOf('storyboard'), stageOf('generating'), stageOf('ready'), stageOf('finishing')]).toEqual([0, 1, 2, 2, 3]);
    expect(fmtSec(42.4)).toBe('42 giây');
    expect(fmtSec(95)).toBe('1:35');
  });

  it('counts scenes, length and the spend still ahead', () => {
    const scenes = [
      { status: 'done' as const, durationSec: 10, output: { durationSec: 9.2 }, engine: 'heygen' as const },
      { status: 'draft' as const, durationSec: 12, output: null, engine: 'veo' as const },
      { status: 'failed' as const, durationSec: 6, output: null, engine: 'heygen' as const },
      { status: 'running' as const, durationSec: 5, output: null, engine: 'rocketflow' as const },
    ];
    expect(sceneCounts(scenes)).toEqual({ done: 1, running: 1, failed: 1, draft: 1, total: 4 });
    expect(totalSec(scenes)).toBe(32.2);
    expect(spendHint(scenes)).toEqual({ usd: 1.2, heygenScenes: 1, other: 1 });
  });
});

describe('studio workspace helpers', () => {
  const out = (durationSec: number) => ({ durationSec, file: 'x.mp4', subtitles: null, thumb: null });

  it('plays only finished scenes, in order, with running start times', () => {
    const { items, total } = previewPlaylist([
      { id: 'a', status: 'done', output: out(4) },
      { id: 'b', status: 'draft', output: null },
      { id: 'c', status: 'done', output: out(6.5) },
    ] as Parameters<typeof previewPlaylist>[0]);
    expect(items.map((i) => [i.sceneId, i.index, i.start, i.trimStart])).toEqual([['a', 0, 0, 0], ['c', 2, 4, 0]]);
    expect(total).toBe(10.5);
  });

  it('finds the scene and offset under the scrubber', () => {
    const { items } = previewPlaylist([
      { id: 'a', status: 'done', output: out(4) },
      { id: 'c', status: 'done', output: out(6) },
    ] as Parameters<typeof previewPlaylist>[0]);
    expect(locateAt(items, 0)).toEqual({ item: items[0], offset: 0 });
    expect(locateAt(items, 5)).toEqual({ item: items[1], offset: 1 });
    expect(locateAt(items, 99)).toEqual({ item: items[1], offset: 6 });
    expect(locateAt(items, -3)).toEqual({ item: items[0], offset: 0 });
    expect(locateAt([], 2)).toBeNull();
  });

  it('merges productions and recorded footage into one newest-first list without the host projects', () => {
    const prod = (id: string, updatedAt: string, projectId: string | null, finishProjectId: string | null = null): ProductionSummary => ({
      id, title: id, cast: ['k'], aspect: '9:16', targetSec: 45, state: 'storyboard', finishProjectId, projectId, series: null,
      pendingApproval: id === 'p2', createdAt: updatedAt, updatedAt, scenes: 4, scenesDone: 1, thumb: null,
    });
    const items = mergeStudioItems(
      [prod('p1', '2026-10-20T08:00:00Z', 'h1'), prod('p2', '2026-10-20T10:00:00Z', 'h2', 'legacy')],
      [
        { id: 'h1', title: 'host', updatedAt: '2026-10-20T11:00:00Z', status: 'ready', hasSource: false, mode: 'produce' },
        { id: 'legacy', title: 'old finish', updatedAt: '2026-10-20T11:00:00Z', status: 'ready', hasSource: true },
        { id: 'f1', title: 'Quay sẵn', updatedAt: '2026-10-20T09:00:00Z', status: 'ready', hasSource: true },
        { id: 'c1', title: 'old create', updatedAt: '2026-10-20T12:00:00Z', status: 'ready', hasSource: false, mode: 'create' },
      ],
    );
    expect(items.map((i) => `${i.type}:${i.id}`)).toEqual(['production:p2', 'footage:f1', 'production:p1']);
    expect(items[0].type === 'production' && items[0].pendingApproval).toBe(true);
  });

  it('describes a batch cost without inventing numbers', () => {
    expect(describeEstimate({ usd: 1.2, unpriced: 0, heygenCredits: 18, flowScenes: 0, freeScenes: 2 })).toBe('≈ $1,20 (Veo/fal) · ≈ 18 credit HeyGen · 2 cảnh miễn phí');
    expect(describeEstimate({ usd: 0, unpriced: 0, heygenCredits: 0, flowScenes: 0, freeScenes: 0 })).toBe('Không tốn chi phí');
  });
});

describe('director activity', () => {
  it('merges started/completed rows and names the tools in Vietnamese', () => {
    expect(activitySteps([
      { label: 'video-produce: produce_context' }, { label: 'video-produce: produce_context', detail: 'completed' },
      { label: 'mcp__video-produce__produce_inspect_scene' },
      { label: 'Bash: node video-cli plan show', detail: 'completed' },
    ])).toEqual([
      { label: 'Đọc phân cảnh', done: true },
      { label: 'Xem lại cảnh vừa tạo', done: false },
      { label: 'Bash: node video-cli plan show', done: true },
    ]);
  });

  it('keeps trim points in the preview playlist', () => {
    const { items, total } = previewPlaylist([
      { id: 'a', status: 'done', trimStart: 12, output: { file: 'a', durationSec: 4, sourceSec: 40, subtitles: null, thumb: null } },
    ]);
    expect(items[0]).toMatchObject({ trimStart: 12, durationSec: 4 });
    expect(total).toBe(4);
    expect(locateAt(items, 3)).toEqual({ item: items[0], offset: 3 });
  });
});
