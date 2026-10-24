import { beforeEach, describe, expect, it } from 'vitest';

import { setKv as setDashboardSetting } from './kv.js';
import { _initTestDatabase } from './test-db.js';
import { CONFIG_KEY, ConfigError, deepMerge, loadConfig, resetConfig, saveConfig, setEnabled } from './config.js';
import { defaultRadarConfig } from './defaults.js';

beforeEach(() => _initTestDatabase());

describe('radar config', () => {
  it('defaults: off, three layers with taxonomies', () => {
    const c = loadConfig();
    expect(c.enabled).toBe(false);
    expect(c.layers.vn.topics).toHaveLength(9);
    expect(c.layers.nganh.topics).toHaveLength(8);
    expect(c.layers.world.topics).toHaveLength(8);
    expect(c.layers.nganh.time).toBe('20:00');
  });

  it('deep-merges stored config over defaults so new fields appear', () => {
    setDashboardSetting(CONFIG_KEY, JSON.stringify({ owner: { name: 'Minh' }, layers: { vn: { time: '06:30' } } }));
    const c = loadConfig();
    expect(c.owner.name).toBe('Minh');
    expect(c.owner.channels).toEqual(['Mọi kênh']);
    expect(c.layers.vn.time).toBe('06:30');
    expect(c.layers.vn.fbGroups.length).toBeGreaterThan(0);
  });

  it('arrays replace instead of merging', () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });

  it('saves a valid config and rejects bad fields naming them', () => {
    const c = defaultRadarConfig();
    c.owner.name = 'Minh';
    expect(saveConfig(c).owner.name).toBe('Minh');
    expect(loadConfig().owner.name).toBe('Minh');

    const bad = defaultRadarConfig();
    bad.layers.vn.time = '7h';
    expect(() => saveConfig(bad)).toThrow(ConfigError);
    try { saveConfig(bad); } catch (e) { expect((e as Error).message).toMatch(/giờ quét/); }

    const tz = defaultRadarConfig();
    tz.timezone = 'Mars/Base';
    expect(() => saveConfig(tz)).toThrow(/múi giờ/);
  });

  it('toggles enabled and resets', () => {
    expect(setEnabled(true).enabled).toBe(true);
    expect(loadConfig().enabled).toBe(true);
    saveConfig({ ...defaultRadarConfig(), owner: { name: 'X', channels: [], about: '' } });
    expect(resetConfig().owner.name).toBe('');
  });
});
