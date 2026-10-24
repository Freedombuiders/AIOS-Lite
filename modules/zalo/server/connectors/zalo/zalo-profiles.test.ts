import { afterEach, describe, expect, it } from 'vitest';
import { makeZaloRig, type ZaloRig } from './zalo-test-kit.js';

let rig: ZaloRig;
afterEach(() => rig?.close());

describe('display hooks for the Care inbox', () => {
  it('passes only Zalo CDN https avatars and only the senders Care asked for', async () => {
    rig = makeZaloRig({
      profiles: async () => ({
        thread: { name: 'Toàn Trần', avatarUrl: 'https://s120-26-ava-talk.zadn.vn/22/a.jpg?key=k&time=1' },
        senders: {
          toan: { name: 'Toàn Trần', avatarUrl: 'https://s120-26-ava-talk.zadn.vn/22/a.jpg' },
          evil: { name: 'X', avatarUrl: 'https://tracker.example.com/zadn.vn.jpg' },
          plain: { name: 'Y', avatarUrl: 'http://s120-ava-talk.zadn.vn/y.jpg' },
          other: { name: 'Not asked', avatarUrl: '' },
        },
      }),
      storedAvatarUrl: (_a, key) => (key === 'toan' ? 'https://s120-26-ava-talk.zadn.vn/22/a.jpg' : 'javascript:alert(1)'),
    });
    const res = await rig.connector.profiles(rig.account.id, 'toan', ['toan', 'evil', 'plain', 'ghost']);
    expect(res).toEqual({
      thread: { name: 'Toàn Trần', avatarUrl: 'https://s120-26-ava-talk.zadn.vn/22/a.jpg?key=k&time=1' },
      senders: {
        toan: { name: 'Toàn Trần', avatarUrl: 'https://s120-26-ava-talk.zadn.vn/22/a.jpg' },
        evil: { name: 'X', avatarUrl: '' },
        plain: { name: 'Y', avatarUrl: '' },
      },
    });
    expect(rig.connector.storedAvatarUrl(rig.account.id, 'toan')).toBe('https://s120-26-ava-talk.zadn.vn/22/a.jpg');
    expect(rig.connector.storedAvatarUrl(rig.account.id, 'g')).toBeNull();
  });

  it('is null, never an error, without the hooks or when a lookup fails', async () => {
    rig = makeZaloRig();
    expect(await rig.connector.profiles(rig.account.id, 'peer-1', [])).toBeNull();
    expect(rig.connector.storedAvatarUrl(rig.account.id, 'peer-1')).toBeNull();
    const failing = rig.newConnector({
      profiles: async () => { throw new Error('daemon down'); },
      storedAvatarUrl: () => { throw new Error('db closed'); },
    });
    expect(await failing.profiles(rig.account.id, 'peer-1', [])).toBeNull();
    expect(failing.storedAvatarUrl(rig.account.id, 'peer-1')).toBeNull();
  });
});
