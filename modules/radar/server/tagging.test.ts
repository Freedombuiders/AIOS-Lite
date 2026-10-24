import { describe, expect, it } from 'vitest';

import { defaultRadarConfig } from './defaults.js';
import {
  adFormatLabel, adFunnel, classifyBuyComment, daysRunning, isAboutAI, isSellerComment, sellsBook, topicsFor, typeLabel, within24h,
} from './tagging.js';

const cfg = defaultRadarConfig();

describe('topics and AI', () => {
  it('tags topics accent-insensitively and allows several', () => {
    const topics = topicsFor('Mua chung tài khoan ChatGPT Plus, có nên dùng không', cfg.layers.nganh.topics);
    expect(topics).toContain('chi-phi');
    expect(topics).toContain('chon-cong-cu');
    expect(topicsFor('hôm nay trời đẹp', cfg.layers.nganh.topics)).toEqual([]);
  });

  it('matches short AI keywords as whole words only', () => {
    expect(isAboutAI('Mình đang dùng AI soạn giáo án', cfg.aiKeywords)).toBe(true);
    expect(isAboutAI('Cô Mai đi chợ mua tai nghe', cfg.aiKeywords)).toBe(false);
    expect(isAboutAI('dùng chat gpt', cfg.aiKeywords)).toBe(true);
  });
});

describe('buy signals', () => {
  it('classifies material, price and intent', () => {
    expect(classifyBuyComment('Cho mình xin tài liệu với ạ', cfg.buyKeywords)).toBe('material');
    expect(classifyBuyComment('Gói này giá bao nhiêu vậy', cfg.buyKeywords)).toBe('price');
    expect(classifyBuyComment('Ai có share chung ChatGPT Plus không', cfg.buyKeywords)).toBe('intent');
    expect(classifyBuyComment('Bài viết hay quá', cfg.buyKeywords)).toBeNull();
  });

  it('spots sellers advertising accounts', () => {
    expect(isSellerComment('Mình bán slot ChatGPT Plus 150k/tháng, inbox mình nhé')).toBe(true);
    expect(isSellerComment('Cảm ơn bạn nhiều')).toBe(false);
  });
});

describe('within24h', () => {
  const now = new Date('2026-10-17T13:00:00Z');
  it('uses postedAt, then the relative text, else counts as inside', () => {
    expect(within24h('2026-10-17T05:00:00Z', undefined, now)).toBe(true);
    expect(within24h('2026-10-15T05:00:00Z', undefined, now)).toBe(false);
    expect(within24h(undefined, '6 giờ', now)).toBe(true);
    expect(within24h(undefined, '3 ngày', now)).toBe(false);
    expect(within24h(undefined, '1 ngày', now)).toBe(true);
    expect(within24h(undefined, undefined, now)).toBe(true);
  });
});

describe('typeLabel', () => {
  const base = { kind: 'fb_group' as const, media: 'text' as const, text: 'x', title: undefined, comments: [] };
  it('labels by kind and content', () => {
    expect(typeLabel({ ...base, kind: 'news' })).toBe('Tin');
    expect(typeLabel({ ...base, media: 'video' })).toBe('Video');
    expect(typeLabel({ ...base, text: 'Comment "Loop" để nhận bộ prompt' })).toBe('Bài viết tặng tài liệu');
    expect(typeLabel({ ...base, text: 'a'.repeat(1300) })).toBe('Bài viết dài');
    expect(typeLabel(base)).toBe('Bài nhóm');
    expect(typeLabel({ ...base, kind: 'fb_page' })).toBe('Bài viết');
  });
});

describe('ads', () => {
  it('derives the funnel', () => {
    expect(adFunnel({ ctaType: 'MESSAGE_PAGE' }).funnel).toBe('messenger');
    expect(adFunnel({ landingUrl: 'https://docs.google.com/forms/d/1' }).funnel).toBe('form');
    expect(adFunnel({ landingUrl: 'https://us02web.zoom.us/webinar/1' }).funnel).toBe('zoom');
    expect(adFunnel({ ctaText: 'Comment để nhận' }).funnel).toBe('comment');
    expect(adFunnel({ landingUrl: 'https://khoahoc.vn/ai' })).toEqual({ funnel: 'web', label: 'Web' });
    expect(adFunnel({}).funnel).toBe('unknown');
  });

  it('formats, days and book detection', () => {
    expect(adFormatLabel('CAROUSEL')).toBe('Ảnh, carousel');
    expect(adFormatLabel('VIDEO')).toBe('Video');
    expect(adFormatLabel(undefined)).toBe('Không ghi');
    expect(daysRunning('2026-10-07T00:00:00Z', new Date('2026-10-17T12:00:00Z'))).toBe(10);
    expect(daysRunning(undefined, new Date())).toBe(0);
    expect(sellsBook('Tặng ebook AI cho kế toán')).toBe(true);
    expect(sellsBook('Học Zoom miễn phí')).toBe(false);
  });
});
