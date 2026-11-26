import type { Context } from 'hono';
import { defineModule, type ModuleContext } from '../../../src/modules/sdk.js';
import type { CareCustomersApi } from '../../care/server/customers-service.js';
import { customerDetail, customerRow } from './views.js';
import { createExporter, type CrmExporter } from './exporter.js';

/** how often the exporter looks at care's change feed (a new customer shows up as a note within a few seconds) */
const POLL_MS = 3_000;

const exporters = new WeakMap<ModuleContext, CrmExporter>();
const stopped = new WeakSet<ModuleContext>();

export function crmExporter(ctx: ModuleContext): CrmExporter {
  let ex = exporters.get(ctx);
  if (!ex) {
    ex = createExporter({
      db: ctx.db,
      notes: ctx.brain.notes,
      care: () => ctx.modules.get<{ customers?: CareCustomersApi }>('care')?.customers,
      folderId: () => {
        const v = ctx.settings.get<unknown>('folderId');
        return typeof v === 'string' && v.trim() ? v.trim() : undefined;
      },
      attention: ctx.attention,
      log: ctx.log,
    });
    exporters.set(ctx, ex);
  }
  return ex;
}

const tick = async (ctx: ModuleContext) => {
  if (stopped.has(ctx)) return;
  await crmExporter(ctx)
    .run()
    .catch((err) => ctx.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'crm: lượt xuất ghi chú lỗi'));
};

export default defineModule({
  routes(app, ctx) {
    // read-only: what the exporter is doing, and which note mirrors which customer
    app.get('/status', (c) => c.json(crmExporter(ctx).status()));

    const folderIdOf = (ctx: ModuleContext) => ctx.settings.get<string>('folderId', '')?.trim() || null;
    const unavailable = (c: Context) => c.json({ error: { code: 'unavailable', message: 'Module Chăm sóc khách hàng chưa bật.' } }, 409);

    app.get('/customers', (c) => {
      const care = ctx.modules.get<{ customers?: CareCustomersApi }>('care')?.customers;
      if (!care) return unavailable(c);
      const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
      const page = care.list({ after: c.req.query('after') || null, limit });
      const ex = crmExporter(ctx);
      const folderId = folderIdOf(ctx);
      return c.json({ items: page.items.map((v) => customerRow(v, ex.indexRow(v.id), folderId)), next: page.next });
    });

    app.get('/customers/:id', (c) => {
      const care = ctx.modules.get<{ customers?: CareCustomersApi }>('care')?.customers;
      if (!care) return unavailable(c);
      const id = c.req.param('id');
      const v = care.get(id);
      if (!v) return c.json({ error: { code: 'not_found', message: 'Không tìm thấy khách này.' } }, 404);
      return c.json(customerDetail(v, care.history(id, 20), crmExporter(ctx).indexRow(id), folderIdOf(ctx)));
    });
  },

  start(ctx) {
    stopped.delete(ctx);
    // never block startup: the first full export runs in the background, in batches
    setImmediate(() => void tick(ctx));
    ctx.schedule.every('export-notes', POLL_MS, () => tick(ctx));
  },

  async stop(ctx) {
    stopped.add(ctx);
    await exporters.get(ctx)?.stop();
    exporters.delete(ctx);
  },
});
