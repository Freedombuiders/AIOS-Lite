// Actions agents call with <aios-action module="marketing" name="content.add">{json}</aios-action>.
// They reuse the owner's command engine (validation, page rules, approval flow); agents never publish.
import type { ModuleAction } from '../../../src/modules/sdk.js';
import { CliUsageError, runCommand } from './core/agent-commands.js';
import { FbError } from './core/errors.js';

type Payload = Record<string, unknown>;

function asObject(payload: unknown): Payload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Nội dung hành động phải là một đối tượng JSON.');
  return payload as Payload;
}

const FLAGS: Array<[string, string]> = [
  ['page', 'page'], ['format', 'format'], ['title', 'title'], ['caption', 'caption'], ['pillar', 'pillar'],
  ['hookType', 'hook-type'], ['cta', 'cta'], ['campaign', 'campaign'], ['linkUrl', 'link'], ['schedule', 'schedule'],
];

/** payload -> command-line style argv understood by runCommand. */
export function argvFor(command: 'add' | 'update' | 'schedule', payload: Payload): string[] {
  const argv: string[] = [command];
  const id = payload.id;
  if (command !== 'add') {
    if (typeof id !== 'number' && typeof id !== 'string') throw new Error('Thiếu "id" của bài.');
    argv.push(String(id));
  }
  if (command === 'schedule') {
    if (typeof payload.at !== 'string' || !payload.at) throw new Error('Thiếu "at" (YYYY-MM-DD HH:MM theo giờ của Page).');
    argv.push(payload.at);
    return argv;
  }
  for (const [key, flag] of FLAGS) {
    const v = payload[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string') throw new Error(`"${key}" phải là chuỗi.`);
    argv.push(`--${flag}`, v);
  }
  if (payload.hooks !== undefined) {
    if (!Array.isArray(payload.hooks) || payload.hooks.some((h) => typeof h !== 'string')) throw new Error('"hooks" phải là danh sách chuỗi.');
    for (const h of payload.hooks as string[]) argv.push('--hook', h);
  }
  return argv;
}

function run(command: 'add' | 'update' | 'schedule', payload: unknown, agentId: string): unknown {
  try {
    return runCommand(argvFor(command, asObject(payload)), agentId);
  } catch (err) {
    if (err instanceof CliUsageError || err instanceof FbError) throw new Error(err.message);
    throw err;
  }
}

export const marketingActions: Record<string, ModuleAction> = {
  'content.add': {
    scope: 'content.write',
    description: 'Tạo bài mới trong Kho nội dung ở trạng thái Chờ duyệt (không đăng). Luôn kèm 3 hook khác hướng nhau.',
    example: { page: 'Tên hoặc id Fanpage', format: 'photo', title: 'Tiêu đề', caption: 'Nội dung bài', pillar: 'Kiến thức', hookType: 'câu hỏi', cta: 'Nhắn tin', hooks: ['Hook 1', 'Hook 2', 'Hook 3'], schedule: '2026-10-30 19:30' },
    handler: (payload, call) => run('add', payload, call.agentId),
  },
  'content.update': {
    scope: 'content.write',
    description: 'Sửa một bài trong Kho nội dung (ví dụ theo góp ý của chủ Page). Bài đã duyệt của Page cần duyệt sẽ quay về Chờ duyệt.',
    example: { id: 12, caption: 'Caption đã sửa' },
    handler: (payload, call) => run('update', payload, call.agentId),
  },
  'content.schedule': {
    scope: 'content.write',
    description: 'Đề xuất hoặc đặt giờ đăng cho một bài (giờ theo múi giờ của Page). Page cần duyệt thì giờ chỉ là đề xuất.',
    example: { id: 12, at: '2026-10-30 19:30' },
    handler: (payload, call) => run('schedule', payload, call.agentId),
  },
};
