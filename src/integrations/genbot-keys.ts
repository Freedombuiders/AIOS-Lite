// GenBot Bot API keys, one per bot (= AIOS agent with runtime genbot), pasted by the owner on the Đội AI · Bot screen.
// Stored with the existing credentials store (encrypted with the core cipher, table integration_credentials, row id
// `genbot-key:<agentId>`). The key leaves this module only through get(), called by the genbot runtime in this process:
// it is never returned by an API (status() gives "đã có khoá" + the last four characters), never written to agent.yaml,
// a log line or an event (every loaded value is registered with core/redact). GenBot is the only engine and is reached over HTTP: no child process ever gets a key.
import type { Cipher } from '../core/crypto.js';
import type { DB } from '../core/db.js';
import { protectCoreValue } from '../core/secret-env.js';
import { createIntegrationDb } from './db.js';
import { createCredentialStore } from './store.js';

const PREFIX = 'genbot-key:';
const KEY_RE = /^[\x21-\x7e]{8,512}$/;

export interface GenbotKeyStatus {
  hasKey: boolean;
  /** last four characters, only when a key is stored */
  last4: string;
  updatedAt: string | null;
}

export class GenbotKeyError extends Error {}

/** Checks a pasted key without ever echoing it. */
export function validateGenbotKey(raw: unknown): string {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key) throw new GenbotKeyError('Chưa dán khoá Bot API.');
  if (!KEY_RE.test(key)) throw new GenbotKeyError(`Khoá Bot API không hợp lệ (${key.length} ký tự): khoá dài 8–512 ký tự, không có khoảng trắng. Chép lại nguyên khoá từ thẻ Bot API trong app GenBot.`);
  return key;
}

export function createGenbotKeyStore(deps: { db: DB; cipher: Cipher }) {
  const idb = createIntegrationDb(deps.db);
  const store = createCredentialStore({ idb, cipher: deps.cipher });
  const rowId = (agentId: string) => `${PREFIX}${agentId}`;

  function get(agentId: string): string | undefined {
    if (!agentId) return undefined;
    const key = store.loadValues(rowId(agentId))?.key?.trim();
    // masked in logs, errors and events
    protectCoreValue(key);
    return key || undefined;
  }

  return {
    get,
    /** Stores (or replaces) the key of one bot. Rotating = calling it again. */
    set(agentId: string, rawKey: unknown): GenbotKeyStatus {
      const key = validateGenbotKey(rawKey);
      protectCoreValue(key);
      store.save(rowId(agentId), { key }, { ok: true, detail: '' });
      return this.status(agentId);
    },
    remove(agentId: string): void {
      store.remove(rowId(agentId));
    },
    has: (agentId: string) => !!get(agentId),
    status(agentId: string): GenbotKeyStatus {
      const row = idb.getCredentials(rowId(agentId));
      const key = row ? get(agentId) : undefined;
      if (!key) return { hasKey: false, last4: '', updatedAt: null };
      return { hasKey: true, last4: key.length > 8 ? key.slice(-4) : '', updatedAt: new Date(row!.updatedAt * 1000).toISOString() };
    },
    /** Registers every stored key with the redactor (at boot, before any run or log line can carry one). */
    protectAll(): number {
      let n = 0;
      for (const row of idb.listCredentials()) {
        if (!row.integrationId.startsWith(PREFIX)) continue;
        if (get(row.integrationId.slice(PREFIX.length))) n++;
      }
      return n;
    },
  };
}

export type GenbotKeyStore = ReturnType<typeof createGenbotKeyStore>;

const memo = new WeakMap<object, GenbotKeyStore>();

/** The app's key store (main.ts builds it); test harnesses that build AppDeps by hand get one over their db. */
export function genbotKeysFor(deps: { db: DB; cipher: Cipher; genbotKeys?: GenbotKeyStore }): GenbotKeyStore {
  if (deps.genbotKeys) return deps.genbotKeys;
  let s = memo.get(deps.db);
  if (!s) {
    s = createGenbotKeyStore(deps);
    memo.set(deps.db, s);
  }
  return s;
}
