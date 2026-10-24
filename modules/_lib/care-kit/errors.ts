/**
 * Coded domain errors for Customer Care
 */

export type CareErrorCode =
  | 'UNSUPPORTED_CAPABILITY'
  | 'STALE_REVISION'
  | 'DUPLICATE_REQUEST_PAYLOAD_MISMATCH'
  | 'ACCOUNT_FROZEN'
  | 'SEND_DISABLED'
  | 'SYNC_DISABLED'
  | 'UNRESOLVED_UNCERTAINTY'
  | 'CREDENTIAL_DECODE_FAILED'
  | 'RATE_LIMITED'
  | 'FENCING_REJECTED'
  | 'INVALID_TARGET'
  | 'INVALID_CURSOR'
  | 'INVALID_COMMAND'
  | 'CONFIGURATION_CONFLICT'
  | 'NOT_FOUND'
  | 'TERMINAL_REJECTION'
  | 'NETWORK_TIMEOUT';

export class CareError extends Error {
  public readonly code: CareErrorCode;
  public readonly status: number;
  public readonly details?: unknown;

  constructor(code: CareErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'CareError';
    this.code = code;
    this.status = status;
    this.details = details;
    Object.setPrototypeOf(this, CareError.prototype);
  }
}
