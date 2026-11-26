/** Local stand-in for R2's signed URLs under `wrangler dev`. See src/storage/presign.ts. */
import { Hono } from 'hono';
import type { AppEnv } from '../app-types';
import { badRequest, forbidden, notFound } from '../http/errors';
import { devSignature } from '../storage/presign';

export const devBlobRoutes = new Hono<AppEnv>();

devBlobRoutes.use('*', async (c, next) => {
  const host = new URL(c.req.url).hostname;
  if (!c.env.config.devMode || (host !== '127.0.0.1' && host !== 'localhost')) throw notFound('Không có đường này.');
  await next();
});

function keyOf(path: string): string {
  return decodeURIComponent(path.replace(/^\/_dev\/blobs\//, ''));
}

devBlobRoutes.put('/*', async (c) => {
  const key = keyOf(c.req.path);
  const exp = Number(c.req.query('exp'));
  const type = c.req.header('content-type') ?? '';
  const length = c.req.header('content-length') ?? '';
  if (!(exp > c.env.now()) || c.req.query('sig') !== await devSignature('PUT', key, exp, type, length)) throw forbidden('Chữ ký sai hoặc hết hạn.');
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (String(body.length) !== length) throw badRequest('Độ dài không khớp.');
  await c.env.blobs.put(key, body, type);
  return c.body(null, 200);
});

devBlobRoutes.get('/*', async (c) => {
  const key = keyOf(c.req.path);
  const exp = Number(c.req.query('exp'));
  if (!(exp > c.env.now()) || c.req.query('sig') !== await devSignature('GET', key, exp)) throw forbidden('Chữ ký sai hoặc hết hạn.');
  const data = await c.env.blobs.get(key);
  if (!data) throw notFound();
  const head = await c.env.blobs.head(key);
  return c.body(new Uint8Array(data), 200, { 'content-type': head?.contentType ?? 'application/octet-stream' });
});
