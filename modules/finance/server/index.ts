import { defineModule, type ModuleContext } from '../../../src/modules/sdk.js';
import { createErpSync, type ErpSync } from './erp/sync.js';
import { connectMcp, type McpConnector, type McpTarget } from './mcp.js';
import { createWhopSync, type WhopSync } from './pnl/whop-sync.js';
import { addEntry, LedgerError } from './profit/ledger.js';
import { registerFinanceRoutes } from './routes.js';
import { agentSummary, monthLedger } from './summary.js';

const ERP_EVERY_MS = 15 * 60_000;
const WHOP_EVERY_MS = 30 * 60_000;

interface Runtime { erp: ErpSync; whop: WhopSync; stops: Array<() => void> }

export function createFinanceModule(connect: McpConnector = connectMcp) {
  const runtimes = new WeakMap<ModuleContext, Runtime>();
  const str = (ctx: ModuleContext, key: string) => String(ctx.settings.get<string>(key, '') ?? '').trim();
  const erpTarget = (ctx: ModuleContext): McpTarget => ({ url: str(ctx, 'erp_mcp_url'), token: str(ctx, 'erp_mcp_token'), command: str(ctx, 'erp_mcp_command') });
  const whopTarget = (ctx: ModuleContext): McpTarget => ({ url: str(ctx, 'whop_mcp_url'), token: str(ctx, 'whop_mcp_token') });

  const runtime = (ctx: ModuleContext): Runtime => {
    let rt = runtimes.get(ctx);
    if (!rt) {
      rt = {
        erp: createErpSync({ db: ctx.db, connect, target: () => erpTarget(ctx) }),
        whop: createWhopSync({ db: ctx.db, connect, target: () => whopTarget(ctx), log: ctx.log }),
        stops: [],
      };
      runtimes.set(ctx, rt);
    }
    return rt;
  };
  const flags = (rt: Runtime) => ({ erpConnected: rt.erp.configured(), whopConnected: rt.whop.configured() });

  return defineModule({
    routes(app, ctx) {
      const rt = runtime(ctx);
      app.use('*', async (c, next) => {
        await next();
        if (c.req.method !== 'GET' && c.res.ok) ctx.events.emit('changed', { path: c.req.path });
      });
      registerFinanceRoutes(app, ctx, rt.erp, rt.whop);
    },

    start(ctx) {
      const rt = runtime(ctx);
      rt.stops.forEach((stop) => stop());
      rt.stops = [
        ctx.schedule.every('erp-sync', ERP_EVERY_MS, async () => {
          if (!rt.erp.configured()) return;
          const status = await rt.erp.run();
          if (!status.ok) ctx.log.warn({ error: status.error }, 'finance: erp sync failed');
        }),
        ctx.schedule.every('whop-sync', WHOP_EVERY_MS, async () => { await rt.whop.run(); }),
      ];
    },

    stop(ctx) {
      runtimes.get(ctx)?.stops.forEach((stop) => stop());
      runtimes.delete(ctx);
    },

    provides(ctx) {
      return { monthLedger: () => monthLedger(ctx.db) };
    },

    agentContext({ scopes }, ctx) {
      if (!scopes.includes('finance.read') && !scopes.includes('finance.write')) return undefined;
      return agentSummary(ctx.db, flags(runtime(ctx)));
    },

    actions: {
      'ledger.add': {
        scope: 'finance.write',
        description: 'Thêm một khoản vào Sổ thu chi. Payload: kind (revenue, refund, direct, overhead, tax, investment, financing, ad_payment, other_ads), amount (số tiền > 0), note (ghi chú ngắn), tuỳ chọn date (YYYY-MM-DD, mặc định hôm nay), productId, cash, cashDate.',
        example: { kind: 'overhead', amount: 1500000, note: 'Phí hosting tháng 10', date: '2026-10-24' },
        async handler(payload, call, ctx) {
          try {
            const { id } = addEntry(ctx.db, payload);
            ctx.audit.log('ledger.add', id, { kind: (payload as { kind?: string }).kind }, call.agentId);
            ctx.events.emit('changed', { path: '/profit/entries' });
            return { ok: true, id };
          } catch (err) {
            if (err instanceof LedgerError) throw new Error(err.message);
            throw err;
          }
        },
      },
    },
  });
}

export default createFinanceModule();
