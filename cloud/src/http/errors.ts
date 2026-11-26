/**
 * Errors leave as `{ error: { code, message } }`, the same shape as the core
 * app's docs/dev/API.md. Messages are Vietnamese and never contain a token,
 * an ID token, a one-time code or a signed URL.
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { AppEnv } from '../app-types';

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    /** Extra machine-readable fields, e.g. the file a pack check failed on. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) => new ApiError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Cần đăng nhập.') => new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'Bạn không có quyền làm việc này.') => new ApiError(403, 'forbidden', message);
export const notFound = (message = 'Không tìm thấy.') => new ApiError(404, 'not_found', message);
export const conflict = (message: string) => new ApiError(409, 'conflict', message);
export const tooManyRequests = (message = 'Bạn gửi quá nhiều yêu cầu, hãy thử lại sau.') => new ApiError(429, 'rate_limited', message);

export function errorResponse(c: Context<AppEnv>, err: ApiError) {
  return c.json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }, err.status);
}

export function onError(err: Error, c: Context<AppEnv>) {
  if (err instanceof ApiError) return errorResponse(c, err);
  // Log the error class and message only; never the request headers or body.
  c.env.log.error('unhandled error', { name: err.name, message: err.message.slice(0, 200), path: c.req.path });
  return c.json({ error: { code: 'internal', message: 'Lỗi máy chủ, hãy thử lại sau.' } }, 500);
}

export function notFoundHandler(c: Context<AppEnv>) {
  return c.json({ error: { code: 'not_found', message: 'Không có đường này.' } }, 404);
}

/** Parses the JSON body with a zod schema; a bad body is a 400 naming the first bad field. */
export async function readJson<S extends z.ZodType>(c: Context<AppEnv>, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw badRequest('Thân yêu cầu không phải JSON hợp lệ.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || 'thân yêu cầu';
    throw badRequest(`Trường "${field}" không hợp lệ.`);
  }
  return parsed.data;
}
