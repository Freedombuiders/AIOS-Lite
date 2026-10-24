// Deterministic runtime with no binary: demos and tests.
import { randomUUID } from 'node:crypto';
import type { Runtime, RuntimeCapabilities, RunRequest, RunResult } from './contracts.js';
import { runtimeOption } from './shared.js';

export const MOCK_CAPABILITIES: RuntimeCapabilities = {
  resume: true,
  systemPrompt: 'inline',
  reportsCost: true,
  images: false,
  noTools: true,
  enforces: {
    context: 'hard',
    mcp: 'hard',
    fileRead: 'hard',
    fileWrite: 'hard',
    shell: 'hard',
    note: 'Runtime giả lập: không chạy công cụ nào nên không có gì để chặn.',
  },
};

/** Builds the reply for a prompt. Markers: #delegate:<id>, #memory:<text>, #review, #fail, #json. */
const TRIGGER_ASSIGNED = 'bạn được giao một việc mới.';
const OTHER_TRIGGERS = ['các việc con bạn đã giao đã xong', 'người dùng vừa bình luận', 'lượt trước chưa thành công', 'người dùng vừa nhắn tin', 'đến giờ chạy theo lịch', 'một module giao việc này'];
const MARKER = '#(?:delegate|memory|review|fail|json)\\b';

/** Task text: what follows the `## Việc: <title>` header when the prompt has one, else the whole prompt. */
function taskBody(prompt: string): string {
  const m = /^## Việc:[^\n]*\n/m.exec(prompt);
  return m ? prompt.slice(m.index + m[0].length) : prompt;
}

export function mockReply(fullPrompt: string): { ok: true; text: string } | { ok: false; message: string } {
  const prompt = taskBody(fullPrompt);
  if (/#fail\b/.test(prompt)) return { ok: false, message: 'Mock: lỗi giả lập theo yêu cầu (#fail).' };
  if (/#json\b/.test(prompt)) return { ok: true, text: JSON.stringify({ action: 'reply', text: 'Dạ, em đã nhận được tin nhắn ạ.', reason: 'mock' }) };
  const first = prompt.split('\n').find((l) => l.trim())?.trim() ?? '';
  const parts = [`Đã xử lý: ${first}`];
  // delegate only on a new assignment (or a bare prompt); re-runs after children/comments must not loop
  const isNew = fullPrompt.includes(TRIGGER_ASSIGNED) || !OTHER_TRIGGERS.some((t) => fullPrompt.includes(t));
  const delegate = /#delegate:([A-Za-z0-9_-]+)/.exec(prompt);
  if (delegate && isNew) parts.push(`<aios-task to="${delegate[1]}" title="Việc demo">Hãy làm phần việc demo.</aios-task>`);
  const memory = new RegExp(`#memory:(.+?)(?=\\s${MARKER}|$)`, 'm').exec(prompt);
  if (memory) parts.push(`<aios-memory scope="team">${memory[1]!.trim()}</aios-memory>`);
  if (/#review\b/.test(prompt)) parts.push('<aios-status>review</aios-status>');
  return { ok: true, text: parts.join('\n') };
}

function chunk(text: string, size = 24): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

const cancelled = (sessionId: string): RunResult => ({ ok: false, output: '', sessionId, error: { family: 'cancelled', message: 'Lượt chạy đã bị huỷ.' } });

export function createMockRuntime(): Runtime {
  return {
    id: 'mock',
    label: 'Mock (giả lập)',
    capabilities: MOCK_CAPABILITIES,
    async doctor() {
      return { runtime: 'mock', status: 'pass', version: 'mock', checks: [{ code: 'mock.ok', level: 'info', message: 'Runtime giả lập luôn sẵn sàng.' }], testedAt: new Date().toISOString() };
    },
    async run(req: RunRequest): Promise<RunResult> {
      const delay = Number(runtimeOption(req, 'delayMs') ?? 30);
      const sessionId = req.sessionId ?? `mock-${randomUUID()}`;
      const reply = mockReply(req.prompt);
      if (!reply.ok) return { ok: false, output: '', sessionId, error: { family: 'unknown', message: reply.message } };
      for (const piece of chunk(reply.text)) {
        if (req.signal.aborted) return cancelled(sessionId);
        req.onEvent({ type: 'text', text: piece });
        await sleep(delay, req.signal);
      }
      if (req.signal.aborted) return cancelled(sessionId);
      const usage = { inputTokens: Math.ceil(req.prompt.length / 4), outputTokens: Math.ceil(reply.text.length / 4), costUsd: 0 };
      req.onEvent({ type: 'usage', usage });
      return { ok: true, output: reply.text, sessionId, model: req.agent.model ?? 'mock', usage };
    },
  };
}
