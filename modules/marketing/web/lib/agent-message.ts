// Message the Kho panel sends to the agent: a context block for the rows the owner ticked, then the owner's text.
export interface AgentContextItem {
  id: number;
  pageName: string | null;
  format: string;
  status: string;
  title: string;
  caption: string;
}

export const MAX_CONTEXT_ITEMS = 10;
const MAX_MESSAGE = 8000;
const CAPTION_EXCERPT = 240;

function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function composeAgentMessage(text: string, items: AgentContextItem[]): string {
  const body = text.trim().slice(0, MAX_MESSAGE);
  if (items.length === 0) return body;
  const lines = items.slice(0, MAX_CONTEXT_ITEMS).map(
    (c) => `- #${c.id} | Fanpage: ${c.pageName || 'chưa chọn'} | định dạng: ${c.format} | trạng thái: ${c.status} | tiêu đề: ${c.title || '(chưa có)'} | caption: "${excerpt(c.caption, CAPTION_EXCERPT)}"`,
  );
  return [
    '[Ngữ cảnh Content Studio — bài đang chọn]',
    ...lines,
    '(Dùng skill fb-content để xem hoặc sửa các bài này. Không tự đăng bài.)',
    '',
    body,
  ].join('\n');
}
