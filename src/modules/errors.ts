export type ModuleErrorCode = 'bad_request' | 'not_found' | 'conflict' | 'requirements_missing';

/** Error with an API-compatible code; the API layer maps `code` to an HTTP status. */
export class ModuleError extends Error {
  constructor(
    public readonly code: ModuleErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ModuleError';
  }
}
