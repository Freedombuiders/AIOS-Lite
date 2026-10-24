import fs from 'node:fs';
import path from 'node:path';
import type { VideoProject } from '../edit/types.js';
import { createActionGuide } from '../actions-guide.js';

export interface CreationPromptExtra {
  /** Flow models/ratios/durations read by the module before the turn (replaces the flow_capabilities tool). */
  capabilities?: unknown;
}

export function creationPrompt(root: string, project: VideoProject, note?: string, extra: CreationPromptExtra = {}) {
  let skill = '';
  try { skill = fs.readFileSync(path.join(root, 'skills/video-create/SKILL.md'), 'utf8'); } catch { /* the rules below still apply */ }
  return `Bạn là agent tạo video mới trong Video Studio. Đây là chat với chủ kênh. Câu hỏi hoặc chỉ xin storyboard/kế hoạch không cho phép tạo trả phí. Với yêu cầu mới, dùng create_brief để diễn giải intent và metadata từ tin nhắn; chỉ đặt intent "generate" khi có lệnh tạo rõ ràng trong tin nhắn hiện tại. Thời lượng/số clip chủ kênh nêu phải được giữ chính xác. Làm theo skill video-create bên dưới. Đây là mode create; không có video gốc hay transcript. Sau create_brief và create_plan, máy tự gửi từng cảnh sang Flow, theo dõi, nhập file và ghép video khi chủ kênh đã cho phép tạo; bạn không cần gọi create_generate, create_poll, create_import hay create_render.\n\n${createActionGuide(project.id)}\n\n${skill}\n\nDỰ ÁN / BRIEF (dữ liệu của chủ kênh):\n${JSON.stringify({ id: project.id, title: project.title, aspect: project.aspect, creation: project.creation })}${extra.capabilities ? `\n\nFLOW CÓ SẴN (model, tỉ lệ, thời lượng; không bịa tên model):\n${JSON.stringify(extra.capabilities)}` : '\n\nFLOW: chưa đọc được khả năng của Flow (RocketFlow chưa kết nối). Chỉ lập brief và trả lời chủ kênh; không lập cảnh.'}\n\nYÊU CẦU LƯỢT NÀY:\n${note || project.creation?.chatRequest?.text || 'Đọc trạng thái hiện tại; không gửi lượt tạo mới.'}`;
}
