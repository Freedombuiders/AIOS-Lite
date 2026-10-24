import { describe, expect, it } from 'vitest';

import { parseChannel, socialHandle } from './channels.js';

describe('parseChannel', () => {
  it('reads Facebook group links, including share and mobile links', () => {
    expect(parseChannel('https://www.facebook.com/groups/comailo/?ref=share')).toEqual({ platform: 'fb_group', handle: 'comailo', url: 'https://www.facebook.com/groups/comailo' });
    expect(parseChannel('m.facebook.com/groups/2403721346759140')).toMatchObject({ platform: 'fb_group', handle: '2403721346759140' });
    expect(parseChannel('https://www.facebook.com/share/g/1AbCdEf/')).toMatchObject({ platform: 'fb_group', url: 'https://www.facebook.com/share/g/1AbCdEf/' });
  });

  it('reads Facebook pages and personal profiles', () => {
    expect(parseChannel('facebook.com/ungdungaimoingay')).toEqual({ platform: 'fb_page', handle: 'ungdungaimoingay', url: 'https://www.facebook.com/ungdungaimoingay' });
    expect(parseChannel('https://www.facebook.com/profile.php?id=100012345678&sk=about')).toEqual({ platform: 'fb_page', handle: '100012345678', url: 'https://www.facebook.com/profile.php?id=100012345678' });
    expect(parseChannel('https://www.facebook.com/people/Tony-Hoang/100099/')).toMatchObject({ platform: 'fb_page', handle: '100099' });
  });

  it('rejects Facebook links that are not a channel', () => {
    expect(parseChannel('https://www.facebook.com/watch/?v=1')).toBeNull();
    expect(parseChannel('https://www.facebook.com/')).toBeNull();
    expect(parseChannel('https://www.facebook.com/share/p/xyz/')).toBeNull();
  });

  it('reads Instagram and X profile links but not post links', () => {
    expect(parseChannel('https://www.instagram.com/openai/?hl=vi')).toEqual({ platform: 'instagram', handle: 'openai', url: 'https://www.instagram.com/openai/' });
    expect(parseChannel('https://www.instagram.com/p/Cabc123/')).toBeNull();
    expect(parseChannel('https://twitter.com/karpathy')).toEqual({ platform: 'x', handle: 'karpathy', url: 'https://x.com/karpathy' });
    expect(parseChannel('x.com/bcherny/status/123')).toMatchObject({ platform: 'x', handle: 'bcherny' });
    expect(parseChannel('https://x.com/search?q=claude')).toBeNull();
  });

  it('needs a platform hint for a bare handle', () => {
    expect(parseChannel('@karpathy')).toBeNull();
    expect(parseChannel('@karpathy', 'x')).toEqual({ platform: 'x', handle: 'karpathy', url: 'https://x.com/karpathy' });
    expect(parseChannel('nasa.gov', 'instagram')).toMatchObject({ platform: 'instagram', handle: 'nasa.gov' });
    expect(parseChannel('comailo', 'fb_group')).toMatchObject({ platform: 'fb_group', url: 'https://www.facebook.com/groups/comailo' });
    expect(parseChannel('two words', 'x')).toBeNull();
    expect(parseChannel('a_name_that_is_too_long', 'x')).toBeNull();
  });

  it('lets the link win over the hint', () => {
    expect(parseChannel('https://www.instagram.com/openai/', 'x')).toMatchObject({ platform: 'instagram' });
    expect(parseChannel('https://www.facebook.com/groups/abc', 'fb_page')).toMatchObject({ platform: 'fb_group' });
  });

  it('reads Threads, TikTok and YouTube channel links', () => {
    expect(parseChannel('https://www.threads.net/@openai')).toEqual({ platform: 'threads', handle: 'openai', url: 'https://www.threads.net/@openai' });
    expect(parseChannel('threads.com/@zuck/post/abc')).toMatchObject({ platform: 'threads', handle: 'zuck' });
    expect(parseChannel('https://www.tiktok.com/@openai/video/123?lang=vi')).toEqual({ platform: 'tiktok', handle: 'openai', url: 'https://www.tiktok.com/@openai' });
    expect(parseChannel('https://www.youtube.com/@anthropic-ai/videos')).toEqual({ platform: 'youtube', handle: '@anthropic-ai', url: 'https://www.youtube.com/@anthropic-ai' });
    expect(parseChannel('youtube.com/channel/UC2ojq-nuP8ceeHqiroeKhBA')).toMatchObject({ platform: 'youtube', handle: 'UC2ojq-nuP8ceeHqiroeKhBA' });
    expect(parseChannel('https://www.youtube.com/watch?v=abc')).toBeNull();
    expect(parseChannel('https://www.tiktok.com/foryou')).toBeNull();
  });

  it('turns bare handles into Threads, TikTok and YouTube channels with a hint', () => {
    expect(parseChannel('@zuck', 'threads')).toMatchObject({ platform: 'threads', handle: 'zuck' });
    expect(parseChannel('openai', 'tiktok')).toMatchObject({ platform: 'tiktok', url: 'https://www.tiktok.com/@openai' });
    expect(parseChannel('@OpenAI', 'youtube')).toEqual({ platform: 'youtube', handle: '@OpenAI', url: 'https://www.youtube.com/@OpenAI' });
    expect(parseChannel('UC2ojq-nuP8ceeHqiroeKhBA', 'youtube')).toMatchObject({ handle: 'UC2ojq-nuP8ceeHqiroeKhBA' });
  });
});

describe('socialHandle', () => {
  it('normalises stored links, @names and names', () => {
    expect(socialHandle('https://www.instagram.com/openai/', 'instagram')).toBe('openai');
    expect(socialHandle('@karpathy', 'x')).toBe('karpathy');
    expect(socialHandle(' steipete ', 'x')).toBe('steipete');
    expect(socialHandle('https://www.threads.net/@zuck', 'threads')).toBe('zuck');
    expect(socialHandle('@openai', 'tiktok')).toBe('openai');
  });
});
