import { defineModule } from '../../../../sdk.js';

type FxState = { started: number; stopped: number; ticks: number; finished: number[]; failStart?: boolean };
const state = ((globalThis as Record<string, unknown>).__fx ??= { started: 0, stopped: 0, ticks: 0, finished: [] }) as FxState;

export default defineModule({
  routes(app, ctx) {
    app.get('/ping', (c) => c.json({ pong: true, id: ctx.id }));
    app.post('/echo', async (c) => c.json({ body: await c.req.json() }));
  },
  start(ctx) {
    if (state.failStart) throw new Error('boom');
    state.started++;
    ctx.schedule.every('tick', 10, () => void state.ticks++);
  },
  stop() {
    state.stopped++;
  },
  onTaskFinished(task) {
    state.finished.push(task.id);
  },
  contextFor: () => 'ctx-fx',
  provides: () => ({ hello: () => 'hi' }),
});
