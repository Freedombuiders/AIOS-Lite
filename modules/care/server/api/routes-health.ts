/**
 * GET /api/m/care/health (CC-21): read-only operational snapshot. Sits behind the same module/data-access read
 * gate as every /api/m/care route, and only reports accounts the caller's per-source gate allows, so the
 * aggregates can not leak a blocked source. The body is counts, ages, enums and opaque IDs only (see ops/health.ts).
 */
import type { Hono } from 'hono';
import { getCareHealth } from '../ops/health.js';
import type { CareApiContext } from './context.js';

export function registerHealthRoutes(sub: Hono, ctx: CareApiContext): void {
  sub.get('/health', (c) => {
    const m = ctx.model();
    return c.json(getCareHealth(m.db, m.stores, { nowMs: ctx.now(), accountFilter: (id) => ctx.canReadSource(id) }));
  });
}
