# API: Gói Team, Chợ Agent, Đề xuất cải tiến

Mọi route nằm dưới `/api`, lỗi theo `docs/dev/API.md` (`{ error: { code, message } }`, message tiếng Việt). Mã nguồn: `src/api/routes/teams.ts`.

## Gói Team (`/api/teams`)

Định dạng gói (thư mục trong `teams/<slug>/` hoặc file zip): `TEAM.md` (frontmatter `schema: aios-team/v1`, `name`, `slug`, `description`, `manager`, `inputs`, `requiredSkills`, `prerequisites`), `schedules.yaml`, `agents/<id>/{agent.yaml.template, persona.md, skills/<skill>/SKILL.md, knowledge/*}`. Chỉ nhận file văn bản; script bị từ chối.

| Route | Việc |
|---|---|
| `GET /api/teams` | `{ items, imported, problems, history }` |
| `GET /api/teams/:kind/:id` | chi tiết gói (`kind` = `catalog` hoặc `import`) |
| `POST /api/teams/preview` | body `{ source:{kind,id}, inputs?, strategy?: 'rename'\|'skip', agentStrategies?, runtimes?, defaultRuntime? }` → kế hoạch cài (agent, lịch, skill, cảnh báo, `blockers`, `canInstall`) |
| `POST /api/teams/install` | cùng body → 201 `{ agents, skills, schedules, warnings, nextSteps }`. Lỗi giữa chừng thì hoàn tác toàn bộ |
| `POST /api/teams/import` | `{ base64 }` (file zip ≤ 5 MB) → 201 `{ id, team }`; gói nhập giữ trong bộ nhớ 1 giờ |
| `DELETE /api/teams/import/:id` | bỏ gói đã nhập |
| `POST /api/teams/export` | `{ name, agentIds, slug?, description?, manager? }` → `{ filename, base64, files, redactions, inputs }`; khoá/token/đường dẫn/email được gỡ thành ô `{{input.KEY}}` |

Quy tắc cài: agent tạo qua `AgentRegistry` (permission `safe`, `access` rỗng; skill của gói được cấp cho agent đó), trùng id thì đổi tên `-2`… hoặc bỏ qua; skill đã có trong thư viện thì giữ bản cũ; lịch tạo ở trạng thái **tắt**; input kiểu `secret` không bao giờ được điền vào file.

## Chợ Agent (`/api/agent-market`)

| Route | Việc |
|---|---|
| `GET /api/agent-market` | `{ templates, teams }` |
| `POST /api/agent-market/:id/preview` | body `{ name?, id?, runtime?, model?, fields? }` → `{ agentId, files[], newSkills, missingRequired, warnings }` |
| `POST /api/agent-market/:id/install` | cùng body → 201 `{ agent, createdSkills, files }`; 422 nếu thiếu ô bắt buộc |

## Đề xuất cải tiến (`/api/recos`)

Đề xuất được tính trực tiếp từ trạng thái hệ thống (việc thất bại 7 ngày, ngân sách agent ≥ 80%, skill chưa cấp, Second Brain chưa cấp, module chưa thêm). Quyết định của chủ lưu trong `kv` (`recos:decisions`).

| Route | Việc |
|---|---|
| `GET /api/recos?status=open\|all\|new\|cart\|done\|skipped&arm=` | `{ items, counts }` |
| `PUT /api/recos/:id/status` | `{ status: 'new'\|'cart'\|'skipped' }` |
| `POST /api/recos/:id/apply` | chạy hành động: giao việc cho `main`, cấp quyền đọc Second Brain, hoặc thêm module |
| `POST /api/recos/apply-cart` | áp dụng lần lượt mọi mục trong giỏ → `{ results:[{id,ok,message}] }` |

`:id` phải được `encodeURIComponent` (id có dấu `:`).
