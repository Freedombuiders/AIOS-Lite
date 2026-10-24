import type { Context } from 'hono';
import type { ZodType } from 'zod';
import { badRequest, notFound, zodMessage } from './errors.js';

const typeVi: Record<string, string> = { string: 'chuỗi', number: 'số', boolean: 'đúng/sai', object: 'đối tượng', array: 'danh sách', int: 'số nguyên' };

const viError = (iss: { code: string; input?: unknown; expected?: unknown; minimum?: unknown; maximum?: unknown; origin?: string; message?: string }): string => {
  switch (iss.code) {
    case 'invalid_type':
      return iss.input === undefined ? 'bắt buộc' : `phải là ${typeVi[String(iss.expected)] ?? String(iss.expected)}`;
    case 'too_small':
      return iss.origin === 'string' ? (Number(iss.minimum) <= 1 ? 'không được để trống' : `tối thiểu ${iss.minimum} ký tự`) : `không nhỏ hơn ${iss.minimum}`;
    case 'too_big':
      return iss.origin === 'string' ? `tối đa ${iss.maximum} ký tự` : `không lớn hơn ${iss.maximum}`;
    case 'invalid_value':
      return 'giá trị không hợp lệ';
    case 'invalid_format':
      return 'định dạng không hợp lệ';
    case 'unrecognized_keys':
      return 'có trường không được hỗ trợ';
    default:
      return iss.message ?? 'không hợp lệ';
  }
};

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data, { error: (iss) => viError(iss as never) });
  if (!r.success) throw badRequest(`Dữ liệu không hợp lệ: ${zodMessage(r.error)}`);
  return r.data;
}

export async function readJson(c: Context, opts: { optional?: boolean } = {}): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) {
    if (opts.optional) return {};
    throw badRequest('Thiếu nội dung JSON.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('Nội dung gửi lên không phải JSON hợp lệ.');
  }
}

export async function body<T>(c: Context, schema: ZodType<T>, opts: { optional?: boolean } = {}): Promise<T> {
  return parse(schema, await readJson(c, opts));
}

export function intParam(c: Context, name = 'id'): number {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`Tham số ${name} không hợp lệ.`);
  return n;
}

export function optInt(c: Context, name: string): number | undefined {
  const v = c.req.query(name);
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw badRequest(`Tham số ${name} không hợp lệ.`);
  return n;
}

export function limitParam(c: Context, fallback = 50): number {
  const n = optInt(c, 'limit') ?? fallback;
  return Math.min(500, Math.max(1, n));
}

export function csv(c: Context, name: string): string[] | undefined {
  const v = c.req.query(name);
  if (!v) return undefined;
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

export function found<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw notFound(`Không tìm thấy ${what}.`);
  return value;
}
