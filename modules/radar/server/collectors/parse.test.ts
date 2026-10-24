import { describe, expect, it } from 'vitest';
import { parseFeed, toIso, windowDays } from './parse.js';
import { parseCount, parseFeedBlock, parseMembers, relativeTimeToIso } from './fb-browser.js';

const YT = `<feed xmlns:media="http://search.yahoo.com/mrss/"><entry><title>Claude &amp; agents</title>
<link rel="alternate" href="https://www.youtube.com/watch?v=abc"/><published>2026-10-16T10:00:00+00:00</published>
<author><name>Chan</name></author><media:group><media:description>Mô tả dài</media:description><media:community><media:statistics views="12345"/></media:community></media:group></entry></feed>`;
const NEWS = `<rss><channel><item><title><![CDATA[Giáo viên dùng AI]]></title><link>https://vnexpress.net/a</link><pubDate>Fri, 16 Oct 2026 03:00:00 GMT</pubDate><description><![CDATA[<p>Nội dung <b>chính</b></p>]]></description></item></channel></rss>`;
const REDDIT = `<feed><entry><author><name>/u/bob</name></author><title>Top post</title><link href="https://www.reddit.com/r/x/comments/1/top/"/><updated>2026-10-16T01:00:00+00:00</updated><content type="html">&lt;p&gt;hello&lt;/p&gt;</content></entry></feed>`;

describe('parseFeed', () => {
  it('reads YouTube atom with media statistics', () => {
    const [e] = parseFeed(YT);
    expect(e).toMatchObject({ title: 'Claude & agents', link: 'https://www.youtube.com/watch?v=abc', views: 12345, description: 'Mô tả dài' });
    expect(e.published).toBe('2026-10-16T10:00:00.000Z');
  });
  it('reads RSS news with CDATA and html', () => {
    const [e] = parseFeed(NEWS);
    expect(e.title).toBe('Giáo viên dùng AI');
    expect(e.description).toBe('Nội dung chính');
    expect(e.published).toBe('2026-10-16T03:00:00.000Z');
  });
  it('reads Reddit atom', () => {
    const [e] = parseFeed(REDDIT);
    expect(e).toMatchObject({ title: 'Top post', link: 'https://www.reddit.com/r/x/comments/1/top/', author: '/u/bob', description: 'hello' });
  });
});

describe('toIso', () => {
  it('handles unix seconds, ms and ISO', () => {
    expect(toIso(1760000000)).toBe('2025-10-09T08:53:20.000Z');
    expect(toIso(1760000000000)).toBe('2025-10-09T08:53:20.000Z');
    expect(toIso('2025-10-09T08:53:20Z')).toBe('2025-10-09T08:53:20.000Z');
    expect(toIso('nope')).toBeUndefined();
  });
  it('windowDays rounds up', () => {
    expect(windowDays('2026-10-16T00:00:00Z', new Date('2026-10-17T06:00:00Z'))).toBe(2);
  });
});

describe('browser parsing', () => {
  it('parses counts', () => {
    expect(parseCount('123')).toBe(123);
    expect(parseCount('1,2K')).toBe(1200);
    expect(parseCount('1.234')).toBe(1234);
    expect(parseMembers('Nhóm riêng tư · 12.345 thành viên')).toBe(12345);
    expect(parseMembers('2,9K members')).toBe(2900);
  });
  it('parses Vietnamese block', () => {
    const b = parseFeedBlock('Nguyễn A\n6 giờ\nNội dung bài\nTất cả cảm xúc: 89\n1,2K bình luận\n45 lượt chia sẻ', '/groups/123/posts/456/?__cft__=x');
    expect(b).toMatchObject({ url: 'https://www.facebook.com/groups/123/posts/456', comments: 1200, shares: 45, reactions: 89, postedText: '6 giờ' });
  });
  it('parses English block and rejects blocks without permalink', () => {
    const b = parseFeedBlock('Jane\n2d\nHello\nAll reactions: 12\n34 comments\n5 shares', '/groups/9/permalink/77/');
    expect(b).toMatchObject({ comments: 34, shares: 5, reactions: 12, postedText: '2d' });
    expect(parseFeedBlock('x', '/groups/9/user/1')).toBeNull();
  });
  it('relative time', () => {
    const now = new Date('2026-10-17T12:00:00Z');
    expect(relativeTimeToIso('6 giờ', now)).toBe('2026-10-17T06:00:00.000Z');
    expect(relativeTimeToIso('1 ngày', now)).toBe('2026-10-16T12:00:00.000Z');
    expect(relativeTimeToIso('soon', now)).toBeUndefined();
  });
});

describe('YouTube channel input', () => {
  it('accepts an id, a channel link, an @handle or a handle link', async () => {
    const { parseYoutubeChannelInput, youtubeIdFromPage } = await import('./sources.js');
    expect(parseYoutubeChannelInput('UC2ojq-nuP8ceeHqiroeKhBA')).toEqual({ id: 'UC2ojq-nuP8ceeHqiroeKhBA' });
    expect(parseYoutubeChannelInput('https://www.youtube.com/channel/UCawZsQWqfGSbCI5yjkdVkTA/videos')).toEqual({ id: 'UCawZsQWqfGSbCI5yjkdVkTA' });
    expect(parseYoutubeChannelInput('@ColeMedin')).toEqual({ pageUrl: 'https://www.youtube.com/@ColeMedin' });
    expect(parseYoutubeChannelInput('youtube.com/@nateherk')).toEqual({ pageUrl: 'https://youtube.com/@nateherk' });
    expect(parseYoutubeChannelInput('Nate Herk')).toBeNull();
    expect(youtubeIdFromPage('…"externalId":"UC2ojq-nuP8ceeHqiroeKhBA",…')).toBe('UC2ojq-nuP8ceeHqiroeKhBA');
  });
});
