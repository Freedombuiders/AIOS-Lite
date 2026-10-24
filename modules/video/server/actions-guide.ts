/** Prompt text that tells a director agent how to act now that it has no tool loop (one answer, then actions run). */
import { creationTools } from './create/runtime.js';
import { produceTools } from './edit/production/tools.js';

type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };

const render = (tools: ToolDef[]): string =>
  tools.map((t) => `- ${t.name}: ${t.description}\n  tham số: ${JSON.stringify(t.inputSchema.properties ?? {})}${Array.isArray(t.inputSchema.required) && t.inputSchema.required.length ? ` · bắt buộc: ${(t.inputSchema.required as string[]).join(', ')}` : ''}`).join('\n');

function guide(actionName: 'create.call' | 'produce.call', projectId: string, tools: ToolDef[]): string {
  return [
    'CÁCH THAO TÁC (bắt buộc): bạn không có công cụ MCP và không thấy kết quả giữa chừng. Mỗi thao tác là một khối trong CÂU TRẢ LỜI CUỐI:',
    `<aios-action module="video" name="${actionName}">{"projectId":"${projectId}","tool":"<tên công cụ>","args":{...}}</aios-action>`,
    'Máy chạy các khối theo đúng thứ tự bạn viết (tối đa 10 khối mỗi lượt), rồi ghi kết quả vào việc. Dữ liệu hiện tại có sẵn ở mục TRẠNG THÁI bên dưới; đừng gọi công cụ chỉ để đọc lại nó.',
    'Công cụ có sẵn:',
    render(tools),
  ].join('\n');
}

export const createActionGuide = (projectId: string): string => guide('create.call', projectId, creationTools);
export const produceActionGuide = (projectId: string): string => guide('produce.call', projectId, produceTools.filter((t) => t.name !== 'produce_inspect_scene' && t.name !== 'produce_context' && t.name !== 'produce_status'));
