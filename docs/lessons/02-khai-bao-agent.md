# Bài 2. Khai báo agent

Sau bài này bạn có thể:

- Viết một `agent.yaml` đúng, hiểu từng trường và giá trị mặc định của nó.
- Chọn `permission`, `context` và `runtime_options` hợp lý cho từng loại agent.
- Tạo, sửa, lưu trữ agent bằng ba cách: giao diện, API và tay trên thư mục.
- Đọc thông báo lỗi khi một `agent.yaml` sai.

## 2.1 Một agent là một thư mục

```
agents/
├── demo/
│   ├── agent.yaml     ← cấu hình (bắt buộc)
│   └── persona.md     ← lời dặn cho agent: vai trò, giọng điệu (tuỳ chọn)
├── main/
├── coder/
└── _archive/          ← agent đã lưu trữ (tự tạo, bị bỏ qua khi quét)
```

Id của agent chính là **tên thư mục**. Registry (`src/agents/registry.ts:41`, hàm `reload`) quét `agents/`, bỏ qua thư mục bắt đầu bằng `_` hoặc `.`, đọc từng `agent.yaml`, kiểm tra bằng schema zod. Agent nào sai thì không nạp, nhưng **không làm sập cả hệ thống**: lỗi được gom vào danh sách `errors()` và hiện ở đầu trang Agents ("N agent không đọc được").

Id phải khớp `/^[a-z0-9][a-z0-9-]{1,40}$/` (`src/agents/schema.ts:7`): chữ thường, số, dấu gạch ngang, dài 2 đến 41 ký tự.

Repo có sẵn năm agent mẫu:

| Id | Runtime | Vai |
|---|---|---|
| `main` | claude | Người điều phối: việc không chỉ định agent thì giao cho `main` |
| `demo` | mock | Chạy thử, không cần CLI hay khoá API |
| `coder` | codex | Viết và review code |
| `researcher` | grok | Nghiên cứu |
| `assistant` | hermes | Trợ lý hằng ngày (đang tắt: `enabled: false`) |

## 2.2 `agent.yaml` từng trường

Schema thật nằm ở `src/agents/schema.ts:26`. Nó dùng `z.strictObject`: **khoá lạ bị từ chối**, nên gõ sai `permision` sẽ báo lỗi thay vì bị bỏ qua lặng lẽ.

Ví dụ đầy đủ:

```yaml
name: Sale Công ty A
description: "Trả lời khách Zalo và Gmail của Công ty A"
runtime: claude                  # claude | codex | grok | hermes | mock
model: claude-haiku-4-5          # tuỳ chọn; để trống thì CLI tự chọn
runtime_options: {}              # xem 2.5
permission: safe                 # safe | full
context: lean                    # standard | lean
reports_to: main
can_delegate: false
max_concurrent: 2
budget_usd_month: 30
enabled: true
# workspace: ~/viec-rieng        # tuỳ chọn; mặc định workspaces/<id>
access:
  brain:
    cong-ty-a: { read: ["**"], write: [] }
  memory: { team: true, private: true }
  skills: [tra-loi-khach]
  connections: {}
  modules:
    care: [inbox.read, reply.draft]
```

| Trường | Kiểu | Mặc định | Ý nghĩa |
|---|---|---|---|
| `name` | chuỗi 1 đến 80 ký tự | bắt buộc | Tên hiển thị |
| `description` | chuỗi | `""` | Mô tả ngắn. **Nếu không có `persona.md`, nó đóng vai persona.** Cũng hiện trong danh sách đồng đội mà agent khác nhìn thấy |
| `runtime` | một trong `RUNTIME_IDS` | bắt buộc | CLI nào chạy agent này (`src/core/types.ts:3`) |
| `model` | chuỗi | không | Tên mô hình truyền cho CLI (`--model`, `-m`). Bỏ trống thì CLI dùng mặc định của nó |
| `runtime_options` | map chuỗi, số hoặc boolean | `{}` | Tuỳ chọn riêng cho từng runtime (2.5) |
| `permission` | `safe` hoặc `full` | `safe` | Mức quyền của CLI (2.4) |
| `context` | `standard` hoặc `lean` | `standard` | Cách dựng prompt (2.3) |
| `reports_to` | id agent | không | Agent báo cáo cho ai; dùng cho sơ đồ tổ chức |
| `can_delegate` | boolean | `false` | Có được giao việc cho agent khác bằng `<aios-task>` không (bài 5) |
| `max_concurrent` | số nguyên 1 đến 20 | `1` | Tối đa bao nhiêu lượt chạy cùng lúc của agent này |
| `budget_usd_month` | số từ 0 | không giới hạn | Ngân sách tháng; chạm mức này thì việc mới `failed` với nhóm lỗi `budget` |
| `enabled` | boolean | `true` | Tắt thì không nhận việc |
| `workspace` | đường dẫn | `workspaces/<id>` | Thư mục làm việc của CLI. Hỗ trợ `~`; đường dẫn tương đối tính từ thư mục gốc repo |
| `access` | map | toàn rỗng | Quyền của agent, **mặc định không có gì** (bài 3) |

Vài điều nên biết:

- `budget_usd_month` chỉ đếm các lượt có báo chi phí. Codex và Hermes không báo chi phí (`reportsCost: false`), nên với hai runtime này ngân sách tháng gần như không có tác dụng.
- `can_delegate` không chỉ cho phép. Nó còn quyết định hệ thống có **đưa danh sách đồng đội và cách dùng `<aios-task>` vào prompt** hay không (`src/shared/context.ts:76`, `88`).
- `max_concurrent` và `AIOS_MAX_PARALLEL` (toàn hệ thống) cùng áp dụng; con số nào chặt hơn thắng.

## 2.3 `persona.md` và `context`

`persona.md` là văn bản thường, đưa vào đầu system prompt. Giữ nó ngắn và cụ thể: vai trò, giọng điệu, những điều không được làm. Ví dụ `agents/demo/persona.md`:

```
Bạn là Agent demo. Bạn dùng runtime giả lập để người mới thử giao việc...

Hãy trả lời ngắn gọn bằng tiếng Việt và nêu rõ đây là phản hồi thử nghiệm.
```

Giới hạn độ dài persona khi dựng prompt: 8.000 ký tự (`standard`) hoặc 6.000 (`lean`), cắt bớt nếu dài hơn (`CONTEXT_LIMITS`, `src/shared/contracts.ts:134`).

Trường `context` là **giá trị mặc định** cho Task của agent này (`src/work/tasks.ts`: `contextProfile: input.contextProfile ?? agent.context`). Một Task cụ thể vẫn có thể đặt khác. Ví dụ module `care` luôn tạo Task `lean` bất kể agent khai gì.

| Chọn | Khi | Vì sao |
|---|---|---|
| `standard` | Agent làm việc thường: viết, nghiên cứu, điều phối, chat | Có đủ đồng đội, chỉ thị, bộ nhớ, brain, công cụ |
| `lean` | Agent trả lời khách hoặc xử lý dữ liệu không tin cậy | Không công cụ, một lượt, skill chép thẳng vào prompt, tốn ít token |

Con số đã đo ở bản gốc: một lượt trả lời Zalo giảm từ khoảng 21 đến 45 nghìn token (2 đến 3 lần gọi) xuống còn khoảng 7,8 nghìn token (1 lần gọi).

Bảng so sánh đầy đủ hai mức ở bài 1, mục 1.6.

## 2.4 `permission`: safe và full

| | `safe` (mặc định) | `full` |
|---|---|---|
| Ý nghĩa | CLI chạy trong chế độ giới hạn | CLI chạy không chặn thêm gì |
| Claude | `--restricted`, bỏ Bash, chỉ đọc ghi thư mục được cấp | `--dangerously-skip-permissions` (hoặc `acceptEdits` + danh sách cho phép nếu có MCP theo mẫu) |
| Codex | sandbox `read-only`; có quyền ghi thì `workspace-write` | `danger-full-access` |
| Grok | tắt shell, sandbox `strict` | `--always-approve`, không sandbox |
| Hermes | `hermes chat -t file,web,todo` (không có terminal) | ACP, có terminal |

Đừng dùng `full` chỉ vì tiện. Mức nào chặn cứng được, mức nào chỉ chặn mềm, nằm ở bài 3. Quy tắc thực dụng: agent nào đụng đến dữ liệu khách hoặc nhận nội dung từ bên ngoài thì để `safe` và `context: lean`.

## 2.5 `runtime_options`

Mỗi adapter đọc một vài khoá. Khoá không biết thì bị bỏ qua. Các khoá thật có trong mã:

| Khoá | Runtime | Ý nghĩa |
|---|---|---|
| `maxTurns` | claude, grok | Giới hạn số lượt (`--max-turns`). Lượt `lean` luôn ép bằng 1 |
| `reasoningEffort` | grok | Truyền vào `--reasoning-effort` |
| `mode` | hermes | `auto` (mặc định), `acp` hoặc `cli`. `auto`: agent `full` hoặc có MCP được cấp chạy ACP, còn lại chạy `cli` |
| `home` | hermes | Đặt `HERMES_HOME` riêng, để Hermes không nạp MCP cá nhân của bạn |
| `profile` | hermes | Tên profile Hermes |
| `delayMs` | mock | Độ trễ giữa các mẩu chữ, mặc định 30 ms |

Ví dụ một agent Hermes cô lập:

```yaml
runtime: hermes
runtime_options:
  home: /Users/ban/.aios/hermes-sales
  mode: cli
```

## 2.6 Tạo agent: ba cách

### Cách 1: giao diện

Vào **Agents** rồi bấm **Tạo agent**, điền id, tên, runtime và các trường còn lại. Hệ thống ghi `agents/<id>/agent.yaml` và `persona.md`, tạo luôn thư mục làm việc `workspaces/<id>`. Sau khi tạo, tab **Persona** và **Quyền** của trang agent cho phép sửa tiếp.

### Cách 2: API

API dùng **camelCase** (`runtimeOptions`, `canDelegate`, `maxConcurrent`, `budgetUsdMonth`), trong khi file YAML dùng snake_case. Hệ thống tự đổi qua lại (`agentToYamlObject`, `src/agents/schema.ts:137`).

```bash
curl -s -XPOST http://127.0.0.1:4380/api/agents \
  -H 'content-type: application/json' \
  -d '{
    "id": "tro-ly-thu",
    "name": "Trợ lý thử",
    "runtime": "mock",
    "description": "Agent thử",
    "context": "lean",
    "access": {
      "brain": { "cong-ty-a": { "read": ["**"], "write": [] } },
      "memory": { "team": true, "private": false },
      "skills": ["viet-bao-cao"],
      "connections": {},
      "modules": {}
    }
  }'
```

Kết quả là mã 201 và file `agents/tro-ly-thu/agent.yaml` (đã kiểm: hệ thống ghi đúng các trường trên, thêm `permission: safe`, `can_delegate: false`, `max_concurrent: 1`, `enabled: true` theo giá trị mặc định).

| Việc | Lệnh |
|---|---|
| Xem danh sách và lỗi nạp | `GET /api/agents` |
| Sửa (chỉ gửi trường cần đổi) | `PUT /api/agents/:id` |
| Nạp lại sau khi sửa file bằng tay | `POST /api/agents/reload` |
| Xem quyền thực tế sẽ áp dụng | `GET /api/agents/:id/access` |
| Lưu trữ | `DELETE /api/agents/:id` |

Lưu ý khi sửa bằng `PUT`: hệ thống gộp theo **khoá cấp một**. Gửi `access` nghĩa là thay cả khối `access`, không gộp từng thư mục bên trong. Muốn thêm một thư mục brain, hãy gửi lại toàn bộ `access.brain` gồm cả các thư mục cũ.

`DELETE` không xoá hẳn. Nó chuyển thư mục sang `agents/_archive/<id>-<năm tháng ngày giờ phút giây>` (`registry.ts:123`), nên khôi phục được bằng cách chuyển thư mục về `agents/<id>` (bỏ phần đuôi thời gian khỏi tên) rồi `reload`.

Hai kiểu lỗi hay gặp, cùng thông báo thật:

```bash
# id viết hoa
{"error":{"code":"bad_request","message":"Dữ liệu không hợp lệ: id: chỉ gồm chữ thường, số và dấu gạch ngang"}}
# id đã tồn tại
{"error":{"code":"conflict","message":"Agent \"tro-ly-thu\" đã tồn tại."}}
```

### Cách 3: viết tay

Tạo thư mục `agents/<id>/`, viết `agent.yaml` (và `persona.md`), rồi `POST /api/agents/reload` hoặc khởi động lại. Không có lệnh `aios agent new`; lệnh `npm run aios -- agents` chỉ **liệt kê**.

Khi file sai, bạn nhận thông báo tiếng Việt chỉ rõ trường lỗi. Ví dụ với file:

```yaml
name: Lỗi thử
runtime: claud
permision: safe
max_concurrent: 50
```

`POST /api/agents/reload` (hoặc trang Agents) báo:

```
agent.yaml của "loi-thu" không hợp lệ:
- runtime: giá trị phải là một trong: claude, codex, grok, hermes, mock
- max_concurrent: giá trị quá lớn
- agent.yaml: khoá không hợp lệ (permision). Kiểm tra lại chính tả.
```

### Agent mẫu của module

Module có thể kèm agent mẫu trong `modules/<id>/agents/<tên>/`. Khi Add module và chọn "cài agent mẫu", `installTemplate` (`registry.ts:131`) chép thư mục đó sang `agents/`. Nếu id đã tồn tại thì bỏ qua, không ghi đè. Ví dụ module `care` mang theo agent `cskh` (`context: lean`). Từ đó agent là của bạn, sửa thoải mái.

## 2.7 Từ file YAML đến lượt chạy

Để thấy các trường tác động thế nào:

```
agent.yaml ──parse──► AgentConfig ──┬─► dispatcher: enabled, max_concurrent
                                    ├─► engine: budget_usd_month, workspace, runtime, model
                                    ├─► access.resolve: permission, access.*
                                    ├─► context.build: persona, context, can_delegate
                                    └─► adapter: runtime_options, model
```

Một mẹo gỡ lỗi: mọi Run lưu `accessJson` và `skillsJson`, nên nhìn lại một lượt chạy cũ bạn biết chính xác agent đã có quyền gì và skill nào hôm đó.

## Bài tập

1. Tạo agent `thu-nghiem` (runtime `mock`, `context: lean`) bằng **API**. Mở file YAML sinh ra và so với agent `demo`. Trường nào do hệ thống tự thêm?
2. Cố ý viết sai một `agent.yaml` (đặt `permission: root`, thêm khoá `memmory`). Đọc thông báo lỗi; mỗi dòng nhắc đến trường nào? Sửa rồi `reload` để agent xuất hiện.
3. Tạo agent mock thứ hai tên `tro-ly-thu` rồi giao cho `demo`: `"Viết báo cáo #delegate:tro-ly-thu"`. Mở **Công việc**: có mấy Task? `source` của Task con là gì? Task con có `contextProfile` gì, và vì sao?
4. Đặt `enabled: false` cho `tro-ly-thu` (sửa file, `reload`) rồi giao việc lần nữa. Việc con có chạy không? Dòng "Chỉ thị bị từ chối" nằm ở đâu (gợi ý: bảng đội và `GET /api/audit?action=directive.rejected`)?
5. Lưu trữ agent `thu-nghiem` bằng `DELETE`. Tìm thư mục trong `agents/_archive/`. Khôi phục nó như thế nào?
