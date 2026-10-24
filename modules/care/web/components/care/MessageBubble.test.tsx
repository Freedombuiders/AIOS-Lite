import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { msg } from '@modules/care/web/lib/care/fixtures.test-util';
import type { ZaloProfiles } from '@modules/care/web/lib/care/zaloProfiles';
import { MessageBubble } from './MessageBubble';

const host = document.createElement('div'); document.body.append(host);
afterEach(() => { act(() => render(null, host)); });

const AV = 'https://s120-ava-talk.zadn.vn/a.jpg';
const profiles: ZaloProfiles = {
  thread: { name: 'Khách Một', avatarUrl: AV },
  senders: { 'id-2': { name: 'Khách Hai', avatarUrl: 'https://s120-ava-talk.zadn.vn/b.jpg' } },
};

function show(m: ReturnType<typeof msg>, p: ZaloProfiles | null): { name: string; img: string | null; initials: string } {
  act(() => render(<MessageBubble message={m} channel="zalo" profiles={p} highlighted={false} />, host));
  return {
    name: host.querySelector('.care-sender')?.textContent ?? '',
    img: host.querySelector('.care-av-img')?.getAttribute('src') ?? null,
    initials: host.querySelector('.care-av-initials')?.textContent ?? '',
  };
}

describe('Zalo customer bubble', () => {
  it('names a 1-1 message after the conversation person, with their picture', () => {
    expect(show(msg({ metadata: { type: 'chat', conversationKind: 'direct' } }), profiles)).toMatchObject({ name: 'Khách Một', img: AV });
  });

  it('takes a group sender by identity, and the API name first', () => {
    const group = { type: 'chat', conversationKind: 'group' };
    expect(show(msg({ senderIdentityId: 'id-2', metadata: group }), profiles)).toMatchObject({ name: 'Khách Hai', img: 'https://s120-ava-talk.zadn.vn/b.jpg' });
    expect(show(msg({ senderIdentityId: 'id-2', senderName: 'Tên từ API', metadata: group }), profiles).name).toBe('Tên từ API');
    expect(show(msg({ senderIdentityId: 'id-3', senderName: 'Người Ba', metadata: group }), profiles)).toMatchObject({ name: 'Người Ba', img: null, initials: 'NB' });
  });

  it('falls back to the role label and initials without profiles', () => {
    expect(show(msg({ metadata: { type: 'chat', conversationKind: 'direct' } }), null)).toMatchObject({ name: 'Khách', img: null });
  });
});
