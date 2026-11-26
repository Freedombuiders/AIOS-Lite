import { describe, expect, it } from 'vitest';
import { errorCode, harness } from '../../test/helpers';

async function setup() {
  const h = await harness();
  const admin = await h.login({ sub: 'boss', email: 'boss@example.com', name: 'Chủ' });
  const user = await h.login({ sub: 'lan', email: 'lan@example.com', name: 'Chị Lan' });
  return { h, admin, user };
}

describe('/admin/users', () => {
  it('refuses a normal user with 403 on every admin route', async () => {
    const { h, user, admin } = await setup();
    for (const [method, path, json] of [
      ['GET', '/admin/users', undefined],
      ['PATCH', `/admin/users/${admin.userId}`, { status: 'disabled' }],
      ['GET', '/admin/audit', undefined],
    ] as const) {
      const res = await h.call(method, path, { token: user.token, json });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await errorCode(res)).toBe('forbidden');
    }
  });

  it('lists and searches users', async () => {
    const { h, admin } = await setup();
    const all = await (await h.call('GET', '/admin/users', { token: admin.token })).json() as { items: { email: string }[]; next: string | null };
    expect(all.items.map((u) => u.email).sort()).toEqual(['boss@example.com', 'lan@example.com']);
    expect(all.next).toBeNull();
    const found = await (await h.call('GET', '/admin/users?q=LAN', { token: admin.token })).json() as { items: { email: string }[] };
    expect(found.items.map((u) => u.email)).toEqual(['lan@example.com']);
    const wild = await (await h.call('GET', '/admin/users?q=%25', { token: admin.token })).json() as { items: unknown[] };
    expect(wild.items).toHaveLength(0);
  });

  it('pages with a cursor', async () => {
    const { h, admin } = await setup();
    for (let i = 0; i < 55; i++) {
      h.clock.now += 1;
      await h.login({ sub: `u${i}`, email: `u${i}@example.com` });
    }
    const first = await (await h.call('GET', '/admin/users', { token: admin.token })).json() as { items: { id: string }[]; next: string };
    expect(first.items).toHaveLength(50);
    const second = await (await h.call('GET', `/admin/users?cursor=${first.next}`, { token: admin.token })).json() as { items: { id: string }[]; next: string | null };
    expect(second.items).toHaveLength(7);
    expect(second.next).toBeNull();
    expect(new Set([...first.items, ...second.items].map((u) => u.id)).size).toBe(57);
  });

  it('disabling a user kills their live sessions at once and is audited', async () => {
    const { h, admin, user } = await setup();
    expect((await h.call('GET', '/me', { token: user.token })).status).toBe(200);
    const res = await h.call('PATCH', `/admin/users/${user.userId}`, { token: admin.token, json: { status: 'disabled' } });
    expect(res.status).toBe(200);
    expect((await res.json() as { status: string }).status).toBe('disabled');
    expect((await h.call('GET', '/me', { token: user.token })).status).toBe(401);
    const revoked = await h.env.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NOT NULL').bind(user.userId).first<{ n: number }>();
    expect(revoked!.n).toBe(1);
    // Re-enabling does not bring the old session back.
    await h.call('PATCH', `/admin/users/${user.userId}`, { token: admin.token, json: { status: 'active' } });
    expect((await h.call('GET', '/me', { token: user.token })).status).toBe(401);
    const audit = await (await h.call('GET', '/admin/audit', { token: admin.token })).json() as { items: { actor: string; action: string; target: string; detail: { to: { status: string } } }[] };
    expect(audit.items.map((a) => a.detail.to.status)).toEqual(['active', 'disabled']);
    expect(audit.items[0]).toMatchObject({ actor: admin.userId, action: 'user.update', target: user.userId });
  });

  it('promotes a user to admin', async () => {
    const { h, admin, user } = await setup();
    await h.call('PATCH', `/admin/users/${user.userId}`, { token: admin.token, json: { role: 'admin' } });
    expect((await h.call('GET', '/admin/users', { token: user.token })).status).toBe(200);
  });

  it('the last admin cannot demote or disable themselves', async () => {
    const { h, admin, user } = await setup();
    for (const json of [{ role: 'user' }, { status: 'disabled' }]) {
      const res = await h.call('PATCH', `/admin/users/${admin.userId}`, { token: admin.token, json });
      expect(res.status).toBe(409);
    }
    // With a second admin, stepping down is allowed.
    await h.call('PATCH', `/admin/users/${user.userId}`, { token: admin.token, json: { role: 'admin' } });
    expect((await h.call('PATCH', `/admin/users/${admin.userId}`, { token: admin.token, json: { role: 'user' } })).status).toBe(200);
  });

  it('validates the body and the target', async () => {
    const { h, admin } = await setup();
    expect((await h.call('PATCH', '/admin/users/usr_missing', { token: admin.token, json: { status: 'disabled' } })).status).toBe(404);
    expect((await h.call('PATCH', `/admin/users/${admin.userId}`, { token: admin.token, json: {} })).status).toBe(400);
    expect((await h.call('PATCH', `/admin/users/${admin.userId}`, { token: admin.token, json: { role: 'root' } })).status).toBe(400);
  });
});
