// Stored credentials (encrypted with the core cipher) and the owner-facing summary built from them.
// Secrets leave this module in the clear only through loadValues(), called server-side by the runner and the test route.
import { createHash } from 'node:crypto';
import type { Cipher } from '../core/crypto.js';
import { protectValue } from '../core/redact.js';
import type { IntegrationGrantSetting } from '../core/types.js';
import { policyOf } from './access.js';
import type { CredentialRow, IntegrationDb } from './db.js';
import type { IntegrationDefinition, IntegrationRisk, IntegrationTestResult, IntegrationValues } from './types.js';

export type IntegrationStatus = 'not_configured' | 'unchecked' | 'ok' | 'error';

export interface IntegrationSummary {
  id: string;
  name: string;
  category: string;
  description: string;
  docsUrl?: string;
  authKind: 'api-key' | 'oauth';
  group?: 'google';
  setupSteps: string[];
  fields: { key: string; label: string; kind: 'secret' | 'text'; required: boolean; placeholder?: string; help?: string; value: string }[];
  status: IntegrationStatus;
  statusDetail: string;
  accountLabel: string;
  checkedAt: string | null;
  commands: { name: string; access: 'read' | 'write'; risk: IntegrationRisk; usage: string; description: string }[];
  grantedTo: { agentId: string; grant: string }[];
  calls24h: number;
}

/** "••••" plus the last four characters; short values show only the dots. */
export function maskSecret(value: string): string {
  return '••••' + (value.length > 4 ? value.slice(-4) : '');
}

export interface AgentGrants { agentId: string; integrations?: Record<string, IntegrationGrantSetting> }

/**
 * What a PUT stores: the owner's input over the stored values. A secret sent empty or omitted keeps the
 * stored one; text sent empty clears it. Keys the definition does not declare are dropped.
 */
export function mergeValues(definition: IntegrationDefinition, stored: IntegrationValues | null, incoming: Record<string, unknown>): IntegrationValues {
  const merged: IntegrationValues = {};
  for (const field of definition.fields) {
    const previous = stored?.[field.key] ?? '';
    const sent = incoming[field.key];
    if (typeof sent !== 'string') { merged[field.key] = previous; continue; }
    const value = sent.trim();
    merged[field.key] = field.kind === 'secret' && value === '' ? previous : value;
  }
  return merged;
}

/** Labels of the required fields that are still empty. */
export function missingRequired(definition: IntegrationDefinition, values: IntegrationValues): string[] {
  return definition.fields.filter((f) => f.required && !values[f.key]).map((f) => f.label);
}

export function createCredentialStore(deps: {
  idb: IntegrationDb;
  cipher: Cipher;
  /** fallback for the shared Composio project key (e.g. COMPOSIO_API_KEY from .env) */
  composioFallback?: () => string | undefined;
}) {
  const { idb, cipher } = deps;

  function decode(row: CredentialRow): IntegrationValues | null {
    try {
      const parsed = JSON.parse(cipher.decrypt(row.valuesEnc)) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const values: IntegrationValues = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'string') values[k] = v;
      return values;
    } catch {
      return null;
    }
  }

  /** Stored values decrypted; every value is registered for log redaction. Null when nothing usable is stored. */
  function loadValues(id: string): IntegrationValues | null {
    const row = idb.getCredentials(id);
    let values = row ? decode(row) : null;
    if (!values && id === 'composio') {
      const key = deps.composioFallback?.()?.trim();
      if (key) values = { api_key: key };
    }
    if (values) for (const v of Object.values(values)) protectValue(v);
    return values;
  }

  function save(id: string, values: IntegrationValues, result: IntegrationTestResult): void {
    const stored = { ...values, ...(result.discovered ?? {}) };
    idb.upsertCredentials(id, cipher.encrypt(JSON.stringify(stored)), 'ok', result.detail, result.accountLabel ?? '');
  }

  function recordTest(id: string, result: IntegrationTestResult): void {
    idb.setStatus(id, result.ok ? 'ok' : 'error', result.detail, result.accountLabel ?? '');
  }

  function summarise(definition: IntegrationDefinition, row: CredentialRow | undefined, agents: AgentGrants[], calls24h: number): IntegrationSummary {
    const values = row ? decode(row) : null;
    const projectKey = definition.authKind === 'oauth' && row ? loadValues('composio')?.api_key : undefined;
    const staleOAuth = definition.authKind === 'oauth' && !!row
      && (!projectKey || values?.key_fingerprint !== createHash('sha256').update(projectKey).digest('hex'));
    return {
      id: definition.id,
      name: definition.name,
      category: definition.category,
      description: definition.description,
      ...(definition.docsUrl ? { docsUrl: definition.docsUrl } : {}),
      authKind: definition.authKind ?? 'api-key',
      ...(definition.group ? { group: definition.group } : {}),
      setupSteps: definition.setupSteps,
      fields: definition.fields.map((f) => {
        const value = values?.[f.key] ?? '';
        return {
          key: f.key, label: f.label, kind: f.kind, required: f.required,
          ...(f.placeholder ? { placeholder: f.placeholder } : {}),
          ...(f.help ? { help: f.help } : {}),
          value: value === '' ? '' : f.kind === 'secret' ? maskSecret(value) : value,
        };
      }),
      status: staleOAuth ? 'error' : row ? (row.status as IntegrationStatus) : 'not_configured',
      statusDetail: staleOAuth ? 'Composio đã bị ngắt hoặc đổi API key. Vui lòng đăng nhập lại dịch vụ.' : row?.statusDetail ?? '',
      accountLabel: row?.accountLabel ?? '',
      checkedAt: row?.checkedAt ? new Date(row.checkedAt * 1000).toISOString() : null,
      commands: definition.commands.map(({ name, access, risk, usage, description }) => ({ name, access, risk: risk ?? access, usage, description })),
      grantedTo: agents.flatMap((a) => {
        const { grant } = policyOf(a.integrations?.[definition.id]);
        return grant === 'off' ? [] : [{ agentId: a.agentId, grant }];
      }),
      calls24h,
    };
  }

  const since24h = () => Math.floor(Date.now() / 1000) - 24 * 3600;

  return {
    loadValues,
    save,
    recordTest,
    remove: (id: string) => idb.deleteCredentials(id),
    status: (id: string): IntegrationStatus => (idb.getCredentials(id)?.status as IntegrationStatus | undefined) ?? 'not_configured',
    summary(definition: IntegrationDefinition, agents: AgentGrants[]): IntegrationSummary {
      return summarise(definition, idb.getCredentials(definition.id), agents, idb.countCallsSince(definition.id, since24h()));
    },
    summaries(definitions: IntegrationDefinition[], agents: AgentGrants[]): IntegrationSummary[] {
      const rows = new Map(idb.listCredentials().map((r) => [r.integrationId, r]));
      const since = since24h();
      return definitions.map((d) => summarise(d, rows.get(d.id), agents, idb.countCallsSince(d.id, since)));
    },
  };
}

export type CredentialStore = ReturnType<typeof createCredentialStore>;
