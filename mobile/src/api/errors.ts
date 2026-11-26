/**
 * What can go wrong calling the cloud, as a closed set the screens can switch on.
 * The cloud's own messages are Vietnamese only, so the UI shows its own text per
 * kind (see errorMessageKey) and keeps the server's message for debugging.
 * A CloudError never carries a token, a header or a request body.
 */
export type CloudErrorKind =
  /** 401 on a call made with a session token: expired, revoked, or the user was disabled. */
  | 'unauthorized'
  /** 401 on a sign-in call: the cloud did not accept the credential (bad or expired ID token). */
  | 'credentials'
  /** 403 on a sign-in call: the account is disabled. */
  | 'disabled'
  /** 403 on any other call. */
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'bad_request'
  /** The request never got an answer: no connection, DNS, refused. */
  | 'network'
  /** No answer within the time limit. */
  | 'timeout'
  | 'server'
  /** A 2xx whose body is not what the types promise. */
  | 'invalid_response'
  /** The app has no cloud address. */
  | 'not_configured';

export class CloudError extends Error {
  constructor(
    readonly kind: CloudErrorKind,
    readonly status?: number,
    /** The cloud's machine-readable error code, e.g. "forbidden". */
    readonly code?: string,
    /** The cloud's message (Vietnamese). For logs and tests, not for the UI. */
    readonly serverMessage?: string,
  ) {
    super(`cloud error: ${kind}${status ? ` (${status})` : ''}`);
    this.name = 'CloudError';
  }

  /** Trying again later can help. */
  get retryable(): boolean {
    return this.kind === 'network' || this.kind === 'timeout' || this.kind === 'server' || this.kind === 'rate_limited';
  }
}

export const isCloudError = (e: unknown): e is CloudError => e instanceof CloudError;

export function errorMessageKey(error: unknown):
  | 'errors.network' | 'errors.timeout' | 'errors.server' | 'errors.rateLimited' | 'errors.notFound'
  | 'errors.forbidden' | 'errors.invalidResponse' | 'errors.notConfigured' | 'errors.generic' {
  if (!isCloudError(error)) return 'errors.generic';
  switch (error.kind) {
    case 'network': return 'errors.network';
    case 'timeout': return 'errors.timeout';
    case 'server': return 'errors.server';
    case 'rate_limited': return 'errors.rateLimited';
    case 'not_found': return 'errors.notFound';
    case 'forbidden': return 'errors.forbidden';
    case 'invalid_response': return 'errors.invalidResponse';
    case 'not_configured': return 'errors.notConfigured';
    default: return 'errors.generic';
  }
}
