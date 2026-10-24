import { afterEach, describe, expect, it } from 'vitest';

import { bindFakeRuntime, unbindFakeRuntime } from '../test-runtime.js';
import { runCommentAgentTurn } from './agent-turn.js';

afterEach(() => unbindFakeRuntime());

describe('runCommentAgentTurn: one lean turn for a public reply', () => {
  it('sends the skill and the comment prompt through ctx.agents.runLean and parses the decision', async () => {
    const rt = bindFakeRuntime({
      runLean: () => ({ ok: true, output: '```json\n{"action":"reply","text":"  Chào An!  "}\n```', taskId: 3, runId: 4, usage: { costUsd: 0.01 } }),
    });
    const result = await runCommentAgentTurn({ agentId: 'content-fb', commentId: 'c1', skillText: 'SKILL BODY', prompt: 'COMMENT PROMPT' });
    expect(result.decision).toMatchObject({ action: 'reply', text: 'Chào An!' });
    expect(result.costUsd).toBe(0.01);
    expect(rt.leanCalls).toHaveLength(1);
    expect(rt.leanCalls[0]).toMatchObject({ agentId: 'content-fb', meta: { kind: 'fb-comment-reply', commentId: 'c1' } });
    expect(rt.leanCalls[0].prompt).toContain('SKILL BODY');
    expect(rt.leanCalls[0].prompt.endsWith('COMMENT PROMPT')).toBe(true);
  });

  it('returns no decision and the error when the turn fails', async () => {
    bindFakeRuntime({ runLean: () => ({ ok: false, output: '', taskId: 3, runId: null, error: 'hết hạn mức' }) });
    const result = await runCommentAgentTurn({ agentId: 'main', commentId: 'c2', skillText: '', prompt: 'P' });
    expect(result.decision).toBeNull();
    expect(result.error).toBe('hết hạn mức');
  });

  it('refuses to run while auto-reply is switched off', async () => {
    const rt = bindFakeRuntime({ settings: { autoreply: false } });
    await expect(runCommentAgentTurn({ agentId: 'main', commentId: 'c3', skillText: '', prompt: 'P' })).rejects.toThrow(/trả lời bình luận/);
    expect(rt.leanCalls).toHaveLength(0);
  });
});
