// Mock routes for /api/teams, /api/agent-market and /api/recos. Registered in mock/index.ts.
import type { InstallPlan, InstallResult, MarketCatalog, MarketPreview, Reco, RecosList, TeamSummary, TeamsList } from '../teams';

type Handler = (params: string[], query: URLSearchParams, body: any) => unknown;
export type MockRoute = [method: string, pattern: string, fn: Handler];

class Fail extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const team = (slug: string, name: string, description: string, manager: string, agents: [string, string][], inputs: TeamSummary['inputs']): TeamSummary => ({
  slug, name, version: '1', description, tags: ['mẫu'], manager,
  agents: agents.map(([id, n]) => ({ id, name: n, description: '', runtime: null, model: null, skills: [], fileCount: 2 })),
  schedules: [{ id: 'weekly', agent: manager, cron: '0 8 * * 1', tz: 'Asia/Ho_Chi_Minh' }],
  requiredSkills: [], prerequisites: ['Bật agent trong Agents để lịch chạy.'], inputs, warnings: [], source: { kind: 'catalog', id: slug },
});

const catalog: TeamSummary[] = [
  team('cskh-zalo-email', 'CSKH Zalo và Email', 'Đội chăm sóc khách hàng gồm một agent trả lời khách và một agent tổng hợp khiếu nại cuối ngày.', 'cskh-agent',
    [['cskh-agent', 'CSKH Zalo và Email'], ['cskh-complaints', 'Tổng hợp khiếu nại']],
    [{ key: 'SHOP_NAME', label: 'Tên cửa hàng', description: 'Dùng khi agent xưng hô với khách.', kind: 'plain', required: true, defaultValue: '' }]),
  team('fb-content-studio', 'FB Content Studio', 'Đội nội dung Facebook: trưởng nhóm content và agent trực Fanpage.', 'fb-content-lead',
    [['fb-content-lead', 'Trưởng nhóm Content FB'], ['fb-comment-agent', 'Trực Fanpage']],
    [{ key: 'BRAND_NAME', label: 'Tên thương hiệu', description: 'Tên thương hiệu hoặc Fanpage.', kind: 'plain', required: true, defaultValue: '' }]),
];
let imported: TeamSummary[] = [];
const history: TeamsList['history'] = [];
const existingAgents = new Set(['main', 'cskh-agent']);

function find(kind: string, id: string): TeamSummary {
  const t = (kind === 'import' ? imported : catalog).find((x) => x.source.id === id);
  if (!t) throw new Fail(404, 'not_found', 'Không tìm thấy gói này.');
  return t;
}

function plan(b: { source: { kind: string; id: string }; inputs?: Record<string, string>; strategy?: 'rename' | 'skip'; defaultRuntime?: any }): InstallPlan {
  const t = find(b.source.kind, b.source.id);
  const strategy = b.strategy ?? 'rename';
  const agents = t.agents.map((a) => {
    const collision = existingAgents.has(a.id);
    const skip = collision && strategy === 'skip';
    return { pkgId: a.id, name: a.name, description: a.description, finalId: collision && !skip ? `${a.id}-2` : a.id, action: (skip ? 'skip' : 'create') as 'skip' | 'create', collision, runtime: b.defaultRuntime ?? 'claude', model: null, skills: [], files: [`agents/${a.id}/persona.md`], reportsTo: a.id === t.manager ? 'main' : t.manager };
  });
  const missingInputs = t.inputs.filter((i) => i.required && !b.inputs?.[i.key]?.trim()).map((i) => i.key);
  return {
    team: { slug: t.slug, name: t.name, version: t.version, description: t.description, manager: t.manager, prerequisites: t.prerequisites, body: '' },
    strategy, agents,
    schedules: t.schedules.map((s) => ({ id: s.id, name: `${t.name}: ${s.id}`, finalAgentId: agents.find((a) => a.pkgId === s.agent)?.finalId ?? s.agent, cron: s.cron, tz: s.tz ?? 'UTC', willCreate: true, skipReason: null })),
    skills: [], inputs: t.inputs.map((i) => ({ ...i, provided: !!b.inputs?.[i.key]?.trim() })), missingInputs,
    warnings: [], blockers: missingInputs.map((k) => `Cần điền "${t.inputs.find((i) => i.key === k)!.label}".`), canInstall: missingInputs.length === 0,
  };
}

const templates: MarketCatalog['templates'] = [
  { id: 'research-analyst', name: 'Nghiên cứu thị trường', category: 'Nghiên cứu', description: 'Tìm, đối chiếu và tóm tắt thông tin về thị trường, luôn kèm nguồn.', outcome: 'Báo cáo ngắn có nguồn.', capabilities: ['Tóm tắt đối thủ', 'Tổng hợp xu hướng'], examples: ['Tóm tắt 3 đối thủ chính tuần này'], skills: [], fields: [{ key: 'business', label: 'Doanh nghiệp và lĩnh vực', required: true, multiline: true, placeholder: 'Bạn bán gì, cho ai.', help: '', defaultValue: '' }] },
  { id: 'content-writer', name: 'Biên tập nội dung', category: 'Nội dung', description: 'Viết bài, caption và email theo giọng thương hiệu; mọi bản thảo chờ bạn duyệt.', outcome: 'Bản nháp đúng giọng.', capabilities: ['Viết caption', 'Soạn email'], examples: ['Viết 3 caption khuyến mãi'], skills: [], fields: [{ key: 'brand', label: 'Tên thương hiệu và sản phẩm', required: true, multiline: true, placeholder: 'Tên, sản phẩm chủ lực.', help: '', defaultValue: '' }] },
  { id: 'education-advisor', name: 'Tư vấn học viên', category: 'Đào tạo', description: 'Giải đáp khóa học và hướng dẫn học viên đăng ký.', outcome: 'Có câu trả lời thử đầu tiên trong 5 phút.', capabilities: ['Tư vấn khóa học', 'Trả lời FAQs'], examples: ['Học phí bao nhiêu?'], skills: [{ id: 'course-advising', name: 'Gợi ý khóa học', description: 'Đối chiếu nhu cầu với khóa có thật.' }], fields: [{ key: 'businessName', label: 'Tên trung tâm', required: true, multiline: false, placeholder: 'Trung tâm của bạn', help: '', defaultValue: '' }, { key: 'courses', label: 'Khóa học / dịch vụ', required: true, multiline: true, placeholder: 'Tên khóa, học phí, lịch.', help: '', defaultValue: '' }] },
];

function marketPreview(id: string, b: { name?: string; id?: string; runtime?: any; fields?: Record<string, string> } = {}): MarketPreview {
  const t = templates.find((x) => x.id === id);
  if (!t) throw new Fail(404, 'not_found', 'Không tìm thấy mẫu agent.');
  const name = b.name?.trim() || t.name;
  const missingRequired = t.fields.filter((f) => f.required && !b.fields?.[f.key]?.trim()).map((f) => f.label);
  return {
    templateId: id, agentId: b.id?.trim() || id, name, runtime: b.runtime ?? 'claude', missingRequired, warnings: [], existingSkills: [], newSkills: t.skills.map((s) => s.id),
    files: [
      { path: 'CLAUDE.md', kind: 'persona', description: 'Vai trò, giọng và giới hạn hành vi.', content: `# ${name}\n\n${t.description}\n` },
      { path: 'knowledge/customer-care.md', kind: 'knowledge', description: 'Hồ sơ điền từ biểu mẫu.', content: t.fields.map((f) => `## ${f.label}\n${b.fields?.[f.key] ?? 'Chưa cung cấp.'}`).join('\n\n') },
      ...t.skills.map((s) => ({ path: `skills/${s.id}/SKILL.md`, kind: 'skill' as const, description: s.description, content: `# ${s.name}\n` })),
    ],
  };
}

const recos: Reco[] = [
  { id: 'failed-tasks:content-fb', arm: 'work', title: 'Agent "content-fb" có 3 việc thất bại trong 7 ngày', benefit: 'Tìm nguyên nhân chung để việc không thất bại lặp lại.', actionText: 'Giao cho agent main xem các việc thất bại và đề xuất cách sửa.', actionKind: 'task', effort: 's', priority: 2, evidence: ['timeout sau 600s'], status: 'new', result: null, decidedAt: null },
  { id: 'budget:sales-a', arm: 'agents', title: 'Agent "sales-a" sắp hết ngân sách tháng (86%)', benefit: 'Tránh agent bị dừng giữa chừng.', actionText: 'Giao cho agent main phân tích chi phí và đề xuất nâng ngân sách hoặc đổi runtime.', actionKind: 'task', effort: 'xs', priority: 1, evidence: ['Đã dùng $8.60 / $10.00'], status: 'new', result: null, decidedAt: null },
  { id: 'brain-ungranted:kb', arm: 'brain', title: 'Second Brain "Tri thức công ty" chưa cấp cho agent nào', benefit: 'Agent chỉ trả lời dựa trên tri thức của bạn khi được cấp quyền đọc.', actionText: 'Cấp quyền ĐỌC (không ghi) thư mục cho agent "main".', actionKind: 'grant-brain', effort: 'xs', priority: 2, evidence: [], status: 'new', result: null, decidedAt: null },
  { id: 'module:care', arm: 'modules', title: 'Module "Chăm sóc khách hàng" chưa được thêm', benefit: 'Hộp thư chung cho Zalo, Gmail và Telegram.', actionText: 'Thêm module (có thể gỡ lại bất cứ lúc nào).', actionKind: 'add-module', effort: 's', priority: 3, evidence: [], status: 'new', result: null, decidedAt: null },
];
const recoList = (status = 'open', arm?: string): RecosList => {
  const open = recos.filter((r) => r.status === 'new' || r.status === 'cart');
  const counts: Record<string, number> = { total: open.length, cart: open.filter((r) => r.status === 'cart').length };
  for (const r of open) counts[r.arm] = (counts[r.arm] ?? 0) + 1;
  let items = status === 'open' ? open : status === 'all' ? recos : recos.filter((r) => r.status === status);
  if (arm) items = items.filter((r) => r.arm === arm);
  return { items, counts };
};
const recoById = (id: string) => {
  const r = recos.find((x) => x.id === decodeURIComponent(id));
  if (!r) throw new Fail(404, 'not_found', 'Đề xuất này không còn nữa.');
  return r;
};
const applyReco = (r: Reco) => {
  if (r.status === 'done') throw new Fail(409, 'conflict', 'Đề xuất này đã được áp dụng.');
  r.status = 'done';
  r.result = r.actionKind === 'task' ? 'Đã giao việc #41 cho main.' : 'Đã áp dụng.';
  r.decidedAt = new Date().toISOString();
  return r;
};

export const teamsMockRoutes: MockRoute[] = [
  ['GET', '/teams', (): TeamsList => ({ items: catalog, imported, problems: [], history: [...history].reverse() })],
  ['GET', '/teams/:kind/:id', ([k, id]) => find(k!, id!)],
  ['POST', '/teams/preview', (_p, _q, b) => plan(b)],
  ['POST', '/teams/install', (_p, _q, b): InstallResult => {
    const p = plan(b);
    if (!p.canInstall) throw new Fail(400, 'bad_request', p.blockers.join(' '));
    const made = p.agents.filter((a) => a.action === 'create');
    for (const a of made) existingAgents.add(a.finalId);
    history.push({ at: new Date().toISOString(), slug: p.team.slug, name: p.team.name, agents: made.map((a) => a.finalId), schedules: p.schedules.length, skills: [] });
    return { slug: p.team.slug, name: p.team.name, agents: made.map((a) => ({ pkgId: a.pkgId, id: a.finalId, name: a.name, runtime: a.runtime })), skills: [], schedules: p.schedules.map((s, i) => ({ id: i + 1, name: s.name, agentId: s.finalAgentId, cron: s.cron })), warnings: [], nextSteps: ['Các lịch được tạo ở trạng thái TẮT. Bật từng lịch sau khi kiểm tra.', ...p.team.prerequisites] };
  }],
  ['POST', '/teams/import', () => {
    const t = { ...catalog[1]!, name: 'Gói đã nhập', slug: 'imported-team', source: { kind: 'import' as const, id: 'abcdef0123456789' } };
    imported = [t];
    return { id: t.source.id, team: t };
  }],
  ['DELETE', '/teams/import/:id', () => { imported = []; return { ok: true }; }],
  ['POST', '/teams/export', (_p, _q, b) => {
    if (!b.agentIds?.length) throw new Fail(400, 'bad_request', 'Chọn ít nhất một agent để xuất.');
    return { filename: 'doi-cua-toi.zip', base64: btoa('PK mock'), files: ['TEAM.md', ...b.agentIds.map((a: string) => `agents/${a}/persona.md`)], redactions: 2, inputs: ['SECRET_1', 'EMAIL_1'] };
  }],
  ['GET', '/agent-market', (): MarketCatalog => ({ templates, teams: catalog })],
  ['POST', '/agent-market/:id/preview', ([id], _q, b) => marketPreview(id!, b)],
  ['POST', '/agent-market/:id/install', ([id], _q, b) => {
    const p = marketPreview(id!, b);
    if (p.missingRequired.length) throw new Fail(400, 'bad_request', `Cần điền: ${p.missingRequired.join(', ')}.`);
    return { agent: { id: p.agentId, name: p.name, runtime: p.runtime }, createdSkills: p.newSkills, files: p.files.map((f) => f.path) };
  }],
  ['GET', '/recos', (_p, q) => recoList(q.get('status') ?? 'open', q.get('arm') ?? undefined)],
  ['POST', '/recos/apply-cart', () => ({ results: recos.filter((r) => r.status === 'cart').map((r) => { applyReco(r); return { id: r.id, ok: true, message: r.result ?? '' }; }) })],
  ['PUT', '/recos/:id/status', ([id], _q, b) => { const r = recoById(id!); r.status = b.status; return r; }],
  ['POST', '/recos/:id/apply', ([id]) => applyReco(recoById(id!))],
];

export { Fail as TeamsMockError };
