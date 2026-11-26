import { defineModule, type ModuleContext } from '../../../src/modules/sdk.js';
import type { CareCustomersApi } from '../../care/server/customers-service.js';
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

    app.get('/customers', (c) => {
      const care = ctx.modules.get<{ customers?: CareCustomersApi }>('care')?.customers;
      if (!care) return c.json({ error: { code: 'unavailable', message: 'Module Chăm sóc khách hàng chưa bật.' } }, 409);
      const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
      const page = care.list({ after: c.req.query('after') || null, limit });
      const ex = crmExporter(ctx);
      const folderId = ctx.settings.get<string>('folderId', '')?.trim() || null;
      return c.json({
        items: page.items.map((v) => {
          const row = ex.indexRow(v.id);
          const inFolder = !!row && row.folder_id === folderId;
          return {
            id: v.id,
            ten: v.displayName,
            giaiDoan: v.stage,
            folderId: inFolder ? row!.folder_id : null,
            notePath: inFolder ? row!.rel_path : null,
            exportedAt: inFolder ? row!.exported_at : null,
            /** da-xuat: the note was written after the customer's last change; cho-xuat: a change is not exported yet */
            trangThai: !inFolder ? 'chua-xuat' : row!.exported_at >= v.lastChangeAtMs ? 'da-xuat' : 'cho-xuat',
          };
        }),
        next: page.next,
      });
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
