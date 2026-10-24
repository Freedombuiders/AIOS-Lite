import type { Context } from 'hono';
import { ZodError } from 'zod';
import type { Logger } from '../core/log.js';
import { redactString } from '../core/redact.js';

export type ApiErrorCode = 'bad_request' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'requirements_missing' | 'internal';

export const STATUS: Record<ApiErrorCode, 400 | 401 | 403 | 404 | 409 | 412 | 500> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  requirements_missing: 412,
  internal: 500,
};

export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (m: string) => new ApiError('bad_request', m);
export const notFound = (m: string) => new ApiError('not_found', m);
export const conflict = (m: string) => new ApiError('conflict', m);

export function errorBody(code: ApiErrorCode, message: string) {
  return { error: { code, message } };
}

/** Vietnamese message for the first zod issues. */
export function zodMessage(err: ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'nội dung'}: ${i.message}`)
    .join('; ');
}

export function handleError(log: Logger) {
  return (err: Error, c: Context) => {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code in STATUS) {
      const k = code as ApiErrorCode;
      return c.json(errorBody(k, redactString(err.message)), STATUS[k]);
    }
    if (err instanceof ZodError) return c.json(errorBody('bad_request', `Dữ liệu không hợp lệ: ${zodMessage(err)}`), 400);
    log.error({ err, path: c.req.path }, 'api error');
    return c.json(errorBody('internal', 'Đã xảy ra lỗi nội bộ.'), 500);
  };
}
