/**
 * Module learn.
 * Part 1 (T14, Facebook): each post published through marketing becomes a `bai-dang` note in noi-dung/bai/ of the
 * brain folder chosen in the settings, with one `so_do` entry per measured milestone. Marketing's contentFeed is
 * read with a cursor stored in learn_state: on start it catches up from that cursor, then a 5-second timer reads
 * what is new. With no folder chosen, nothing is read or written.
 * Part 2 (T15): the lesson book (bai-hoc/, playbook.ts), the weekly review (tong-ket/, weekly.ts, Monday 07:30 and
 * caught up on start), score-draft for marketing's composer, and verified lessons in the agents' context.
 */
import type { ContentFeed } from '../../_lib/content-feed.js';
import { defineModule, type ModuleContext } from '../../../src/modules/sdk.js';
import { lessonContext, READ_SCOPE } from './agent-context.js';
import type { DraftStatsFn } from './metrics.js';
import { DEFAULT_TZ } from './note-format.js';
import { createPlaybook, type Playbook } from './playbook.js';
import { createPostNoteSync, type PostNoteSync } from './post-notes.js';
import { registerLoopRoutes, type LoopState } from './routes-loop.js';
import { registerRoutes } from './routes.js';
import { createScorer, type Scorer } from './score-draft.js';
import { createWeekly, WEEKLY_CRON, type Weekly } from './weekly.js';

interface MarketingProvides {
  contentFeed?: ContentFeed;
  pageInfo?(pageId: string): { timezone?: string } | undefined;
}

const POLL_MS = 5_000;
/** the machine pass over the lessons (evidence, trials) and the weekly catch-up check */
const EVALUATE_MS = 5 * 60_000;

interface LearnState extends LoopState {
  sync: PostNoteSync;
  playbook: Playbook;
  weekly: Weekly;
  scorer: Scorer;
}

let state: LearnState | null = null;

function build(ctx: ModuleContext): LearnState {
  const marketing = () => ctx.modules.get<MarketingProvides>('marketing');
  const folder = () => String(ctx.settings.get<string>('folder', '') ?? '');
  const moc = () => String(ctx.settings.get<string>('moc', '24h') ?? '24h');
  const agentId = () => String(ctx.settings.get<string>('agent', '') ?? '');
  const canUse = (id: string) => !!id && !!ctx.agents.get(id) && ctx.access.can(id, READ_SCOPE);
  const drafts = () => ctx.modules.get<{ draftStats?: DraftStatsFn }>('care')?.draftStats;
  const sync = createPostNoteSync({
    db: ctx.db,
    notes: ctx.brain.notes,
    feed: () => marketing()?.contentFeed,
    folder,
    timezone: (pageId) => (pageId ? marketing()?.pageInfo?.(pageId)?.timezone : undefined) || DEFAULT_TZ,
    log: ctx.log,
  });
  const playbook = createPlaybook({
    db: ctx.db,
    notes: ctx.brain.notes,
    folder,
    trialPosts: () => Number(ctx.settings.get<number>('trial_posts', 4)),
    moc,
    attention: ctx.attention,
    audit: ctx.audit,
    log: ctx.log,
  });
  const weekly = createWeekly({
    db: ctx.db,
    notes: ctx.brain.notes,
    folder,
    moc,
    agentId,
    canUse,
    runLean: (input) => ctx.agents.runLean(input),
    tasks: ctx.tasks,
    playbook,
    drafts,
    log: ctx.log,
    audit: ctx.audit,
  });
  const scorer = createScorer({ db: ctx.db, playbook, agentId, canUse, runLean: (input) => ctx.agents.runLean(input), log: ctx.log });
  return { sync, playbook, weekly, scorer, drafts };
}

export default defineModule({
  routes(app, ctx) {
    state ??= build(ctx);
    registerRoutes(app, ctx, () => state?.sync ?? null);
    registerLoopRoutes(app, ctx, () => state);
  },

  async start(ctx) {
    state = build(ctx);
    const s = state;
    // catch up from the stored cursor before anything else
    try {
      await s.sync.run();
    } catch (err) {
      ctx.log.error({ err }, 'learn: đọc bù bài đăng lúc khởi động lỗi');
    }
    ctx.schedule.every('post-notes', POLL_MS, () => s.sync.run().then(() => undefined));

    const evaluate = () => {
      try {
        s.playbook.evaluate();
      } catch (err) {
        ctx.log.error({ err }, 'learn: xét sổ bài học lỗi');
      }
    };
    evaluate();
    // module timers do not run while the machine is off: write last week's review now if it is missing.
    // Not awaited: the agent run for the words may take minutes, start() must not wait for it.
    const catchUp = () => s.weekly.catchUp().then(() => undefined).catch((err) => ctx.log.error({ err }, 'learn: viết tổng kết tuần lỗi'));
    void catchUp();
    ctx.schedule.every('weekly', WEEKLY_CRON, catchUp);
    ctx.schedule.every('playbook', EVALUATE_MS, () => {
      evaluate();
      return catchUp();
    });
  },

  stop() {
    state = null;
  },

  provides: () => ({
    /** Run one pass now (also what the timer does) and read the state the page shows. */
    postNotes: {
      syncNow: () => state?.sync.run(),
      status: () => state?.sync.status(),
    },
    playbook: {
      evaluate: () => state?.playbook.evaluate(),
      verified: () => state?.playbook.verified() ?? [],
    },
    weekly: {
      catchUp: () => state?.weekly.catchUp(),
    },
  }),

  actions: {
    propose: {
      scope: 'learn.propose',
      description:
        'Đề xuất một bài học mới cho sổ bài học. Bài học vào ở trạng thái Giả thuyết và chờ chủ xem; không action nào đổi được trạng thái bài học. ' +
        'bang_chung là liên kết tới ghi chú bài đăng thật (noi-dung/bai/…); liên kết không tồn tại không được tính.',
      example: { tieu_de: 'Video hướng dẫn dưới 45 giây có ER cao hơn ảnh sản phẩm', mang: 'noi-dung', noi_dung: 'Thấy ở 3 bài gần đây.', bang_chung: ['[[2026-11-24-cach-uop-tra-sen]]'], ap_dung: { dinh_dang: ['video-ngan'], do_dai_toi_da: 45 } },
      handler(payload, call) {
        if (!state) throw new Error('Module Học chưa chạy.');
        const r = state.playbook.propose(call.agentId, payload);
        return { ok: true, path: r.path, trang_thai: 'gia-thuyet', note: 'Đã ghi giả thuyết, chờ chủ xem ở Vòng học › Chờ duyệt.' };
      },
    },
  },

  agentContext({ agent, scopes }) {
    if (!state || !scopes.includes(READ_SCOPE)) return undefined;
    return lessonContext(agent.id, scopes, state.playbook.verified());
  },
});
