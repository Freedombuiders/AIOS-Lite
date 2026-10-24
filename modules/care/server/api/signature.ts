/**
 * Mailbox signature for the composer (read-only).
 *
 * ONE source of truth: the `signatureFor(account)` function the agent turn already takes
 * (`AgentTurnDeps.signatureFor`, application/agent-turn.ts). The runtime passes that same function to
 * `registerCareRoutes({ signatureFor })`, so the composer previews exactly the text a draft will carry. When none is
 * passed there is no signature.
 *
 * Only the signature VALUE is exposed; no other account config (credentials, caps, cursors) crosses this module.
 */

import type { CareAccountRecord } from '../../../_lib/care-kit/types.js';

export type SignatureSource = (account: CareAccountRecord) => string | null;

const MAX_SIGNATURE_CHARS = 2000;

/** Never throws, email accounts only, trimmed and bounded; an empty signature is `null`. */
export function resolveSignature(source: SignatureSource | undefined, account: CareAccountRecord | null): string | null {
  if (!source || !account || account.channel !== 'email') return null;
  try {
    const raw = source(account);
    const text = typeof raw === 'string' ? raw.trim() : '';
    return text ? text.slice(0, MAX_SIGNATURE_CHARS) : null;
  } catch {
    return null; // a broken source shows no signature rather than failing the page
  }
}
