import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import module from './index.js';
import { makeContext } from './test-context.js';
it('declares dependencies and every migration table without integration or MCP ownership', () => {
  const manifest = JSON.parse(readFileSync(new URL('../module.json', import.meta.url), 'utf8'));
  const sql = readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8');
  expect(manifest.requires).toEqual({ modules: ['care'], connections: ['composio'] });
  expect(manifest.tables.sort()).toEqual([...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]).sort());
  expect(manifest.tables.every((name: string) => name.startsWith('email_'))).toBe(true);
});
it('registers the Gmail connector, polls every two minutes and unregisters on stop', async () => {
  const h = makeContext();
  try {
    await module.start!(h.ctx); await module.start!(h.ctx);
    expect(h.care.careChannels.register).toHaveBeenCalledTimes(1);
    expect(h.ctx.schedule.every).toHaveBeenCalledWith('gmail-sync', 120_000, expect.any(Function));
    await module.stop!(h.ctx);
    expect(h.care.careChannels.unregister).toHaveBeenCalledWith('gmail-composio');
    expect(vi.mocked(h.ctx.schedule.every).mock.results[0].value).toHaveBeenCalledOnce();
  } finally { h.close(); }
});
it('starts and stops safely when Care is absent', async () => {
  const h = makeContext();
  try {
    vi.spyOn(h.ctx.modules, 'get').mockReturnValue(undefined); vi.spyOn(h.ctx.modules, 'isEnabled').mockReturnValue(false);
    await module.start!(h.ctx); await module.stop!(h.ctx); expect(h.care.careChannels.register).not.toHaveBeenCalled();
  } finally { h.close(); }
});
