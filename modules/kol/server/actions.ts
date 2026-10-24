// Actions agents call with <aios-action module="kol" name="...">{json}</aios-action>.
// They reuse the owner's command engine (runCommand: validation, caps, review flow). Agents never approve or publish.
import type { ModuleAction } from '../../../src/modules/sdk.js';
import { CliUsageError, runCommand } from './cli-commands.js';
import { KolError } from './core.js';

type Payload = Record<string, unknown>;

const READ_COMMANDS = new Set(['personas', 'show', 'library', 'assets', 'posts', 'growth', 'ideas', 'generation', 'preview']);

function asObject(payload: unknown): Payload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Nội dung hành động phải là một đối tượng JSON.');
  return payload as Payload;
}

const str = (p: Payload, key: string): string | undefined => {
  const v = p[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' && typeof v !== 'number') throw new Error(`"${key}" phải là chuỗi.`);
  return String(v);
};

const list = (p: Payload, key: string): string[] | undefined => {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`"${key}" phải là danh sách chuỗi.`);
  return v as string[];
};

function flags(argv: string[], p: Payload, pairs: Array<[key: string, flag: string]>): void {
  for (const [key, flag] of pairs) {
    const v = str(p, key);
    if (v !== undefined) argv.push(`--${flag}`, v);
  }
}

/** payload -> command-line style argv understood by runCommand. */
export function argvFor(action: 'content.add' | 'content.update' | 'generation.request', p: Payload): string[] {
  if (action === 'content.update') {
    const id = str(p, 'id');
    if (!id) throw new Error('Thiếu "id" của bài.');
    const argv = ['post-update', id];
    flags(argv, p, [['title', 'title'], ['pillar', 'pillar'], ['format', 'format'], ['caption', 'caption'], ['brief', 'brief'], ['schedule', 'schedule']]);
    for (const [key, flag] of [['hashtags', 'hashtag'], ['assetIds', 'asset'], ['accountIds', 'account']] as const) {
      for (const v of list(p, key) ?? []) argv.push(`--${flag}`, v);
    }
    return argv;
  }
  const persona = str(p, 'persona');
  if (!persona) throw new Error('Thiếu "persona" (id hoặc @handle của KOL).');
  if (action === 'content.add') {
    const argv = ['post-add', '--persona', persona];
    flags(argv, p, [
      ['title', 'title'], ['pillar', 'pillar'], ['format', 'format'], ['caption', 'caption'], ['brief', 'brief'], ['schedule', 'schedule'],
      ['captionFacebook', 'caption-facebook'], ['captionInstagram', 'caption-instagram'], ['captionTiktok', 'caption-tiktok'],
      ['captionYoutube', 'caption-youtube'], ['titleYoutube', 'title-youtube'],
    ]);
    for (const [key, flag] of [['hashtags', 'hashtag'], ['assetIds', 'asset'], ['accountIds', 'account']] as const) {
      for (const v of list(p, key) ?? []) argv.push(`--${flag}`, v);
    }
    if (p.draft === true) argv.push('--draft');
    return argv;
  }
  const argv = ['generate', '--persona', persona];
  flags(argv, p, [
    ['mode', 'mode'], ['outfit', 'outfit'], ['expression', 'expression'], ['hair', 'hair'], ['scene', 'scene'], ['pose', 'pose'],
    ['look', 'look'], ['effect', 'effect'], ['camera', 'camera'], ['template', 'template'], ['sourceAsset', 'source-asset'],
    ['realism', 'realism'], ['model', 'model'], ['aspect', 'aspect'], ['quality', 'quality'], ['count', 'count'], ['seed', 'seed'],
    ['prompt', 'prompt'], ['duration', 'duration'], ['script', 'script'], ['post', 'post'],
  ]);
  if (typeof p.audio === 'boolean') argv.push('--audio', String(p.audio));
  return argv;
}

async function run(argv: string[], agentId: string): Promise<unknown> {
  try {
    return await runCommand(argv, agentId);
  } catch (err) {
    if (err instanceof CliUsageError || err instanceof KolError) throw new Error(err.message);
    throw err;
  }
}

export const kolActions: Record<string, ModuleAction> = {
  read: {
    scope: 'kol.read',
    description: 'Đọc dữ liệu KOL Studio. "command" là một trong: personas, show, library, assets, posts, growth, ideas, generation, preview; "args" là danh sách đối số theo kiểu dòng lệnh (vd ["--persona","@handle","--days","30"]).',
    example: { command: 'growth', args: ['--persona', '@handle', '--days', '30'] },
    handler(payload, call) {
      const p = asObject(payload);
      const command = str(p, 'command') ?? '';
      if (!READ_COMMANDS.has(command)) throw new Error(`Lệnh đọc không hợp lệ: "${command}".`);
      return run([command, ...(list(p, 'args') ?? [])], call.agentId);
    },
  },
  'content.add': {
    scope: 'content.write',
    description: 'Soạn một bài đăng cho KOL (giữ chủ đề, chú thích, hashtag, ảnh/video, tài khoản và giờ đề xuất). Bài vào trạng thái chờ chủ duyệt, agent không được duyệt hay đăng.',
    example: { persona: '@handle', title: 'Ngày mới', format: 'photo', caption: '...', hashtags: ['a', 'b'], assetIds: ['<assetId>'], accountIds: ['<accountId>'], pillar: 'Đời sống', schedule: '2026-10-22 19:30' },
    handler: (payload, call) => run(argvFor('content.add', asObject(payload)), call.agentId),
  },
  'content.update': {
    scope: 'content.write',
    description: 'Sửa một bài đăng chưa được duyệt theo phản hồi của chủ (id bài + các trường cần đổi).',
    example: { id: '<postId>', caption: '...' },
    handler: (payload, call) => run(argvFor('content.update', asObject(payload)), call.agentId),
  },
  'generation.request': {
    scope: 'media.generate',
    description: 'Xếp hàng tạo ảnh/video cho KOL (TỐN TIỀN, trong hạn mức của Studio). Chạy action "read" với command "preview" trước để xem giá và cảnh báo.',
    example: { persona: '@handle', outfit: '<id>', expression: '<id>', scene: '<id>', aspect: '4:5', count: 2 },
    handler: (payload, call) => run(argvFor('generation.request', asObject(payload)), call.agentId),
  },
};
