/** A fake integration for the core tests, injected through vi.mock of registry.ts. */
import { vi } from 'vitest';
import { IntegrationApiError, type IntegrationDefinition } from './types.js';

export const fakeRun = vi.fn(async (_ctx: unknown, _args: unknown): Promise<unknown> => ({ ok: true }));

export const fakeIntegration: IntegrationDefinition = {
  id: 'fake',
  name: 'Fake',
  category: 'Thử nghiệm',
  description: 'Dịch vụ giả để kiểm thử.',
  setupSteps: ['Mở trang cài đặt.'],
  fields: [
    { key: 'api_key', label: 'API key', kind: 'secret', required: true },
    { key: 'shop_id', label: 'Mã shop', kind: 'text', required: false },
  ],
  async test(values) {
    return values.api_key === 'good-key-1234'
      ? { ok: true, detail: 'Đã kết nối shop Giả', accountLabel: 'Shop Giả', discovered: { shop_id: '42' } }
      : { ok: false, detail: 'API key không đúng.' };
  },
  commands: [
    { name: 'orders list', access: 'read', usage: '[--limit N]', description: 'List orders.', run: fakeRun },
    { name: 'orders get', access: 'read', usage: '<id>', description: 'Get an order.', run: async () => 'get' },
    { name: 'orders get items', access: 'read', usage: '<id>', description: 'Get order items.', run: async () => 'items' },
    { name: 'orders cancel', access: 'write', usage: '<id>', description: 'Cancel an order.', run: fakeRun },
    { name: 'orders purge', access: 'write', risk: 'destructive', usage: '<id>', description: 'Delete an order for good.', run: fakeRun },
    { name: 'boom', access: 'read', usage: '', description: 'Throws.', run: async () => { throw new Error('upstream said good-key-1234'); } },
    { name: 'apifail', access: 'read', usage: '', description: 'Fails.', run: async () => { throw new IntegrationApiError('key good-key-1234 rejected', 401); } },
    { name: 'slow', access: 'read', usage: '', description: 'Never returns.', run: () => new Promise(() => {}) },
  ],
  agentGuide: 'The fake service holds fake orders.',
};

export const fakeRegistry = {
  INTEGRATIONS: [fakeIntegration],
  getIntegration: (id: string) => (id === fakeIntegration.id ? fakeIntegration : undefined),
  listIntegrationIds: () => [fakeIntegration.id],
};
