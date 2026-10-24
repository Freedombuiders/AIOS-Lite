import type { Cipher } from '../core/crypto.js';
import type { DB } from '../core/db.js';
import { parseJson } from '../core/db.js';
import { ModuleError } from './errors.js';
import type { ModuleManifest, ModuleSettingSpec } from './sdk.js';

export const SECRET_MASK = '********';

function coerce(key: string, spec: ModuleSettingSpec, value: unknown): unknown {
  const bad = () => new ModuleError('bad_request', `Giá trị của "${spec.label}" (${key}) không hợp lệ.`);
  switch (spec.type) {
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 1) return true;
      if (value === 'false' || value === 0) return false;
      throw bad();
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (value === '' || value === null || !Number.isFinite(n)) throw bad();
      return n;
    }
    case 'select': {
      const s = String(value);
      if (spec.options && !spec.options.some((o) => o.value === s)) throw bad();
      return s;
    }
    default:
      if (value === null || value === undefined) return '';
      return String(value);
  }
}

/** Per-module settings stored as JSON in modules.settings; secrets are encrypted at rest. */
export function createSettingsStore(db: DB, cipher: Cipher, getManifest: (id: string) => ModuleManifest | undefined) {
  const readRaw = (id: string): Record<string, unknown> => {
    const row = db.prepare('SELECT settings FROM modules WHERE id = ?').get(id) as { settings: string } | undefined;
    return parseJson<Record<string, unknown>>(row?.settings, {});
  };

  const defaults = (manifest: ModuleManifest): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    for (const [k, spec] of Object.entries(manifest.settings ?? {})) if (spec.default !== undefined) o[k] = spec.default;
    return o;
  };

  /** plaintext view for the module itself */
  function all(id: string): Record<string, unknown> {
    const manifest = getManifest(id);
    if (!manifest) return readRaw(id);
    const merged = { ...defaults(manifest), ...readRaw(id) };
    for (const [k, spec] of Object.entries(manifest.settings ?? {})) {
      const v = merged[k];
      if (spec.type === 'secret' && typeof v === 'string' && v) {
        try {
          merged[k] = cipher.decrypt(v);
        } catch {
          merged[k] = '';
        }
      }
    }
    return merged;
  }

  /** view for the API: secret values replaced by a mask */
  function masked(id: string): Record<string, unknown> {
    const manifest = getManifest(id);
    const v = all(id);
    for (const [k, spec] of Object.entries(manifest?.settings ?? {})) {
      if (spec.type === 'secret') v[k] = typeof v[k] === 'string' && v[k] ? SECRET_MASK : '';
    }
    return v;
  }

  function patch(id: string, changes: Record<string, unknown>, version: string): void {
    const manifest = getManifest(id);
    if (!manifest) throw new ModuleError('not_found', `Không tìm thấy module "${id}".`);
    const specs = manifest.settings ?? {};
    const stored = readRaw(id);
    for (const [k, value] of Object.entries(changes)) {
      const spec = specs[k];
      if (!spec) throw new ModuleError('bad_request', `Module "${id}" không có cài đặt "${k}".`);
      if (spec.type === 'secret' && value === SECRET_MASK) continue; // unchanged
      const v = coerce(k, spec, value);
      stored[k] = spec.type === 'secret' && typeof v === 'string' && v ? cipher.encrypt(v) : v;
    }
    const json = JSON.stringify(stored);
    db.prepare(
      `INSERT INTO modules (id, enabled, version, installed_at, settings) VALUES (?, 0, ?, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET settings = excluded.settings`,
    ).run(id, version, json);
  }

  return { all, masked, patch };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
