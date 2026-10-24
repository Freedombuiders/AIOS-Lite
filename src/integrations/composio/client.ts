import { Composio } from '@composio/core';
import { createHash } from 'node:crypto';
import { IntegrationApiError, IntegrationUsageError, type ParsedArgs } from '../types.js';

/** Where the shared Composio project key comes from; set by createIntegrationService. */
let keySource: () => string | undefined = () => undefined;
export function setComposioKeySource(source: () => string | undefined): void { keySource = source; }

export function composioKey(): string {
  const key = keySource()?.trim() || undefined;
  if (!key) throw new IntegrationApiError('Kết nối Composio bằng API key trước, sau đó chọn dịch vụ Google.');
  return key;
}
export const keyFingerprint = (key: string) => createHash('sha256').update(key).digest('hex');
export const composioClient = (key = composioKey()) => new Composio({ apiKey: key });
export function safeConnectionError(): IntegrationApiError {
  return new IntegrationApiError('Không kết nối được dịch vụ. Kiểm tra API key, quyền tài khoản và thử lại.');
}
export function jsonArguments(args: ParsedArgs): Record<string, unknown> {
  try {
    const raw = args.flags.json;
    if (raw === undefined) return {};
    if (typeof raw !== 'string') throw new Error();
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new IntegrationUsageError('--json cần là một JSON object hợp lệ.'); }
}
