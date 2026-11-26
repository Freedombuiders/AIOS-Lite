/** Reads the Worker's vars and secrets into a typed Config. */
import type { Config } from './env';

export interface ConfigVars {
  GOOGLE_CLIENT_IDS?: string;
  GOOGLE_WEB_CLIENT_ID?: string;
  GOOGLE_WEB_CLIENT_SECRET?: string;
  ADMIN_EMAILS?: string;
  PUBLIC_URL?: string;
  AUTH_RATE_LIMIT?: string;
  PACK_SIGNING_KEYS?: string;
  UPLOAD_QUOTA_BYTES?: string;
  DEV_MODE?: string;
}

const list = (raw: string | undefined) => (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function signingKeys(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

export function readConfig(vars: ConfigVars): Config {
  const webClientId = vars.GOOGLE_WEB_CLIENT_ID?.trim() || undefined;
  const clientIds = list(vars.GOOGLE_CLIENT_IDS);
  if (webClientId && !clientIds.includes(webClientId)) clientIds.push(webClientId);
  return {
    googleClientIds: clientIds,
    googleWebClientId: webClientId,
    googleWebClientSecret: vars.GOOGLE_WEB_CLIENT_SECRET?.trim() || undefined,
    adminEmails: list(vars.ADMIN_EMAILS).map((e) => e.toLowerCase()),
    publicUrl: vars.PUBLIC_URL?.trim() || undefined,
    authRateLimit: { limit: positiveInt(vars.AUTH_RATE_LIMIT, 30), windowSec: 60 },
    packSigningKeys: signingKeys(vars.PACK_SIGNING_KEYS),
    uploadQuotaBytes: positiveInt(vars.UPLOAD_QUOTA_BYTES, 2 * 1024 ** 3),
    devMode: vars.DEV_MODE === '1' || vars.DEV_MODE === 'true',
  };
}
