import { describe, expect, it } from 'vitest';
import { ModuleManifestSchema } from './loader.js';

const base = { id: 'demo', name: 'Demo', description: 'x', version: '0.1.0', tables: [] };

describe('module manifest category', () => {
  it.each(['studio', 'sales', 'care', 'brain', 'marketing', 'finance', 'ops', 'other'])('accepts %s', (category) => {
    expect(ModuleManifestSchema.safeParse({ ...base, category }).success).toBe(true);
  });

  it('rejects a group the sidebar does not know', () => {
    expect(ModuleManifestSchema.safeParse({ ...base, category: 'games' }).success).toBe(false);
  });
});
