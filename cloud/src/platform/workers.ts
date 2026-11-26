/** Adapts Workers bindings (D1, R2) to the platform-neutral `Env`. */
import type { BlobStore, Env, Logger, SqlDb } from '../env';
import type { ConfigVars } from '../config';
import { readConfig } from '../config';
import { googleRemoteKeys } from '../auth/google';

export interface R2Vars {
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

export interface WorkerBindings extends ConfigVars, R2Vars {
  DB: D1Database;
  BUCKET: R2Bucket;
}

export const consoleLogger: Logger = {
  info: (message, fields) => console.log(JSON.stringify({ level: 'info', message, ...fields })),
  warn: (message, fields) => console.warn(JSON.stringify({ level: 'warn', message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: 'error', message, ...fields })),
};

export function r2BlobStore(bucket: R2Bucket): Omit<BlobStore, 'presignPut' | 'presignGet'> {
  return {
    async head(key) {
      const obj = await bucket.head(key);
      return obj ? { size: obj.size, contentType: obj.httpMetadata?.contentType } : null;
    },
    async get(key, range) {
      const obj = await bucket.get(key, range ? { range: { offset: range.offset, length: range.length } } : undefined);
      return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    },
    async put(key, data, contentType) {
      await bucket.put(key, data, contentType ? { httpMetadata: { contentType } } : undefined);
    },
    async delete(keys) {
      const all = Array.isArray(keys) ? keys : [keys];
      // R2 deletes at most 1000 keys per call.
      for (let i = 0; i < all.length; i += 1000) await bucket.delete(all.slice(i, i + 1000));
    },
    async list(prefix, cursor) {
      const res = await bucket.list({ prefix, cursor, limit: 1000 });
      return { keys: res.objects.map((o) => o.key), cursor: res.truncated ? res.cursor : undefined };
    },
  };
}

export function workersEnv(b: WorkerBindings, presign: Pick<BlobStore, 'presignPut' | 'presignGet'>): Env {
  return {
    // D1Database matches SqlDb structurally except for overloads; the cast is the adapter.
    db: b.DB as unknown as SqlDb,
    blobs: { ...r2BlobStore(b.BUCKET), ...presign },
    now: () => Date.now(),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    fetch: (input, init) => fetch(input, init),
    googleKeys: googleRemoteKeys(),
    config: readConfig(b),
    log: consoleLogger,
  };
}
