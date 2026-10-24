/** Fixtures shared by the radar tests. */

import type { AgentRunner } from './agent-turn.js';
import type { CollectResult, LayerKey, RawItem } from './types.js';
import { itemIdFor } from './util.js';

export function mkItem(url: string, over: Partial<RawItem> & { layer?: LayerKey } = {}): RawItem {
  return {
    id: itemIdFor(url), layer: 'nganh', kind: 'fb_group', sourceName: 'Giáo Viên Tiếng Anh', sourceUrl: 'https://www.facebook.com/groups/1947317768815047',
    url, text: 'Mình muốn mua ChatGPT Plus nhưng giá cao, ai share chung không', postedAt: '2026-10-17T10:00:00Z',
    metrics: { comments: 40, reactions: 12, shares: 3 }, comments: [], media: 'text', via: 'apify', ...over,
  };
}

export function collectResult(items: RawItem[], notes: string[] = []): CollectResult {
  return {
    items, notes, costUsd: 0.02,
    sources: [{ kind: 'fb_group', name: 'Giáo Viên Tiếng Anh', via: 'apify', ok: true, count: items.length, members: 151000 }],
  };
}

export interface FakeRunnerOptions {
  /** Pain ids to put in matchId of the first pain. */
  matchId?: string | null;
  failSteps?: string[];
  malformed?: string[];
  quote?: string;
}

/** A runner that answers every step with valid JSON built from the prompt. */
export function fakeRunner(opts: FakeRunnerOptions = {}): AgentRunner & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input) => {
    const step = input.usageKey.split(':')[2];
    calls.push(step);
    if (opts.failSteps?.includes(step)) return { text: '', model: 'fake', costUsd: 0, error: 'boom' };
    if (opts.malformed?.includes(step)) return { text: 'không phải JSON {', model: 'fake', costUsd: 0.01 };
    let json: unknown;
    if (step === 'enrich') {
      const ids = [...input.prompt.matchAll(/^\[([0-9a-f]{16})\]/gm)].map((m) => m[1]);
      json = {
        items: ids.map((id, i) => ({ id, title: `Hỏi mua ChatGPT Plus, rủ dùng chung ${i + 1}`, note: 'Bình luận rủ share', keep: true, profession: 'Giáo viên' })),
        communities: [{ name: 'Giáo Viên Tiếng Anh', summary: 'Rủ nhau mua chung ChatGPT Plus' }],
      };
    } else if (step === 'synthesize') {
      const id = input.prompt.match(/^\[([0-9a-f]{16})\]/m)?.[1];
      json = {
        pains: [{ title: 'Muốn ChatGPT Plus nhưng ngại giá', detail: 'Rủ nhau dùng chung 150k/tháng', professions: ['Giáo viên', 'Không có nghề này'], topics: ['Chi phí, mua tài khoản'], itemIds: [id, 'khongco'], matchId: opts.matchId ?? null }],
        quotes: [{ text: opts.quote ?? 'ai share chung không', tag: 'Giáo viên, mua chung', topics: [], itemId: id }, { text: 'câu bịa hoàn toàn không có trong dữ liệu', tag: 'x', topics: [] }],
        buySignals: [{ candidate: 1, type: 'intent', context: 'Giáo viên, ChatGPT Plus dùng chung (40 bình luận)' }, { candidate: 99, type: 'price', context: 'bỏ' }],
        sellerNote: '',
        tools: [{ rank: 1, names: ['ChatGPT'], note: 'nhắc nhiều nhất' }],
        fears: [{ text: 'sợ mất việc vì AI', profession: 'Giáo viên', context: 'ngữ cảnh', itemId: id }],
        ideas: [{ channel: 'Kênh lạ', title: 'bộ prompt cho giáo viên', evidence: ['40 bình luận'], painRanks: [1] }],
        professions: [{ name: 'Giáo viên', summary: 'Hỏi mua chung', painRanks: [1], quote: 'ai share chung không' }],
        communities: [{ name: 'Giáo Viên Tiếng Anh', painRank: 1 }],
        trends: [], dataNotes: ['Một nhóm chỉ xem được 3 giờ gần nhất'],
      };
    } else {
      json = { competitors: [], ads: [], otherAdvertisers: [], gap: null };
    }
    return { text: `\`\`\`json\n${JSON.stringify(json)}\n\`\`\``, model: 'fake', costUsd: 0.01 };
  }) as AgentRunner & { calls: string[] };
  fn.calls = calls;
  return fn;
}
