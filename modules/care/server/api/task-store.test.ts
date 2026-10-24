import { afterEach, describe, expect, it } from 'vitest';
import { CareError } from '../../../_lib/care-kit/errors.js';
import { createTestCareDatabase } from '../persistence/index.js';
import { TEST_KEY } from '../test-fixtures.js';
import { dumpCareTables } from '../test-fixtures.js';

let closeDb: (() => void) | null = null;
afterEach(() => {
  closeDb?.();
  closeDb = null;
});

function setup() {
  const t = createTestCareDatabase(':memory:', TEST_KEY);
  closeDb = t.close;
  const customer = t.stores.customers.createCustomer({ displayName: 'Khach' });
  const task = t.stores.tasks.createTask({ customerId: customer.id, title: 'Goi lai', dueAtMs: 1000, owner: 'An' });
  return { t, task };
}

describe('CareTaskStore.updateTask', () => {
  it('changes only the given fields with one revision bump and keeps the title encrypted', () => {
    const { t, task } = setup();
    const next = t.stores.tasks.updateTask(task.id, { title: 'TITLE-PLAINTEXT-MARKER', dueAtMs: 2000, done: true }, 1);
    expect(next).toMatchObject({ title: 'TITLE-PLAINTEXT-MARKER', dueAtMs: 2000, done: true, owner: 'An', revision: 2 });
    expect(dumpCareTables(t.rawDbForTestIsolationOnly)).not.toContain('TITLE-PLAINTEXT-MARKER');
    expect(t.stores.tasks.updateTask(task.id, { owner: null }, 2)).toMatchObject({ owner: null, revision: 3 });
  });

  it('keeps the revision on a no-op edit', () => {
    const { t, task } = setup();
    const same = t.stores.tasks.updateTask(task.id, { title: 'Goi lai', dueAtMs: 1000, owner: 'An', done: false }, 1);
    expect(same.revision).toBe(1);
    expect(t.stores.tasks.updateTask(task.id, {}, 1).revision).toBe(1);
  });

  it('rejects a stale revision with currentRevision and writes nothing', () => {
    const { t, task } = setup();
    t.stores.tasks.updateTask(task.id, { done: true }, 1);
    try {
      t.stores.tasks.updateTask(task.id, { title: 'lost' }, 1);
      throw new Error('expected STALE_REVISION');
    } catch (err) {
      expect(err).toBeInstanceOf(CareError);
      expect(err).toMatchObject({ code: 'STALE_REVISION', status: 409, details: { currentRevision: 2 } });
    }
    expect(t.stores.tasks.getTask(task.id)).toMatchObject({ title: 'Goi lai', revision: 2 });
  });

  it('rejects unknown tasks and invalid values', () => {
    const { t, task } = setup();
    expect(() => t.stores.tasks.updateTask('missing', { done: true }, 1)).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => t.stores.tasks.updateTask(task.id, { title: '' }, 1)).toThrow(CareError);
    expect(() => t.stores.tasks.updateTask(task.id, { dueAtMs: -5 }, 1)).toThrow(CareError);
    expect(t.stores.tasks.getTask(task.id)!.revision).toBe(1);
  });
});
