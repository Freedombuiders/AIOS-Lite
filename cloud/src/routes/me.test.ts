import { describe, expect, it } from 'vitest';
import { harness } from '../../test/helpers';

describe('/me', () => {
  it('lists the live sessions and marks the current one', async () => {
    const h = await harness();
    const a = await h.login({}, 'mobile');
    await h.login({}, 'machine');
    const res = await h.call('GET', '/me', { token: a.token });
    const body = await res.json() as { user: { email: string }; sessions: { kind: string; current: boolean }[] };
    expect(body.user.email).toBe('lan@example.com');
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions.filter((s) => s.current)).toHaveLength(1);
  });

  it('revokes one of my sessions but not someone else\'s', async () => {
    const h = await harness();
    const mine = await h.login({}, 'mobile');
    const other = await h.login({}, 'machine');
    const stranger = await h.login({ sub: 'stranger', email: 's@example.com' });
    const sessions = (await (await h.call('GET', '/me', { token: mine.token })).json() as { sessions: { id: string; current: boolean }[] }).sessions;
    const otherId = sessions.find((s) => !s.current)!.id;
    expect((await h.call('DELETE', `/me/sessions/${otherId}`, { token: stranger.token })).status).toBe(404);
    expect((await h.call('DELETE', `/me/sessions/${otherId}`, { token: mine.token })).status).toBe(200);
    expect((await h.call('GET', '/me', { token: other.token })).status).toBe(401);
    expect((await h.call('GET', '/me', { token: mine.token })).status).toBe(200);
  });

  it('DELETE /me removes the account and every session', async () => {
    const h = await harness();
    const a = await h.login();
    const b = await h.login({}, 'machine');
    expect((await h.call('DELETE', '/me', { token: a.token })).status).toBe(200);
    expect((await h.call('GET', '/me', { token: b.token })).status).toBe(401);
    expect((await h.env.db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())!.n).toBe(0);
    expect((await h.env.db.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>())!.n).toBe(0);
    // Signing in again starts a fresh account.
    const again = await h.login();
    expect(again.userId).not.toBe(a.userId);
  });

  it('refuses to delete the last admin', async () => {
    const h = await harness();
    const boss = await h.login({ sub: 'boss', email: 'boss@example.com' });
    const res = await h.call('DELETE', '/me', { token: boss.token });
    expect(res.status).toBe(409);
  });
});
