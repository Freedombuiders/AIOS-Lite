// care's draftStats read function over real outbox rows: bot drafts sent as written, edited then sent,
// discarded, still waiting; person-written replies and auto replies are not drafts.
import { afterEach, describe, expect, it } from 'vitest';
import { chat, makeRig, type Rig } from './application/dispatch-test-kit.js';
import { draftStats } from './draft-stats.js';

let rig: Rig;
afterEach(() => rig?.close());

describe('draftStats', () => {
  it('counts bot drafts sent unchanged over every decided bot draft', async () => {
    rig = makeRig();
    const conversationId = rig.conversation.id;
    const bot = (n: number) => rig.serviceA.createDraft({ conversationId, actor: 'approved', content: chat(`nháp ${n}`), sourceRunId: `run-${n}`, createdBy: 'agent:cskh' }).intent;

    // 1, 2: sent as the bot wrote them
    for (const n of [1, 2]) rig.serviceA.approveDraft(bot(n).id, { expectedRevision: 1 });
    // 3: edited by the person, then sent
    const edited = bot(3);
    rig.serviceA.editDraft(edited.id, { expectedRevision: 1, content: chat('nháp 3, sửa') });
    rig.serviceA.approveDraft(edited.id, { expectedRevision: 2 });
    // one message at a time per conversation: dispatch until nothing is due
    for (let i = 0; i < 5 && (await rig.dispatcher('A').dispatchDue()).length; i++);
    // 4: discarded; 5: still waiting for review
    rig.serviceA.discardDraft(bot(4).id);
    bot(5);
    // not drafts: a reply the person typed, an auto reply
    rig.serviceA.enqueue({ conversationId, clientRequestId: 'manual-1', actor: 'manual', content: chat('tôi tự viết') });
    rig.serviceA.enqueue({ conversationId, clientRequestId: 'auto-1', actor: 'auto', content: chat('tự gửi'), sourceRunId: 'run-auto' });

    const all = draftStats(rig.fx.a, { fromMs: 0, toMs: Date.now() + 60_000 });
    expect(all).toMatchObject({ botDrafts: 5, sentUnchanged: 2, sentEdited: 1, discarded: 1, open: 1, notDelivered: 0 });
    expect(all.unchangedRate).toBeCloseTo(2 / 4);

    // the range is by creation time
    expect(draftStats(rig.fx.a, { fromMs: Date.now() + 60_000, toMs: Date.now() + 120_000 })).toMatchObject({ botDrafts: 0, unchangedRate: null });
  });
});
