// Sample data for the mock API (VITE_MOCK=1 or ?mock=1). Vietnamese, realistic, no secrets.
import type {
  AttentionItem, AuditEntry, BoardEntry, Conversation, Memory, Message, Run, Schedule, StoredRunEvent, Task, TaskComment,
} from '@core/types';
import type {
  AgentDetail, BrainFolderView, BrainTreeNode, ConnectionView, ModuleInfo, RuntimeReport, SkillView,
} from '../api-types';

const mins = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const NOW = () => new Date().toISOString();

const emptyAccess = { brain: {}, memory: { team: true, private: true }, skills: 'all' as const, connections: {}, modules: {} };

export const agents: AgentDetail[] = [
  {
    id: 'main', name: 'Trợ lý chính', description: 'Điều phối công việc, giao việc cho cả đội.', runtime: 'claude', model: 'claude-sonnet-5-5',
    runtimeOptions: {}, permission: 'safe', context: 'standard', canDelegate: true, maxConcurrent: 2, budgetUsdMonth: 30, enabled: true,
    access: { brain: { 'tri-thuc': { read: ['**'], write: ['Ghi-chu/**'] } }, memory: { team: true, private: true }, skills: 'all', connections: { composio: true }, modules: { care: ['inbox.read', 'reply.draft'] } },
    persona: '# Trợ lý chính\n\nBạn là trợ lý điều phối của đội. Chia việc rõ ràng, giao cho đúng agent, tóm tắt kết quả bằng tiếng Việt ngắn gọn.\n\n## Quy tắc\n- Không tự gửi tin cho khách.\n- Việc nào cần duyệt thì đưa vào hàng chờ duyệt.',
    dir: '/agents/main', workspace: '/workspaces/main', stats: { running: 1, queued: 1, lastRunAt: mins(4), costMonthUsd: 6.42, runsMonth: 58 },
  },
  {
    id: 'sales-a', name: 'Sales A', description: 'Trả lời khách, soạn báo giá và nhắc lịch hẹn.', runtime: 'codex', model: 'gpt-5.4',
    runtimeOptions: {}, permission: 'safe', context: 'lean', reportsTo: 'main', canDelegate: false, maxConcurrent: 1, budgetUsdMonth: 15, enabled: true,
    access: { brain: { 'ban-hang': { read: ['**'], write: [] } }, memory: { team: true, private: false }, skills: ['tra-loi-khach'], connections: {}, modules: { care: ['inbox.read', 'reply.draft', 'reply.send'] } },
    persona: '# Sales A\n\nBạn chăm sóc khách hàng. Trả lời lịch sự, ngắn, đúng giá trong bảng giá.', dir: '/agents/sales-a', workspace: '/workspaces/sales-a',
    stats: { running: 0, queued: 0, lastRunAt: mins(35), costMonthUsd: 2.1, runsMonth: 41 },
  },
  {
    id: 'content', name: 'Biên tập nội dung', description: 'Viết bài, caption và kịch bản video ngắn.', runtime: 'grok', runtimeOptions: {}, permission: 'safe', context: 'standard',
    reportsTo: 'main', canDelegate: false, maxConcurrent: 1, enabled: true,
    access: { brain: { 'tri-thuc': { read: ['Thuong-hieu/**', 'Y-tuong/**'], write: ['Y-tuong/**'] } }, memory: { team: true, private: true }, skills: 'all', connections: {}, modules: {} },
    persona: '# Biên tập nội dung\n\nGiọng thương hiệu: gần gũi, rõ ràng, không phóng đại.', dir: '/agents/content', workspace: '/workspaces/content',
    stats: { running: 0, queued: 0, lastRunAt: mins(190), costMonthUsd: 0, runsMonth: 12 },
  },
  {
    id: 'research', name: 'Nghiên cứu thị trường', description: 'Tìm tin, tóm tắt đối thủ và xu hướng.', runtime: 'hermes', runtimeOptions: {}, permission: 'full', context: 'standard',
    reportsTo: 'main', canDelegate: false, maxConcurrent: 1, budgetUsdMonth: 10, enabled: true,
    access: { ...emptyAccess, brain: { 'tri-thuc': { read: ['**'], write: ['Nghien-cuu/**'] } }, connections: { 'web-search': ['search_*'] } },
    persona: '# Nghiên cứu thị trường\n\nLuôn ghi nguồn. Tách rõ dữ kiện và nhận định.', dir: '/agents/research', workspace: '/workspaces/research',
    stats: { running: 0, queued: 0, lastRunAt: mins(900), costMonthUsd: 9.35, runsMonth: 17 },
  },
  {
    id: 'demo', name: 'Agent thử', description: 'Agent giả lập để thử giao diện, không gọi CLI thật.', runtime: 'mock', runtimeOptions: {}, permission: 'safe', context: 'lean',
    canDelegate: false, maxConcurrent: 1, enabled: true, access: emptyAccess, persona: 'Trả lời bằng câu cố định.', dir: '/agents/demo', workspace: '/workspaces/demo',
    stats: { running: 0, queued: 0, lastRunAt: null, costMonthUsd: 0, runsMonth: 0 },
  },
];

export const tasks: Task[] = [];
const T = (t: Partial<Task> & Pick<Task, 'id' | 'title' | 'agentId' | 'status'>): Task => ({
  prompt: t.title, kind: 'task', priority: 5, parentId: null, conversationId: null, source: 'user', trigger: 'assigned', contextProfile: 'standard',
  depth: 0, runAfter: null, result: null, error: null, recoverCount: 0, meta: {}, createdAt: mins(60), updatedAt: mins(30), startedAt: null, finishedAt: null, ...t,
});
tasks.push(
  T({ id: 1, title: 'Tổng hợp phản hồi khách tuần này', prompt: 'Đọc các hội thoại tuần này, tóm tắt 5 câu hỏi lặp lại nhiều nhất và đề xuất câu trả lời mẫu.', agentId: 'main', status: 'running', createdAt: mins(12), startedAt: mins(10) }),
  T({ id: 2, title: 'Soạn báo giá gói Pro cho khách Minh Anh', agentId: 'sales-a', status: 'queued', createdAt: mins(5) }),
  T({ id: 3, title: 'Viết 3 caption cho đợt khuyến mãi tháng 11', agentId: 'content', status: 'review', result: '**Caption 1:** Tháng 11 nhẹ nhàng hơn với ưu đãi 15% cho khách cũ.\n\n**Caption 2:** …', createdAt: mins(95), startedAt: mins(90), finishedAt: mins(86) }),
  T({ id: 4, title: 'Phân tích 3 đối thủ chính', agentId: 'research', status: 'done', result: 'Đã lập bảng so sánh giá và tính năng của 3 đối thủ, lưu ở Nghien-cuu/doi-thu.md.', createdAt: mins(300), startedAt: mins(296), finishedAt: mins(280) }),
  T({ id: 5, title: 'Đồng bộ danh sách khách từ Composio', agentId: 'main', status: 'failed', error: 'Composio trả về 401: khoá API không hợp lệ.', createdAt: mins(240), startedAt: mins(239), finishedAt: mins(238) }),
  T({ id: 6, title: 'Hỏi cả nhóm: nên giảm giá gói Starter không?', agentId: 'main', status: 'waiting', kind: 'team', meta: { mode: 'parallel', agentIds: ['sales-a', 'research'], mergeBy: 'main' }, createdAt: mins(20), startedAt: mins(19) }),
  T({ id: 7, title: 'Ý kiến Sales A: giảm giá Starter?', agentId: 'sales-a', status: 'running', parentId: 6, depth: 1, source: 'agent:main', createdAt: mins(19), startedAt: mins(18) }),
  T({ id: 8, title: 'Ý kiến Nghiên cứu: giảm giá Starter?', agentId: 'research', status: 'done', parentId: 6, depth: 1, source: 'agent:main', result: 'Đối thủ A và B đều đang giữ giá; giảm giá chưa chắc tăng chuyển đổi.', createdAt: mins(19), startedAt: mins(18), finishedAt: mins(9) }),
  T({ id: 9, title: 'Báo cáo sáng thứ Hai', agentId: 'main', status: 'done', source: 'schedule:1', trigger: 'schedule', result: 'Tuần qua có 41 lượt chạy, chi phí $2.10.', createdAt: mins(1500), startedAt: mins(1499), finishedAt: mins(1495) }),
  T({ id: 10, title: 'Soạn nháp trả lời khách Lan', agentId: 'sales-a', status: 'review', source: 'module:care', contextProfile: 'lean', result: 'Chào chị Lan, bên em gửi chị bảng giá…', createdAt: mins(40), startedAt: mins(39), finishedAt: mins(38) }),
);

const runBase = { sessionId: null, output: null, errorFamily: null, error: null, accessJson: null, skillsJson: '["tra-loi-khach"]', finishedAt: null, durationMs: null, inputTokens: null, outputTokens: null, costUsd: null, model: null };
export const runs: Run[] = [
  { ...runBase, id: 1, taskId: 1, agentId: 'main', runtime: 'claude', model: 'claude-sonnet-5-5', status: 'running', trigger: 'assigned', startedAt: mins(10), accessJson: '1' },
  { ...runBase, id: 2, taskId: 3, agentId: 'content', runtime: 'grok', status: 'done', trigger: 'assigned', startedAt: mins(90), finishedAt: mins(86), durationMs: 240_000, inputTokens: 5200, outputTokens: 880, costUsd: null, output: '**Caption 1:** …', accessJson: '1' },
  { ...runBase, id: 3, taskId: 4, agentId: 'research', runtime: 'hermes', status: 'done', trigger: 'assigned', startedAt: mins(296), finishedAt: mins(280), durationMs: 960_000, inputTokens: 21000, outputTokens: 3100, costUsd: 0.38, accessJson: '1' },
  { ...runBase, id: 4, taskId: 5, agentId: 'main', runtime: 'claude', status: 'failed', trigger: 'assigned', startedAt: mins(239), finishedAt: mins(238), durationMs: 41_000, errorFamily: 'auth', error: 'Composio trả về 401.', accessJson: '1' },
  { ...runBase, id: 5, taskId: 8, agentId: 'research', runtime: 'hermes', status: 'done', trigger: 'assigned', startedAt: mins(18), finishedAt: mins(9), durationMs: 540_000, inputTokens: 9000, outputTokens: 1200, costUsd: 0.12, accessJson: '1' },
  { ...runBase, id: 6, taskId: 7, agentId: 'sales-a', runtime: 'codex', status: 'running', trigger: 'assigned', startedAt: mins(18), accessJson: '1' },
  { ...runBase, id: 7, taskId: 9, agentId: 'main', runtime: 'claude', status: 'done', trigger: 'schedule', startedAt: mins(1499), finishedAt: mins(1495), durationMs: 200_000, inputTokens: 8000, outputTokens: 700, costUsd: 0.09, accessJson: '1' },
];

export const accessSnapshot = (agentId: string) => {
  const a = agents.find((x) => x.id === agentId) ?? agents[0]!;
  return {
    agentId: a.id,
    readDirs: Object.entries(a.access.brain).filter(([, g]) => g.read.length).map(([folderId, g]) => ({ folderId, root: `/brain/${folderId}`, globs: g.read })),
    writeDirs: Object.entries(a.access.brain).filter(([, g]) => g.write.length).map(([folderId, g]) => ({ folderId, root: `/brain/${folderId}`, globs: g.write })),
    addDirs: [], memory: a.access.memory,
    mcpServers: Object.entries(a.access.connections).map(([id, t]) => ({ id, allowedTools: t === true ? ['*'] : t })),
    envVars: [], skills: a.access.skills === 'all' ? ['tra-loi-khach', 'viet-caption'] : a.access.skills, moduleScopes: a.access.modules, permission: a.permission, tools: a.context === 'lean' ? ('none' as const) : ('default' as const),
  };
};

export const runEvents: StoredRunEvent[] = [
  { id: 1, runId: 1, ts: mins(10), event: { type: 'status', message: 'Bắt đầu lượt chạy' } },
  { id: 2, runId: 1, ts: mins(9), event: { type: 'tool', name: 'Đọc brain: Ban-hang/hoi-dap.md', status: 'end' } },
  { id: 3, runId: 1, ts: mins(8), event: { type: 'text', text: 'Mình đã đọc 38 hội thoại tuần này. ' } },
  { id: 4, runId: 1, ts: mins(7), event: { type: 'text', text: 'Năm câu hỏi lặp lại nhiều nhất: giá gói Pro, thời gian hoàn tiền, hỗ trợ cài đặt, xuất hoá đơn và dùng thử.' } },
];

export const comments: TaskComment[] = [
  { id: 1, taskId: 3, author: 'agent:content', body: 'Đã soạn 3 caption, chờ bạn duyệt.', runId: 2, createdAt: mins(86) },
  { id: 2, taskId: 3, author: 'user', body: 'Caption 2 hơi dài, rút gọn giúp mình.', runId: null, createdAt: mins(60) },
  { id: 3, taskId: 5, author: 'system', body: 'Lượt chạy thất bại: auth.', runId: 4, createdAt: mins(238) },
];

export const schedules: Schedule[] = [
  { id: 1, name: 'Báo cáo sáng thứ Hai', agentId: 'main', cron: '0 8 * * 1', timezone: 'Asia/Ho_Chi_Minh', prompt: 'Tóm tắt tuần qua: số lượt chạy, chi phí, việc lỗi.', enabled: true, lastRunAt: mins(1500), nextRunAt: new Date(Date.now() + 4 * 86400_000).toISOString(), lastTaskId: 9, createdAt: mins(20000), updatedAt: mins(1500) },
  { id: 2, name: 'Quét tin đối thủ mỗi tối', agentId: 'research', cron: '0 21 * * *', timezone: 'Asia/Ho_Chi_Minh', prompt: 'Tìm tin mới về 3 đối thủ chính và ghi vào Second Brain.', enabled: false, lastRunAt: null, nextRunAt: null, lastTaskId: null, createdAt: mins(9000), updatedAt: mins(9000) },
];

export const conversations: Conversation[] = [
  { id: 1, agentId: 'main', title: 'Kế hoạch tuần', sessionId: null, sessionRuntime: null, createdAt: mins(300), updatedAt: mins(25) },
  { id: 2, agentId: 'content', title: 'Ý tưởng caption tháng 11', sessionId: null, sessionRuntime: null, createdAt: mins(700), updatedAt: mins(190) },
];
export const messages: Message[] = [
  { id: 1, conversationId: 1, role: 'user', content: 'Tuần này mình nên ưu tiên việc gì?', taskId: null, createdAt: mins(30) },
  { id: 2, conversationId: 1, role: 'agent', content: 'Mình đề xuất 3 việc:\n\n1. Duyệt caption khuyến mãi\n2. Xử lý lỗi đồng bộ Composio\n3. Chốt giá gói Starter\n\nMình đã **giao Sales A và Nghiên cứu** cho việc thứ 3.', taskId: 6, createdAt: mins(25) },
  { id: 3, conversationId: 2, role: 'user', content: 'Cho mình 5 ý tưởng caption tháng 11.', taskId: null, createdAt: mins(195) },
  { id: 4, conversationId: 2, role: 'agent', content: '1. “Tháng 11, dịu dàng hơn.”\n2. “Quà nhỏ cho khách cũ.”', taskId: null, createdAt: mins(190) },
];

export const memories: Memory[] = [
  { id: 1, agentId: null, content: 'Giờ làm việc của cửa hàng: 8h–18h, nghỉ Chủ nhật.', source: 'user', sourceTaskId: null, sourceRunId: null, pinned: true, useCount: 14, lastUsedAt: mins(40), createdAt: mins(20000) },
  { id: 2, agentId: null, content: 'Khách Minh Anh ưu tiên gói Pro, hay hỏi về hoá đơn VAT.', source: 'agent:sales-a', sourceTaskId: 2, sourceRunId: null, pinned: false, useCount: 3, lastUsedAt: mins(300), createdAt: mins(4000) },
  { id: 3, agentId: 'main', content: 'Chủ thích báo cáo ngắn, tối đa 5 gạch đầu dòng.', source: 'user', sourceTaskId: null, sourceRunId: null, pinned: true, useCount: 9, lastUsedAt: mins(12), createdAt: mins(15000) },
  { id: 4, agentId: 'content', content: 'Tránh dùng từ “siêu”, “cực”, “số 1” trong caption.', source: 'user', sourceTaskId: null, sourceRunId: null, pinned: false, useCount: 5, lastUsedAt: mins(190), createdAt: mins(9000) },
];

export const brainFolders: BrainFolderView[] = [
  { id: 'tri-thuc', name: 'Tri thức chung', path: '/brain/tri-thuc', description: 'Thương hiệu, ý tưởng, nghiên cứu', docs: 5, exists: true },
  { id: 'ban-hang', name: 'Bán hàng', path: '/brain/ban-hang', description: 'Bảng giá, câu hỏi thường gặp', docs: 2, exists: true },
  { id: 'luu-tru', name: 'Lưu trữ', path: '/brain/luu-tru', description: 'Thư mục chưa tạo', docs: 0, exists: false },
];
export const brainTree: Record<string, BrainTreeNode[]> = {
  'tri-thuc': [
    { name: 'Thuong-hieu', path: 'Thuong-hieu', type: 'dir', children: [{ name: 'giong-van.md', path: 'Thuong-hieu/giong-van.md', type: 'file' }, { name: 'logo.md', path: 'Thuong-hieu/logo.md', type: 'file' }] },
    { name: 'Y-tuong', path: 'Y-tuong', type: 'dir', children: [{ name: 'caption-thang-11.md', path: 'Y-tuong/caption-thang-11.md', type: 'file' }] },
    { name: 'Nghien-cuu', path: 'Nghien-cuu', type: 'dir', children: [{ name: 'doi-thu.md', path: 'Nghien-cuu/doi-thu.md', type: 'file' }] },
    { name: 'README.md', path: 'README.md', type: 'file' },
  ],
  'ban-hang': [{ name: 'bang-gia.md', path: 'bang-gia.md', type: 'file' }, { name: 'hoi-dap.md', path: 'hoi-dap.md', type: 'file' }],
  'luu-tru': [],
};
export const brainFiles: Record<string, string> = {
  'tri-thuc:Thuong-hieu/giong-van.md': '# Giọng văn\n\n- Gần gũi, rõ ràng\n- Không phóng đại\n- Xưng “mình” với khách\n',
  'tri-thuc:Nghien-cuu/doi-thu.md': '# Đối thủ\n\n| Tên | Giá khởi điểm | Điểm mạnh |\n|---|---|---|\n| A | 290k | Giao diện đẹp |\n| B | 250k | Hỗ trợ nhanh |\n',
  'ban-hang:bang-gia.md': '# Bảng giá\n\n- Starter: 199k/tháng\n- Pro: 490k/tháng\n- Doanh nghiệp: liên hệ\n',
  'ban-hang:hoi-dap.md': '# Hỏi đáp\n\n**Có dùng thử không?** Có, 14 ngày.\n',
};

export const skills: SkillView[] = [
  { id: 'tra-loi-khach', name: 'Trả lời khách', description: 'Cách trả lời khách ngắn gọn, đúng giá, có lời chào.', path: '/skills/tra-loi-khach/SKILL.md', dir: '/skills/tra-loi-khach', source: 'library', usedBy: ['sales-a'] },
  { id: 'viet-caption', name: 'Viết caption', description: 'Khung viết caption mạng xã hội theo giọng thương hiệu.', path: '/skills/viet-caption/SKILL.md', dir: '/skills/viet-caption', source: 'library', usedBy: ['content'] },
  { id: 'care-nhap-tra-loi', name: 'Nháp trả lời CSKH', description: 'Skill do module care thêm khi được bật.', path: '/modules/care/skills/x/SKILL.md', dir: '/modules/care/skills/x', source: 'module:care', usedBy: [] },
];
export const skillContent: Record<string, string> = {
  'tra-loi-khach': '---\nname: Trả lời khách\n---\n\n# Trả lời khách\n\n1. Chào bằng tên khách.\n2. Trả lời đúng câu hỏi trong 3 câu.\n3. Kết bằng một bước tiếp theo.\n\n> Không hứa giảm giá khi chưa có duyệt.',
  'viet-caption': '# Viết caption\n\nMở bằng một ý chính, không quá 2 dòng. Thêm một lời kêu gọi nhẹ.',
};

export const board: BoardEntry[] = [
  { id: 1, agentId: 'main', taskId: 1, kind: 'status', text: 'Đang đọc 38 hội thoại tuần này', createdAt: mins(9) },
  { id: 2, agentId: 'research', taskId: 8, kind: 'done', text: 'Xong ý kiến về giá Starter', createdAt: mins(9) },
  { id: 3, agentId: 'content', taskId: 3, kind: 'review', text: 'Caption khuyến mãi đã sẵn sàng để duyệt', createdAt: mins(86) },
  { id: 4, agentId: 'main', taskId: 5, kind: 'error', text: 'Đồng bộ Composio lỗi xác thực', createdAt: mins(238) },
];

export const audit: AuditEntry[] = [
  { id: 1, ts: mins(3), actor: 'user', action: 'task.create', target: 'task:2', runId: null, detail: { agentId: 'sales-a' } },
  { id: 2, ts: mins(10), actor: 'agent:main', action: 'brain.read', target: 'ban-hang:hoi-dap.md', runId: 1, detail: null },
  { id: 3, ts: mins(86), actor: 'agent:content', action: 'brain.write', target: 'tri-thuc:Y-tuong/caption-thang-11.md', runId: 2, detail: { bytes: 912 } },
  { id: 4, ts: mins(238), actor: 'system', action: 'access.denied', target: 'connection:composio', runId: 4, detail: { reason: 'auth' } },
  { id: 5, ts: mins(1400), actor: 'user', action: 'module.add', target: 'module:care', runId: null, detail: { installAgents: true } },
];

export const attention: AttentionItem[] = [
  { key: 'task:3', kind: 'review', title: 'Caption khuyến mãi chờ bạn duyệt', detail: 'Biên tập nội dung · 86 phút trước', taskId: 3, link: '/tasks/3', severity: 'warn', createdAt: mins(86) },
  { key: 'task:10', kind: 'review', title: 'Nháp trả lời khách Lan chờ duyệt', detail: 'Sales A · module care', taskId: 10, link: '/tasks/10', severity: 'info', createdAt: mins(38) },
  { key: 'task:5', kind: 'failed', title: 'Đồng bộ danh sách khách từ Composio bị lỗi', detail: 'Khoá API không hợp lệ', taskId: 5, link: '/tasks/5', severity: 'error', createdAt: mins(238) },
];

export const connections: ConnectionView[] = [
  { id: 'composio', type: 'composio', description: 'Gmail, Calendar và các app khác qua Composio', apiKeyEnv: 'COMPOSIO_API_KEY', toolkits: ['gmail', 'googlecalendar'], ready: false, grantedTo: ['main'] },
  { id: 'web-search', type: 'mcp', description: 'Tìm kiếm web', command: 'npx', args: ['-y', 'search-mcp'], env: { API_KEY: '[set]' }, ready: true, grantedTo: ['research'] },
  { id: 'github', type: 'env', description: 'Token GitHub (chỉ đọc)', env: { GITHUB_TOKEN: '[missing]' }, ready: false, grantedTo: [] },
];

export const modules: ModuleInfo[] = [
  {
    manifest: { id: 'care', name: 'Chăm sóc khách hàng', description: 'Hộp thư khách, nháp trả lời do agent soạn, duyệt rồi gửi.', version: '0.1.0', category: 'sales', requires: { connections: ['composio'] }, scopes: { 'inbox.read': 'Đọc hộp thư khách', 'reply.draft': 'Soạn nháp trả lời', 'reply.send': 'Gửi trả lời cho khách' }, tables: ['care_threads'], agentTemplates: ['cskh'], skills: ['tra-loi-khach'], settings: { autoReply: { label: 'Tự động trả lời', type: 'boolean', default: false, help: 'Tắt thì mọi tin chỉ thành nháp.' } } },
    state: { id: 'care', enabled: true, version: '0.1.0', installedAt: mins(1400), settings: {} }, requirements: [{ kind: 'connection', id: 'composio', ok: true, message: 'Đã có kết nối composio' }], ready: true, hasServer: true, hasWeb: true, agentTemplates: ['cskh'],
  },
  {
    manifest: { id: 'marketing', name: 'Marketing', description: 'Lịch đăng bài, phân tích chiến dịch và gợi ý nội dung.', version: '0.1.0', category: 'marketing', requires: { modules: ['care'], connections: ['composio', 'facebook'] }, scopes: { 'posts.read': 'Đọc bài đăng', 'posts.write': 'Soạn bài đăng' }, tables: ['mk_posts'], agentTemplates: ['marketer'] },
    state: { id: 'marketing', enabled: false, version: '0.1.0', installedAt: null, settings: {} },
    requirements: [{ kind: 'module', id: 'care', ok: true, message: 'Module care đã bật' }, { kind: 'connection', id: 'facebook', ok: false, message: 'Chưa có kết nối “facebook”. Vào Kết nối để thêm trong config/connections.yaml.' }], ready: false, hasServer: true, hasWeb: true, agentTemplates: ['marketer'],
  },
  {
    manifest: { id: '_template', name: 'Module mẫu', description: 'Khung module để học cách viết module riêng.', version: '0.1.0', category: 'other', scopes: { 'notes.read': 'Đọc ghi chú mẫu' }, tables: ['template_notes'] },
    state: { id: '_template', enabled: false, version: '0.1.0', installedAt: null, settings: {} }, requirements: [], ready: true, hasServer: true, hasWeb: true, agentTemplates: [],
  },
  {
    manifest: { id: 'zalo', name: 'Zalo', description: 'Kênh Zalo cho module care.', version: '0.1.0', category: 'sales', requires: { modules: ['care'] }, tables: ['zalo_threads'] },
    state: { id: 'zalo', enabled: false, version: '0.1.0', installedAt: mins(5000), settings: {} }, requirements: [{ kind: 'module', id: 'care', ok: true, message: 'Module care đã bật' }], ready: true, hasServer: true, hasWeb: false, agentTemplates: [], error: 'Không khởi động được daemon: cổng 3999 đang bận.',
  },
];

export const runtimes: RuntimeReport[] = (['claude', 'codex', 'grok', 'hermes', 'mock'] as const).map((r) => {
  const enforces = {
    claude: { context: 'hard', mcp: 'hard', fileRead: 'hard', fileWrite: 'hard', shell: 'hard', note: undefined },
    codex: { context: 'hard', mcp: 'hard', fileRead: 'soft', fileWrite: 'hard', shell: 'soft', note: 'Codex không chặn được đọc file ngoài thư mục làm việc.' },
    grok: { context: 'hard', mcp: 'soft', fileRead: 'soft', fileWrite: 'soft', shell: 'soft', note: 'Grok chỉ nhận lời dặn trong prompt cho phần file và shell.' },
    hermes: { context: 'hard', mcp: 'hard', fileRead: 'soft', fileWrite: 'soft', shell: 'soft', note: 'Hermes chặn công cụ MCP nhưng không chặn file.' },
    mock: { context: 'hard', mcp: 'hard', fileRead: 'hard', fileWrite: 'hard', shell: 'hard', note: undefined },
  }[r] as RuntimeReport['capabilities']['enforces'];
  return {
    runtime: r, label: { claude: 'Claude', codex: 'Codex', grok: 'Grok', hermes: 'Hermes', mock: 'Mock' }[r], status: r === 'grok' ? ('warn' as const) : r === 'hermes' ? ('fail' as const) : ('pass' as const),
    version: r === 'mock' ? '1.0' : '2.1.0', command: r === 'mock' ? undefined : `/usr/local/bin/${r}`,
    checks: r === 'grok' ? [{ code: 'grok.login', level: 'warn' as const, message: 'Chưa đăng nhập Grok.', hint: 'Chạy `grok login` trong terminal.' }] : r === 'hermes' ? [{ code: 'hermes.missing', level: 'error' as const, message: 'Không tìm thấy lệnh hermes.', hint: 'Cài Hermes rồi chạy lại “Kiểm tra”.' }] : [{ code: 'bin', level: 'info' as const, message: 'Tìm thấy lệnh và chạy được `--version`.' }],
    testedAt: NOW(), capabilities: { resume: r !== 'grok', systemPrompt: r === 'claude' ? 'native' : 'inline', reportsCost: r === 'claude' || r === 'hermes', images: r === 'claude', noTools: r !== 'grok', enforces },
  };
});

export function nextId(list: { id: number }[]): number {
  return list.reduce((m, x) => Math.max(m, x.id), 0) + 1;
}
export { NOW };
