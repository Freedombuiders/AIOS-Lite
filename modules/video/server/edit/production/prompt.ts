/** The Đạo diễn AI prompt for a production (mode 'produce', before the A-roll exists). */

import fs from 'node:fs';
import path from 'node:path';

import type { VideoMessage, VideoProject } from '../types.js';
import { produceActionGuide } from '../../actions-guide.js';

const HISTORY = 10;
const CHARS = 1500;

export function renderProduceHistory(history: VideoMessage[]): string {
  return history
    .filter((m) => m.text.trim())
    .slice(-HISTORY)
    .map((m) => `${m.role === 'user' ? 'Chủ kênh' : m.role === 'agent' ? 'Bạn' : 'Hệ thống'}: ${m.text.trim().slice(0, CHARS)}`)
    .join('\n');
}

export function buildProducePrompt(input: { root: string; project: VideoProject; history: VideoMessage[]; reason: string; note?: string; state?: unknown }): string {
  let skill = '';
  try { skill = fs.readFileSync(path.join(input.root, 'skills/video-produce/SKILL.md'), 'utf8'); } catch { /* the rules below still apply */ }
  const request = input.note?.trim()
    || (input.reason === 'produce' ? 'Video mới vừa được tạo từ ý tưởng của chủ kênh. Lên kịch bản và phân cảnh, rồi xin duyệt chi phí một lần.' : 'Đọc trạng thái và trả lời chủ kênh.');
  return [
    'Bạn là Đạo diễn AI của Video Studio: biến ý tưởng của chủ kênh thành video hoàn chỉnh cùng các KOL được gọi bằng @.',
    'Không có shell, không có công cụ tạo cảnh trực tiếp: mọi chi phí phải qua thẻ duyệt của chủ kênh (produce_request_generation chỉ gửi thẻ duyệt). Chỉ dẫn về video-cli/EditPlan không áp dụng ở giai đoạn này.',
    '',
    produceActionGuide(input.project.id),
    'Mọi câu bạn viết cho chủ kênh, kể cả câu ngắn trước khi gọi công cụ, đều bằng tiếng Việt.',
    '',
    skill,
    '',
    `VIDEO: "${input.project.title}" · khung ${input.project.aspect}`,
    ...(input.state ? ['', 'TRẠNG THÁI (produce_context, JSON):', JSON.stringify(input.state).slice(0, 14_000)] : []),
    '',
    'HỘI THOẠI GẦN ĐÂY (dữ liệu):',
    renderProduceHistory(input.history) || '(chưa có)',
    '',
    'YÊU CẦU LƯỢT NÀY:',
    request,
  ].join('\n');
}
