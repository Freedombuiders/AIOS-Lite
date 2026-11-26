// What an agent gets from the lesson book on every run (ModuleDefinition.agentContext). Two conditions, both
// needed: the agent holds the learn scope `playbook.read` (the engine only asks modules the agent has scopes in,
// and a learn.propose-only agent gets nothing), and its id is listed in the lesson's `dung_boi`. Only lessons the
// owner verified in the app (da-kiem-chung). At most 10 lessons and 1,500 characters, wrapped as untrusted data:
// a lesson is text from a note, not an instruction (the wrapping labels it; it is not a permission barrier).
import { untrusted } from '../../../src/modules/sdk.js';
import type { LessonView } from './playbook.js';

export const READ_SCOPE = 'playbook.read';
export const MAX_LESSONS = 10;
export const MAX_CHARS = 1500;

function line(l: LessonView): string {
  const rules = l.ruleText.length ? ` (${l.ruleText.join('; ')})` : '';
  const summary = l.summary && l.summary !== l.title ? `: ${l.summary}` : '';
  return `- ${l.title}${summary}${rules}`.replace(/\s+/g, ' ');
}

export function lessonContext(agentId: string, scopes: readonly string[], verified: readonly LessonView[]): string | undefined {
  if (!scopes.includes(READ_SCOPE)) return undefined;
  const mine = verified.filter((l) => l.usedBy.includes(agentId)).slice(0, MAX_LESSONS);
  const head = 'Chủ đã duyệt các bài học này. Làm theo khi viết bài hoặc trả lời, trừ khi chủ dặn khác.';
  const lines: string[] = [];
  let used = head.length;
  for (const l of mine) {
    let s = line(l);
    if (s.length > 400) s = `${s.slice(0, 399)}…`;
    if (used + s.length + 1 > MAX_CHARS) break;
    lines.push(s);
    used += s.length + 1;
  }
  if (!lines.length) return undefined;
  return untrusted('Sổ bài học đã kiểm chứng', 'so-bai-hoc', `${head}\n${lines.join('\n')}`);
}
